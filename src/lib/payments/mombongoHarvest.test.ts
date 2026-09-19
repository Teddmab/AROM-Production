import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMombongoHarvestCheckout,
  createMombongoOffer,
  getMombongoHarvestOffer,
  getMombongoListings,
} from "./mombongoHarvest";
import { getMombongoConfig } from "./mombongoConfig";
import { harvestListingFixture } from "./mombongoContract";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
let registryVersion = 0;
const setDocCalls: { path: string; data: Record<string, unknown> }[] = [];
const updateDocCalls: { path: string; data: Record<string, unknown> }[] = [];
const transactionSetCalls: { path: string; data: Record<string, unknown> }[] = [];
const transactionUpdateCalls: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
// Real hashSha256Hex (importOriginal) so claim/offer doc ids are genuinely
// deterministic per listingId, matching production behavior — only
// signHmac is faked, since it needs no real secret in tests.
vi.mock("./mombongoSigning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mombongoSigning")>();
  return { ...actual, signHmac: vi.fn().mockResolvedValue("deadbeef") };
});

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data };
  }),
  getDocs: vi.fn(async (q: { collectionPath: string; wheres: [string, unknown][] }) => {
    const docs = Object.entries(mockRegistry)
      .filter(([path, v]) => v.exists && path.startsWith(`${q.collectionPath}/`))
      .filter(([, v]) => q.wheres.every(([field, value]) => v.data?.[field] === value))
      .map(([path, v]) => ({ id: path.split("/")[1], data: () => v.data! }));
    return { size: docs.length, empty: docs.length === 0, docs };
  }),
  collection: vi.fn((_db: unknown, path: string) => ({
    collectionPath: path,
    wheres: [] as [string, unknown][],
  })),
  query: vi.fn(
    (
      base: { collectionPath: string; wheres: [string, unknown][] },
      ...clauses: { field: string; value: unknown }[]
    ) => ({
      collectionPath: base.collectionPath,
      wheres: clauses
        .filter((c) => c && "field" in c)
        .map((c) => [c.field, c.value] as [string, unknown]),
    }),
  ),
  where: vi.fn((field: string, _op: string, value: unknown) => ({ field, value })),
  limit: vi.fn(() => ({})),
  setDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    setDocCalls.push({ path: ref.path, data });
    mockRegistry[ref.path] = { exists: true, data };
    registryVersion++;
  }),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    updateDocCalls.push({ path: ref.path, data });
    const existing = mockRegistry[ref.path];
    mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
  }),
  // Faithful-enough simulation of Firestore's real optimistic-concurrency
  // transactions, generalized for multiple set/update calls in one
  // transaction: if the registry changed between this transaction's own
  // reads and its attempted commit, the whole callback is re-run,
  // observing the winner's writes instead of overwriting them.
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    for (;;) {
      const versionAtStart = registryVersion;
      const writes: { kind: "set" | "update"; path: string; data: Record<string, unknown> }[] = [];
      const tx = {
        get: async (ref: { path: string }) => {
          const entry = mockRegistry[ref.path];
          return { exists: () => !!entry?.exists, data: () => entry?.data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push({ kind: "set", path: ref.path, data }),
        update: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push({ kind: "update", path: ref.path, data }),
      };
      const result = await updateFn(tx);
      if (writes.length > 0) {
        if (registryVersion !== versionAtStart) continue; // lost the race — retry, observe the winner
        for (const w of writes) {
          if (w.kind === "set") {
            mockRegistry[w.path] = { exists: true, data: w.data };
            transactionSetCalls.push({ path: w.path, data: w.data });
          } else {
            const existing = mockRegistry[w.path];
            mockRegistry[w.path] = { exists: true, data: { ...existing?.data, ...w.data } };
            transactionUpdateCalls.push({ path: w.path, data: w.data });
          }
        }
        registryVersion++;
      }
      return result;
    }
  }),
}));

const FAKE_CONFIG = {
  baseUrl: "https://example.invalid",
  partnerId: "partner-1",
  inboundSigningSecret: "TOP_SECRET_INBOUND",
  outboundVerifySecret: "TOP_SECRET_OUTBOUND",
  active: true,
};

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({ status, json: async () => body });
  vi.stubGlobal("fetch", fn);
  return fn;
}
function mockFetchSequence(responses: { status: number; body: unknown }[]) {
  const fn = vi.fn();
  for (const r of responses)
    fn.mockResolvedValueOnce({ status: r.status, json: async () => r.body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  mockRegistry = {};
  registryVersion = 0;
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
  transactionSetCalls.length = 0;
  transactionUpdateCalls.length = 0;
  vi.mocked(getMombongoConfig).mockReset().mockResolvedValue(FAKE_CONFIG);
});

/** transactionSetCalls now interleaves the claim-creation write with the offer-doc write — this isolates just the latter. */
function harvestOfferSetCalls() {
  return transactionSetCalls.filter((c) => c.path.startsWith("harvestOffers/"));
}

describe("getMombongoListings", () => {
  it("passes through a successful listings response", async () => {
    mockFetchOnce(200, { listings: [harvestListingFixture] });
    const result = await getMombongoListings({ commodity: "ananas" });
    expect(result).toEqual({ listings: [harvestListingFixture] });
  });

  it("maps a non-200 to a stable error, not a throw", async () => {
    mockFetchOnce(500, { message: "server error" });
    const result = await getMombongoListings({});
    expect("error" in result && result.httpStatus).toBe(500);
  });
});

describe("createMombongoOffer — submission v2", () => {
  const input = {
    listingId: "listing_701",
    offerQuantityKg: 200,
    offerPricePerKgCdf: 780,
    createdByUid: "u1",
  };

  it("sends the Idempotency-Key header and body externalReference, both stable and derived from listingId", async () => {
    const fetchMock = mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: null,
      replayed: false,
    });
    await createMombongoOffer(input);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(init.body as string);
    expect(body.externalReference).toBe(headers["Idempotency-Key"]);
    // Deterministic: same listingId always produces the same key.
    expect(headers["Idempotency-Key"]).toBe(
      await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId)),
    );
  });

  it("legacy response {status:'accepted', offerId} maps to business status pending, never farmer acceptance", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    expect(harvestOfferSetCalls()[0].data.status).toBe("pending");
  });

  it("v2 response {submissionStatus:'submitted', ...} also maps to business status pending", async () => {
    mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: null,
      replayed: false,
    });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    expect(harvestOfferSetCalls()[0].data.status).toBe("pending");
  });

  it("a v2 replayed:true response is surfaced as alreadyExisted:true", async () => {
    mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: null,
      replayed: true,
    });
    const result = await createMombongoOffer(input);
    if (result.status === "accepted") expect(result.alreadyExisted).toBe(true);
    else throw new Error("expected accepted");
  });

  it("a v2 externalReference that doesn't match what AROM sent fails closed as reference_mismatch, and does not link the offer", async () => {
    mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: "some-other-ref",
      replayed: false,
    });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("reference_mismatch");
    expect(harvestOfferSetCalls()).toHaveLength(0);
  });

  it("a matching v2 externalReference proceeds normally", async () => {
    const key = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: key,
      replayed: false,
    });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
  });

  it("400 maps to rejected and marks the claim rejected, no offer doc written", async () => {
    mockFetchOnce(400, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("rejected");
    expect(harvestOfferSetCalls()).toHaveLength(0);
    expect(
      updateDocCalls.some(
        (c) => c.path.startsWith("mombongoOfferClaims/") && c.data.status === "rejected",
      ),
    ).toBe(true);
  });

  it("401 maps to a distinct error, not a business rejection", async () => {
    mockFetchOnce(401, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.httpStatus).toBe(401);
  });

  it("409 (Idempotency-Key/fingerprint conflict) maps to conflict", async () => {
    mockFetchOnce(409, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("conflict");
  });

  it("429 maps to unknown, not a permanent rejection", async () => {
    mockFetchOnce(429, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("unknown");
  });

  it("5xx maps to unknown", async () => {
    mockFetchOnce(503, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("unknown");
  });

  it("persists optional commodity/province/territory/quality fields", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    await createMombongoOffer({
      ...input,
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
    expect(harvestOfferSetCalls()[0].data).toMatchObject({
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
  });

  it("double-tap / retry after a completed submission finds the existing offer with no second Mombongo call", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const first = await createMombongoOffer(input);
    const second = await createMombongoOffer(input);
    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({ status: "accepted", alreadyExisted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("two concurrent requests for the same listing persist exactly one harvestOffers document", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const [a, b] = await Promise.all([createMombongoOffer(input), createMombongoOffer(input)]);
    // Exactly one caller wins the claim and proceeds to call Mombongo /
    // persist the offer; the other observes the claim already in flight
    // (or completed) and never reaches a second harvestOffers write.
    expect(transactionSetCalls.filter((c) => c.path.startsWith("harvestOffers/"))).toHaveLength(1);
    const accepted = [a, b].filter((r) => r.status === "accepted");
    expect(accepted.length).toBeGreaterThanOrEqual(1);
  });

  it("ambiguous timeout: a prior 'unknown' claim triggers reconciliation by externalReference before any retry", async () => {
    // First attempt: network throw -> claim marked unknown.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));
    const first = await createMombongoOffer(input);
    expect(first.status).toBe("unknown");

    // Second attempt: reconciliation (getExternalHarvestOffer) finds the
    // offer Mombongo actually created during the ambiguous window.
    const key = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    const fetchMock = mockFetchOnce(200, {
      offerId: "mb1",
      externalReference: key,
      listingId: input.listingId,
      status: "pending",
      quantityKg: 200,
      unitPriceCdf: 780,
      currency: "CDF",
      createdAt: "x",
      updatedAt: "x",
      invoiceId: null,
    });
    const second = await createMombongoOffer(input);
    expect(second.status).toBe("accepted");
    if (second.status === "accepted") expect(second.mombongoOfferId).toBe("mb1");
    // Reconciliation call, not a resubmission — never hits createExternalHarvestOffer again.
    expect(fetchMock.mock.calls[0][0]).toContain("/getExternalHarvestOffer");
  });

  it("ambiguous timeout: reconciliation confirms absence (404) then retries the ORIGINAL submission using the same Idempotency-Key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));
    await createMombongoOffer(input);

    const fetchMock = mockFetchSequence([
      { status: 404, body: {} }, // getExternalHarvestOffer: confirmed absent
      { status: 200, body: { status: "accepted", offerId: "mb1" } }, // retry submission
    ]);
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondCallInit] = fetchMock.mock.calls[1];
    const key = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    expect((secondCallInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(key);
  });

  it("ambiguous timeout: reconciliation lookup itself failing again leaves the claim recoverable, never deletes local state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));
    await createMombongoOffer(input);
    mockFetchOnce(500, {}); // getExternalHarvestOffer itself fails
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("unknown");
    // No harvestOffers doc was ever created — nothing to delete either.
    expect(Object.keys(mockRegistry).some((k) => k.startsWith("harvestOffers/"))).toBe(false);
  });

  it("a definitively rejected prior attempt stays rejected on a later call, never auto-retried", async () => {
    mockFetchOnce(400, {});
    await createMombongoOffer(input);
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getMombongoHarvestOffer (reconciliation single lookup)", () => {
  it("200 maps to found:true", async () => {
    mockFetchOnce(200, { offerId: "mb1", externalReference: "r1", status: "pending" });
    const result = await getMombongoHarvestOffer({ externalReference: "r1" });
    expect(result.found).toBe(true);
  });
  it("404 maps to found:false, notFound:true (absence and isolation are deliberately indistinguishable)", async () => {
    mockFetchOnce(404, {});
    const result = await getMombongoHarvestOffer({ externalReference: "r1" });
    expect(result).toMatchObject({ found: false, notFound: true });
  });
  it("a 5xx maps to found:false, notFound:false (couldn't determine, not a confirmed absence)", async () => {
    mockFetchOnce(500, {});
    const result = await getMombongoHarvestOffer({ externalReference: "r1" });
    expect(result).toMatchObject({ found: false, notFound: false });
  });
});

describe("createMombongoHarvestCheckout — payment boundary (contract v2, fail closed)", () => {
  it("always denies checkout for a Mombongo harvest invoice, regardless of input, without ever calling Mombongo", async () => {
    const fetchMock = mockFetchOnce(200, { status: "checkout_created", providerRef: "pr1" });
    const result = await createMombongoHarvestCheckout({ harvestInvoiceId: "hi1", method: "card" });
    expect(result.status).toBe("reception_approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setDocCalls).toHaveLength(0);
    expect(updateDocCalls).toHaveLength(0);
  });

  it("a client-supplied approval-like field cannot bypass the denial (none is even read)", async () => {
    const result = await createMombongoHarvestCheckout({
      harvestInvoiceId: "hi1",
      method: "card",
      // @ts-expect-error — deliberately probing an unsupported field a forged client could send
      approved: true,
    });
    expect(result.status).toBe("reception_approval_required");
  });
});
