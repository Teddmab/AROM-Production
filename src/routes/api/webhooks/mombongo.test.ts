import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTransaction } from "firebase/firestore/lite";
import { Route } from "./mombongo";
import { getMombongoConfig } from "@/lib/payments/mombongoConfig";
import { verifyHmac } from "@/lib/payments/mombongoSigning";
import {
  invoiceIssuedEventFixture,
  invoiceIssuedEventV2Fixture,
  offerStatusChangedEventFixture,
  paymentCompleteEventFixture,
} from "@/lib/payments/mombongoContract";

/**
 * Module-boundary mocks of firestore/lite and the config/signing seams —
 * same pattern as orderReservation.test.ts/qcReleaseReceipt.test.ts. This
 * webhook is the one surface Mombongo actually calls into AROM, so these
 * tests exist to pin down exactly the security/idempotency properties the
 * repo audit called out: fails closed on a bad signature, never
 * double-applies a delivery, never echoes a secret back.
 */

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
const setDocCalls: { path: string; data: Record<string, unknown> }[] = [];
const updateDocCalls: { path: string; data: Record<string, unknown> }[] = [];

function setDocs(next: Record<string, { exists: boolean; data?: Record<string, unknown> }>) {
  mockRegistry = next;
}

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));

vi.mock("@/lib/payments/mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
vi.mock("@/lib/payments/mombongoSigning", () => ({ verifyHmac: vi.fn() }));

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` })),
  collection: vi.fn((_db: unknown, col: string) => ({ col })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  limit: vi.fn((n: number) => ({ limit: n })),
  query: vi.fn(
    (colRef: { col: string }, ...clauses: { field: string; op: string; value: unknown }[]) => ({
      ...colRef,
      clauses,
    }),
  ),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.path.split("/")[1] };
  }),
  getDocs: vi.fn(
    async (q: { col: string; clauses: { field: string; value: unknown }[] } | undefined) => {
      if (!q) return { empty: true, size: 0, docs: [] };
      const docs = Object.entries(mockRegistry)
        .filter(
          ([path, entry]) =>
            path.startsWith(`${q.col}/`) &&
            entry.exists &&
            q.clauses.every((c) => entry.data?.[c.field] === c.value),
        )
        .map(([path, entry]) => ({ id: path.split("/")[1], data: () => entry.data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  ),
  setDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    setDocCalls.push({ path: ref.path, data });
    mockRegistry[ref.path] = { exists: true, data };
  }),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    updateDocCalls.push({ path: ref.path, data });
    const existing = mockRegistry[ref.path];
    mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
  }),
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: async (ref: { path: string }) => {
        const entry = mockRegistry[ref.path];
        return { exists: () => !!entry?.exists, data: () => entry?.data };
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        setDocCalls.push({ path: ref.path, data });
        mockRegistry[ref.path] = { exists: true, data };
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        updateDocCalls.push({ path: ref.path, data });
        const existing = mockRegistry[ref.path];
        mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
      },
    };
    return updateFn(tx);
  }),
}));

const FAKE_CONFIG = {
  baseUrl: "https://example.invalid",
  partnerId: "partner-1",
  inboundSigningSecret: "TOP_SECRET_INBOUND_DO_NOT_LEAK",
  outboundVerifySecret: "TOP_SECRET_OUTBOUND_DO_NOT_LEAK",
  active: true,
};

function request(rawBody: string, signature: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-mombongo-signature"] = signature;
  return new Request("http://localhost/api/webhooks/mombongo", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

async function post(req: Request) {
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return handlers.POST({ request: req });
}

beforeEach(() => {
  setDocs({});
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
  vi.mocked(getMombongoConfig).mockReset().mockResolvedValue(FAKE_CONFIG);
  vi.mocked(verifyHmac).mockReset();
});

describe("POST /api/webhooks/mombongo — signature verification", () => {
  it("rejects a missing signature header with 401 without touching Firestore", async () => {
    vi.mocked(verifyHmac).mockResolvedValue(false);
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), null));
    expect(res.status).toBe(401);
    expect(updateDocCalls).toHaveLength(0);
  });

  it("rejects an invalid signature with 401", async () => {
    vi.mocked(verifyHmac).mockResolvedValue(false);
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "deadbeef"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_signature");
  });

  it("never echoes a secret value back in any response", async () => {
    vi.mocked(verifyHmac).mockResolvedValue(false);
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "deadbeef"));
    const text = await res.text();
    expect(text).not.toContain(FAKE_CONFIG.inboundSigningSecret);
    expect(text).not.toContain(FAKE_CONFIG.outboundVerifySecret);
  });

  it("rejects malformed JSON with 400 even when the signature check passes", async () => {
    vi.mocked(verifyHmac).mockResolvedValue(true);
    const res = await post(request("{not json", "aabbcc"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/webhooks/mombongo — event: payment_complete", () => {
  beforeEach(() => vi.mocked(verifyHmac).mockResolvedValue(true));

  it("acknowledges without updating anything when no invoice matches", async () => {
    setDocs({});
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("acknowledged_no_match");
    expect(updateDocCalls).toHaveLength(0);
  });

  it("marks a matched producerInvoices doc paid on the first delivery", async () => {
    setDocs({
      [`producerInvoices/${paymentCompleteEventFixture.externalInvoiceId}`]: {
        exists: true,
        data: { statut: "paiement_en_attente" },
      },
    });
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(updateDocCalls).toHaveLength(1);
    expect(updateDocCalls[0].data.statut).toBe("payee");
  });

  it("is idempotent: a repeated delivery for an already-terminal invoice is a no-op", async () => {
    setDocs({
      [`producerInvoices/${paymentCompleteEventFixture.externalInvoiceId}`]: {
        exists: true,
        data: { statut: "payee" },
      },
    });
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("already_processed");
    expect(updateDocCalls).toHaveLength(0);
  });

  it("acknowledges an unhandled status without transitioning the invoice", async () => {
    setDocs({
      [`producerInvoices/${paymentCompleteEventFixture.externalInvoiceId}`]: {
        exists: true,
        data: { statut: "paiement_en_attente" },
      },
    });
    const res = await post(
      request(JSON.stringify({ ...paymentCompleteEventFixture, status: "refunded" }), "sig"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("acknowledged_unhandled_status");
    expect(updateDocCalls).toHaveLength(0);
  });

  it("rejects a payload missing required fields with 400", async () => {
    const res = await post(
      request(JSON.stringify({ event: "payment_complete", status: "paid" }), "sig"),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/webhooks/mombongo — event: invoice_issued", () => {
  beforeEach(() => vi.mocked(verifyHmac).mockResolvedValue(true));

  it("creates a harvestInvoices doc under Mombongo's own invoice id on first delivery", async () => {
    const res = await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0].path).toBe(`harvestInvoices/${invoiceIssuedEventFixture.invoiceId}`);
    expect(setDocCalls[0].data.statut).toBe("a_payer");
  });

  it("marks a single matching pending offer won", async () => {
    setDocs({
      "harvestOffers/offer_1": {
        exists: true,
        data: { listingId: invoiceIssuedEventFixture.listingId, status: "pending" },
      },
    });
    await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    expect(updateDocCalls).toContainEqual({
      path: "harvestOffers/offer_1",
      data: { status: "won" },
    });
  });

  it("zero matching pending offers: the invoice is still created, no offer is touched", async () => {
    const res = await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(setDocCalls).toHaveLength(1); // the harvestInvoices doc only
    expect(updateDocCalls).toHaveLength(0);
  });

  it("multiple matching pending offers: ambiguous, so the invoice is still valid but no offer is touched", async () => {
    setDocs({
      "harvestOffers/offer_1": {
        exists: true,
        data: { listingId: invoiceIssuedEventFixture.listingId, status: "pending" },
      },
      "harvestOffers/offer_2": {
        exists: true,
        data: { listingId: invoiceIssuedEventFixture.listingId, status: "pending" },
      },
    });
    const res = await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(setDocCalls).toHaveLength(1); // the harvestInvoices doc only
    expect(updateDocCalls).toHaveLength(0); // neither offer_1 nor offer_2 is guessed at
  });

  it("is idempotent under repeated delivery: a second delivery does not re-create or re-touch offers", async () => {
    await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    setDocCalls.length = 0;
    updateDocCalls.length = 0;

    const res = await post(request(JSON.stringify(invoiceIssuedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(setDocCalls).toHaveLength(0);
    expect(updateDocCalls).toHaveLength(0);
  });

  it("rejects a payload missing required fields with 400", async () => {
    const res = await post(
      request(JSON.stringify({ event: "invoice_issued", invoiceId: "x" }), "sig"),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/webhooks/mombongo — event: offer_status_changed (contract v2)", () => {
  beforeEach(() => vi.mocked(verifyHmac).mockResolvedValue(true));

  function seedPendingOffer() {
    setDocs({
      [`harvestOffers/${offerStatusChangedEventFixture.externalReference}`]: {
        exists: true,
        data: {
          id: offerStatusChangedEventFixture.externalReference,
          status: "pending",
          listingId: offerStatusChangedEventFixture.listingId,
          mombongoOfferId: offerStatusChangedEventFixture.offerId,
        },
      },
    });
  }

  it("valid accepted event applies pending -> accepted and durably records the inbox event first", async () => {
    seedPendingOffer();
    const res = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect(
      setDocCalls.some(
        (c) => c.path === `mombongoWebhookEvents/${offerStatusChangedEventFixture.eventId}`,
      ),
    ).toBe(true);
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("accepted");
  });

  it("valid declined event applies pending -> declined", async () => {
    seedPendingOffer();
    const declined = { ...offerStatusChangedEventFixture, status: "declined" as const };
    const res = await post(request(JSON.stringify(declined), "sig"));
    expect(res.status).toBe(200);
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("declined");
  });

  it("correlates exactly via externalReference/offerId, never listingId alone", async () => {
    setDocs({
      "harvestOffers/some-other-doc": {
        exists: true,
        data: {
          status: "pending",
          listingId: offerStatusChangedEventFixture.listingId,
          mombongoOfferId: "a-different-offer",
        },
      },
    });
    const res = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(res.status).toBe(503); // not_found — no exact correlation, tolerated as recoverable
    expect(mockRegistry["harvestOffers/some-other-doc"].data?.status).toBe("pending"); // untouched
  });

  it("tolerates arrival before the submission response is stored (no local offer exists yet) — recoverable, not a hard failure", async () => {
    const res = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("offer_not_found_yet");
  });

  it("webhook-before-submission is eventually linkable: not_found now, resolved once the offer exists and the event is redelivered", async () => {
    // First delivery: offer doesn't exist locally yet.
    const first = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(first.status).toBe(503);
    expect(
      mockRegistry[`mombongoWebhookEvents/${offerStatusChangedEventFixture.eventId}`].data
        ?.processingState,
    ).toBe("failed");

    // The offer now exists (createMombongoOffer completed in the meantime).
    seedPendingOffer();

    // Redelivery of the SAME event (Mombongo's own retry, or a manual
    // adminRetryPartnerNotification) resumes from 'failed' and succeeds.
    const second = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(second.status).toBe(200);
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("accepted");
    expect(
      mockRegistry[`mombongoWebhookEvents/${offerStatusChangedEventFixture.eventId}`].data
        ?.processingState,
    ).toBe("processed");
  });

  it("durable inbox record survives an offer-update failure: stays 'failed', never falsely acknowledged as processed", async () => {
    seedPendingOffer();
    let callCount = 0;
    const realImpl = vi.mocked(runTransaction).getMockImplementation()!;
    vi.mocked(runTransaction).mockImplementation(
      async (...args: Parameters<typeof runTransaction>) => {
        callCount++;
        // Call 1 = claimInboxEvent's durable create (must succeed). Call 2 =
        // applyMombongoOfferOutcome's own transaction (simulate it failing).
        if (callCount === 2)
          throw new Error("simulated Firestore failure applying the offer outcome");
        return realImpl(...args);
      },
    );

    const res = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("processing_failed");
    const inboxRecord =
      mockRegistry[`mombongoWebhookEvents/${offerStatusChangedEventFixture.eventId}`].data;
    expect(inboxRecord?.processingState).toBe("failed");
    // The offer itself was never touched — durably recorded intent, no partial effect.
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("pending");
  });

  it("duplicate event delivery (same eventId) is harmless — returns success without reapplying", async () => {
    seedPendingOffer();
    await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    updateDocCalls.length = 0;
    const res = await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("already_processed");
    expect(updateDocCalls).toHaveLength(0);
  });

  it("a stale event (older occurredAt than what's already stored) cannot overwrite newer terminal state", async () => {
    setDocs({
      [`harvestOffers/${offerStatusChangedEventFixture.externalReference}`]: {
        exists: true,
        data: {
          status: "accepted",
          listingId: offerStatusChangedEventFixture.listingId,
          mombongoOfferId: offerStatusChangedEventFixture.offerId,
          mombongoOccurredAt: "2026-09-20T00:00:00.000Z", // newer than the event below
        },
      },
    });
    const staleDeclined = {
      ...offerStatusChangedEventFixture,
      status: "declined" as const,
      eventId: "evt-stale-1",
    };
    const res = await post(request(JSON.stringify(staleDeclined), "sig"));
    expect(res.status).toBe(200);
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("accepted");
  });

  it("a genuine terminal conflict (accepted vs declined, same/newer occurredAt) is recorded, not overwritten", async () => {
    setDocs({
      [`harvestOffers/${offerStatusChangedEventFixture.externalReference}`]: {
        exists: true,
        data: {
          status: "accepted",
          listingId: offerStatusChangedEventFixture.listingId,
          mombongoOfferId: offerStatusChangedEventFixture.offerId,
          mombongoOccurredAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });
    const conflicting = {
      ...offerStatusChangedEventFixture,
      status: "declined" as const,
      eventId: "evt-conflict-1",
    };
    const res = await post(request(JSON.stringify(conflicting), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("acknowledged_conflict");
    expect(
      mockRegistry[`harvestOffers/${offerStatusChangedEventFixture.externalReference}`].data
        ?.status,
    ).toBe("accepted");
    expect(mockRegistry[`mombongoWebhookEvents/evt-conflict-1`].data?.processingState).toBe(
      "conflict",
    );
  });

  it("rejects an unsupported schemaVersion", async () => {
    seedPendingOffer();
    const res = await post(
      request(JSON.stringify({ ...offerStatusChangedEventFixture, schemaVersion: 99 }), "sig"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed/missing-field payload", async () => {
    const res = await post(
      request(JSON.stringify({ event: "offer_status_changed", eventId: "x" }), "sig"),
    );
    expect(res.status).toBe(400);
  });

  it("never persists a signature/secret field into the inbox record", async () => {
    seedPendingOffer();
    await post(request(JSON.stringify(offerStatusChangedEventFixture), "sig"));
    const inboxRecord = setDocCalls.find((c) => c.path.startsWith("mombongoWebhookEvents/"))?.data;
    expect(inboxRecord).not.toHaveProperty("signature");
    expect(inboxRecord).not.toHaveProperty("hmacSecret");
  });
});

describe("POST /api/webhooks/mombongo — event: invoice_issued v2 (contract v2, has eventId)", () => {
  beforeEach(() => vi.mocked(verifyHmac).mockResolvedValue(true));

  it("creates the harvestInvoices doc with v2 fields on first delivery", async () => {
    const res = await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    expect(res.status).toBe(200);
    const invoiceWrite = setDocCalls.find(
      (c) => c.path === `harvestInvoices/${invoiceIssuedEventV2Fixture.invoiceId}`,
    );
    expect(invoiceWrite?.data).toMatchObject({
      statut: "a_payer",
      eventId: invoiceIssuedEventV2Fixture.eventId,
      schemaVersion: 2,
      mombongoOfferId: invoiceIssuedEventV2Fixture.offerId,
      externalReference: invoiceIssuedEventV2Fixture.externalReference,
      unitPriceCdf: invoiceIssuedEventV2Fixture.unitPriceCdf,
      totalAmountCdf: invoiceIssuedEventV2Fixture.totalAmountCdf,
      currency: "CDF",
    });
  });

  it("exact correlation: applies accepted to the matching offer via offerId, not listingId alone", async () => {
    setDocs({
      [`harvestOffers/${invoiceIssuedEventV2Fixture.externalReference}`]: {
        exists: true,
        data: {
          status: "pending",
          listingId: invoiceIssuedEventV2Fixture.listingId,
          mombongoOfferId: invoiceIssuedEventV2Fixture.offerId,
          externalReference: invoiceIssuedEventV2Fixture.externalReference,
        },
      },
    });
    await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    expect(
      mockRegistry[`harvestOffers/${invoiceIssuedEventV2Fixture.externalReference}`].data?.status,
    ).toBe("accepted");
  });

  it("inconsistent correlation (offerId matches an offer whose own externalReference disagrees) is a recoverable conflict, nothing overwritten", async () => {
    setDocs({
      "harvestOffers/some-doc": {
        exists: true,
        data: {
          status: "pending",
          listingId: invoiceIssuedEventV2Fixture.listingId,
          mombongoOfferId: invoiceIssuedEventV2Fixture.offerId,
          externalReference: "a-totally-different-ref",
        },
      },
    });
    const res = await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("acknowledged_conflict");
    expect(mockRegistry["harvestOffers/some-doc"].data?.status).toBe("pending");
  });

  it("duplicate eventId is idempotent — no second invoice write", async () => {
    await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    setDocCalls.length = 0;
    const res = await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    expect(res.status).toBe(200);
    expect(setDocCalls).toHaveLength(0);
  });

  it("duplicate invoiceId under a different eventId is still idempotent (second independent invariant)", async () => {
    await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    setDocCalls.length = 0;
    const sameInvoiceDifferentEvent = {
      ...invoiceIssuedEventV2Fixture,
      eventId: "evt-a-different-eventid",
    };
    const res = await post(request(JSON.stringify(sameInvoiceDifferentEvent), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("already_processed");
    expect(setDocCalls.some((c) => c.path.startsWith("harvestInvoices/"))).toBe(false);
  });

  it("never creates stock and never marks anything paid", async () => {
    await post(request(JSON.stringify(invoiceIssuedEventV2Fixture), "sig"));
    expect(
      setDocCalls.some((c) => c.path.startsWith("stockPF/") || c.path.startsWith("stockBalance/")),
    ).toBe(false);
    const invoiceWrite = setDocCalls.find((c) => c.path.startsWith("harvestInvoices/"));
    expect(invoiceWrite?.data.statut).toBe("a_payer");
  });

  it("rejects an unsupported schemaVersion", async () => {
    const res = await post(
      request(JSON.stringify({ ...invoiceIssuedEventV2Fixture, schemaVersion: 99 }), "sig"),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/webhooks/mombongo — unknown event", () => {
  it("acknowledges an unknown/missing event without error", async () => {
    vi.mocked(verifyHmac).mockResolvedValue(true);
    const res = await post(request(JSON.stringify({ event: "something_else" }), "sig"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("acknowledged_unhandled_event");
  });
});

describe("POST /api/webhooks/mombongo — misconfiguration", () => {
  it("returns 500 not_provisioned if the integration config can't be loaded, before ever reading the body", async () => {
    vi.mocked(getMombongoConfig).mockRejectedValue(new Error("no config"));
    const res = await post(request(JSON.stringify(paymentCompleteEventFixture), "sig"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("not_provisioned");
  });
});
