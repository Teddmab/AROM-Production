import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./mombongo";
import { getMombongoConfig } from "@/lib/payments/mombongoConfig";
import { verifyHmac } from "@/lib/payments/mombongoSigning";
import {
  invoiceIssuedEventFixture,
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
