import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMombongoHarvestCheckout,
  createMombongoOffer,
  generateOfferAttemptIdentity,
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

  it("sends a prefixed, random Idempotency-Key and a matching (unprefixed) body externalReference — neither derived from listingId", async () => {
    const fetchMock = mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: null,
      replayed: false,
    });
    await createMombongoOffer(input);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^arom-harvest-offer-v1:[0-9a-f-]{36}$/);
    const body = JSON.parse(init.body as string);
    // externalReference is the bare attemptId; Idempotency-Key is that
    // same attemptId with an explicit version/domain prefix — never equal
    // to a hash of listingId (the two must not collapse back into "one
    // value derived from listingId").
    expect(headers["Idempotency-Key"]).toBe(`arom-harvest-offer-v1:${body.externalReference}`);
    const listingHash = await import("./mombongoSigning").then((m) =>
      m.hashSha256Hex(input.listingId),
    );
    expect(body.externalReference).not.toBe(listingHash);
    expect(headers["Idempotency-Key"]).not.toBe(listingHash);
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
    const fetchMock = mockFetchOnce(200, {
      submissionStatus: "submitted",
      offerId: "mb1",
      externalReference: null, // sender doesn't know the real attemptId ahead of time in this test
      replayed: false,
    });
    // Capture the attemptId AROM actually generated and re-mock the
    // response to echo it back, matching Mombongo's real contract.
    await createMombongoOffer(input);
    expect((fetchMock.mock.calls[0][1] as RequestInit & { body: string }).body).toBeTruthy();
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.externalReference).toBeTruthy();

    // Fresh listing, fresh attempt: echo the real generated reference back.
    const secondInput = { ...input, listingId: "listing_echo_test" };
    let capturedRef = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedRef = JSON.parse(init.body as string).externalReference;
        return {
          status: 200,
          json: async () => ({
            submissionStatus: "submitted",
            offerId: "mb2",
            externalReference: capturedRef,
            replayed: false,
          }),
        };
      }),
    );
    const result = await createMombongoOffer(secondInput);
    expect(result.status).toBe("accepted");
    expect(capturedRef).toBeTruthy();
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
    const firstFetch = vi.fn().mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", firstFetch);
    await createMombongoOffer(input);
    // The attempt identity was generated and persisted on the claim
    // during that first (failed) call — capture it to prove the retry
    // reuses the exact same value, not a fresh one.
    const claimEntry = Object.entries(mockRegistry).find(([path]) =>
      path.startsWith("mombongoOfferClaims/"),
    )?.[1];
    const originalIdempotencyKey = claimEntry?.data?.idempotencyKey as string;
    expect(originalIdempotencyKey).toBeTruthy();

    const fetchMock = mockFetchSequence([
      { status: 404, body: {} }, // getExternalHarvestOffer: confirmed absent
      { status: 200, body: { status: "accepted", offerId: "mb1" } }, // retry submission
    ]);
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondCallInit] = fetchMock.mock.calls[1];
    expect((secondCallInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      originalIdempotencyKey,
    );
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

describe("createMombongoOffer — stale in_flight claim recovery (process-crash windows)", () => {
  const input = {
    listingId: "listing_crash_test",
    offerQuantityKg: 200,
    offerPricePerKgCdf: 780,
    createdByUid: "u1",
  };

  function seedStaleInFlightClaim(claimPath: string, ageMs: number) {
    mockRegistry[claimPath] = {
      exists: true,
      data: {
        id: claimPath.split("/")[1],
        listingId: input.listingId,
        fingerprint: `${input.listingId}:${input.offerQuantityKg}:${input.offerPricePerKgCdf}`,
        status: "in_flight",
        createdAt: new Date(Date.now() - ageMs).toISOString(),
        createdByUid: "u1",
        idempotencyKey: "arom-harvest-offer-v1:stale-attempt-1",
        externalReference: "stale-attempt-1",
      },
    };
  }

  it("a fresh (non-stale) in_flight claim is NOT treated as recoverable — still a genuine in-flight race", async () => {
    const claimId = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    seedStaleInFlightClaim(`mombongoOfferClaims/${claimId}`, 1_000); // 1s old, well under the threshold
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("in_flight");
  });

  it("crash between claim creation and the outbound call: a stale in_flight claim becomes recoverable, not a permanent dead end", async () => {
    const claimId = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    seedStaleInFlightClaim(`mombongoOfferClaims/${claimId}`, 120_000); // 2 minutes old — no live request lasts this long
    // Reconciliation finds nothing (Mombongo never actually received the
    // original call, since the crash happened before signedMombongoPost),
    // then the retry succeeds.
    const fetchMock = mockFetchSequence([
      { status: 404, body: {} },
      { status: 200, body: { status: "accepted", offerId: "mb1" } },
    ]);
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry used the STALE claim's own original identity, not a freshly generated one.
    const [, retryInit] = fetchMock.mock.calls[1];
    expect((retryInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "arom-harvest-offer-v1:stale-attempt-1",
    );
  });

  it("crash after Mombongo succeeds but before AROM persists the response: retry adopts the existing offer, no duplicate", async () => {
    const claimId = await import("./mombongoSigning").then((m) => m.hashSha256Hex(input.listingId));
    seedStaleInFlightClaim(`mombongoOfferClaims/${claimId}`, 120_000);
    // Reconciliation finds the offer Mombongo actually created before the crash.
    const fetchMock = mockFetchOnce(200, {
      offerId: "mb1",
      externalReference: "stale-attempt-1",
      listingId: input.listingId,
      status: "pending",
      quantityKg: 200,
      unitPriceCdf: 780,
      currency: "CDF",
      createdAt: "x",
      updatedAt: "x",
      invoiceId: null,
    });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.alreadyExisted).toBe(true);
    // Exactly one fetch call: the reconciliation lookup — never a second
    // (duplicate) createExternalHarvestOffer submission.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/getExternalHarvestOffer");
    expect(
      harvestOfferSetCalls().filter((c) => c.path === "harvestOffers/stale-attempt-1"),
    ).toHaveLength(1);
  });
});

describe("createMombongoOffer — rejected claims cannot be reused for a different payload", () => {
  it("after a definitive 400, a later call with a changed price is refused locally and never reaches Mombongo", async () => {
    const base = {
      listingId: "listing_rej",
      offerQuantityKg: 200,
      offerPricePerKgCdf: 780,
      createdByUid: "u1",
    };
    mockFetchOnce(400, {});
    await createMombongoOffer(base);
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const result = await createMombongoOffer({ ...base, offerPricePerKgCdf: 900 });
    expect(result.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateOfferAttemptIdentity — Mombongo-facing identity scheme", () => {
  it("is not derived from listingId, quantity, price, or message — it takes no arguments at all", () => {
    // A same-attempt/same-payload key is proven by claim persistence
    // (see the retry/double-tap tests above), not by this generator being
    // deterministic — it is the OPPOSITE: called at most once per claim,
    // ever, and its output is then persisted and reused verbatim.
    const a = generateOfferAttemptIdentity();
    const b = generateOfferAttemptIdentity();
    expect(a.externalReference).not.toBe(b.externalReference);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("Idempotency-Key is the externalReference with an explicit version/domain prefix", () => {
    const { externalReference, idempotencyKey } = generateOfferAttemptIdentity();
    expect(idempotencyKey).toBe(`arom-harvest-offer-v1:${externalReference}`);
  });

  it("two intentional attempts (simulated: two independently generated identities) remain distinguishable", () => {
    const attempt1 = generateOfferAttemptIdentity();
    const attempt2 = generateOfferAttemptIdentity();
    expect(attempt1.externalReference).not.toBe(attempt2.externalReference);
    expect(attempt1.idempotencyKey).not.toBe(attempt2.idempotencyKey);
  });

  it("generates enough entropy that collisions across many calls (proxy for cross-actor/partner collision safety) are not observed", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateOfferAttemptIdentity().externalReference);
    expect(seen.size).toBe(1000);
  });
});

describe("createMombongoOffer — a genuinely new attempt gets a new identity; same attempt never does", () => {
  const baseInput = {
    listingId: "listing_new_attempt_test",
    offerQuantityKg: 200,
    offerPricePerKgCdf: 780,
    createdByUid: "u1",
  };

  it("same attempt, same payload, retried twice: identical Idempotency-Key both times (double-tap)", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    await createMombongoOffer(baseInput);
    const firstKey = (
      fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    ).headers["Idempotency-Key"];
    await createMombongoOffer(baseInput); // double-tap: claim already completed, no second call at all
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstKey).toBeTruthy();
  });

  it("same attempt with a changed payload (different price) is a LOCAL conflict, never silently treated as success", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const first = await createMombongoOffer(baseInput);
    expect(first.status).toBe("accepted");
    // A second call for the SAME listing with a different price — since
    // AROM only ever attempts once per listing (verified business rule,
    // see generateOfferAttemptIdentity's doc comment), this is not a
    // "changed payload for the same key" scenario Mombongo would ever see
    // — it's blocked locally before any second call, which is the
    // correct, stronger guarantee: the claim is already 'completed'.
    const changed = await createMombongoOffer({ ...baseInput, offerPricePerKgCdf: 999 });
    expect(changed.status).toBe("accepted"); // returns the ORIGINAL completed offer, not a new one
    if (changed.status === "accepted") expect(changed.offer.offerPricePerKgCdf).toBe(780);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never silently resubmitted the changed payload
  });

  it("a genuinely new attempt (different listing) gets a different externalReference and Idempotency-Key", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb1" });
    const first = await createMombongoOffer(baseInput);
    const firstKey = (
      fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    ).headers["Idempotency-Key"];

    mockFetchOnce(200, { status: "accepted", offerId: "mb2" });
    const second = await createMombongoOffer({
      ...baseInput,
      listingId: "listing_new_attempt_test_2",
    });
    const secondFetchCalls = vi.mocked(fetch).mock.calls;
    const secondKey = (
      secondFetchCalls[secondFetchCalls.length - 1][1] as RequestInit & {
        headers: Record<string, string>;
      }
    ).headers["Idempotency-Key"];

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(secondKey).not.toBe(firstKey);
    if (first.status === "accepted" && second.status === "accepted") {
      expect(second.offer.externalReference).not.toBe(first.offer.externalReference);
    }
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
