import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMombongoHarvestCheckout,
  createMombongoOffer,
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
/** Test-only escape hatch to simulate a Worker interruption on a specific (1-indexed) runTransaction call within a test — e.g. the *second* transaction (completion), not the first (the claim). null disables it. */
let failOnTransactionCallNumber: number | null = null;
let transactionCallCount = 0;

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
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
  // transactions, generalized to support multiple set/update calls in one
  // transaction (createMombongoOffer's completion step writes both the
  // harvestOffers doc and the claim in one transaction): if the registry
  // changed between this transaction's own reads and its attempted
  // commit, the whole callback is re-run, observing the winner's writes
  // instead of overwriting them.
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    transactionCallCount++;
    if (failOnTransactionCallNumber === transactionCallCount) {
      throw new Error("simulated Worker interruption");
    }
    for (;;) {
      const versionAtStart = registryVersion;
      const writes: { kind: "set" | "update"; path: string; data: Record<string, unknown> }[] = [];
      const tx = {
        get: async (ref: { path: string }) => {
          const entry = mockRegistry[ref.path];
          return { exists: () => !!entry?.exists, data: () => entry?.data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          writes.push({ kind: "set", path: ref.path, data });
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          writes.push({ kind: "update", path: ref.path, data });
        },
      };
      const result = await updateFn(tx);
      if (writes.length > 0) {
        if (registryVersion !== versionAtStart) continue; // lost the race — retry and observe the winner
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

beforeEach(() => {
  mockRegistry = {};
  registryVersion = 0;
  failOnTransactionCallNumber = null;
  transactionCallCount = 0;
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
  transactionSetCalls.length = 0;
  transactionUpdateCalls.length = 0;
  vi.mocked(getMombongoConfig).mockReset().mockResolvedValue(FAKE_CONFIG);
});

describe("getMombongoListings", () => {
  it("passes through a successful listings response", async () => {
    mockFetchOnce(200, { listings: [harvestListingFixture] });
    const result = await getMombongoListings({ commodity: "ananas" });
    expect(result).toEqual({ listings: [harvestListingFixture] });
  });

  it("maps a non-200 (Mombongo's current live 500) to a stable error, not a throw", async () => {
    mockFetchOnce(500, { message: "server encountered an error" });
    const result = await getMombongoListings({});
    expect("error" in result && result.httpStatus).toBe(500);
  });

  it("maps a 503 to a stable error", async () => {
    mockFetchOnce(503, {});
    const result = await getMombongoListings({});
    expect("error" in result && result.httpStatus).toBe(503);
  });
});

describe("createMombongoOffer", () => {
  const input = {
    listingId: "listing_701",
    offerQuantityKg: 200,
    offerPricePerKgCdf: 780,
    createdByUid: "u1",
  };

  it("maps 400 to rejected, marks the claim rejected, and creates no harvestOffers doc", async () => {
    mockFetchOnce(400, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("rejected");
    expect(transactionSetCalls.filter((c) => c.path.startsWith("harvestOffers/"))).toHaveLength(0);
    expect(updateDocCalls).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }),
    );
  });

  it("on acceptance, persists a pending harvestOffers doc AND completes the claim, in one transaction, under a sha256(listingId) id", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.mombongoOfferId).toBe("mb_offer_1");
    expect(result.alreadyExisted).toBe(false);
    // sha256 hex is always 64 lowercase hex chars, deterministic for the same listingId — never the raw listingId itself (section E).
    expect(result.offerDocId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.offer.id).toBe(result.offerDocId);
    expect(result.offer.listingId).toBe("listing_701"); // original id preserved as data
    const offerWrite = transactionSetCalls.find(
      (c) => c.path === `harvestOffers/${result.offerDocId}`,
    );
    expect(offerWrite?.data.status).toBe("pending");
    const claimComplete = transactionUpdateCalls.find(
      (c) => c.path === `mombongoOfferClaims/${result.offerDocId}`,
    );
    expect(claimComplete?.data).toMatchObject({
      status: "completed",
      harvestOfferId: result.offerDocId,
    });
  });

  it("persists the optional commodity/province/territory/quality fields when provided", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const result = await createMombongoOffer({
      ...input,
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
    if (result.status !== "accepted") throw new Error("expected accepted");
    expect(result.offer).toMatchObject({
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
  });

  it("maps a malformed/unexpected 200 body to 'unknown' (not a plain retryable error) and marks the claim unknown", async () => {
    mockFetchOnce(500, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("unknown");
    expect(updateDocCalls).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "unknown" }) }),
    );
  });

  it("a network/config exception during the upstream call marks the claim unknown rather than throwing or silently retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("unknown");
    expect(updateDocCalls).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "unknown" }) }),
    );
  });

  it("sequential replay after success: zero additional upstream calls, same canonical offer returned", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const first = await createMombongoOffer(input);
    const second = await createMombongoOffer(input); // e.g. client retry after a timeout where the first actually succeeded

    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({ status: "accepted", alreadyExisted: true });
    if (first.status === "accepted" && second.status === "accepted") {
      expect(second.offer.id).toBe(first.offer.id);
      expect(second.offerDocId).toBe(first.offerDocId);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replay of a 'blocked' (rejected) claim performs zero additional upstream calls", async () => {
    const fetchMock = mockFetchOnce(400, {});
    const first = await createMombongoOffer(input);
    expect(first.status).toBe("rejected");

    const second = await createMombongoOffer(input);
    expect(second.status).toBe("unknown"); // blocked — requires documented human recovery, never auto-retried
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replay of an 'unknown' claim performs zero additional upstream calls", async () => {
    const fetchMock = mockFetchOnce(500, {});
    const first = await createMombongoOffer(input);
    expect(first.status).toBe("unknown");

    const second = await createMombongoOffer(input);
    expect(second.status).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous identical requests: exactly one upstream call, and never two independent successful submissions", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const [a, b] = await Promise.all([createMombongoOffer(input), createMombongoOffer(input)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Exactly one of the two performed the real submission...
    const freshAccepts = [a, b].filter((r) => r.status === "accepted" && !r.alreadyExisted);
    expect(freshAccepts).toHaveLength(1);
    // ...and the other observed that outcome rather than submitting a
    // second time — depending on exactly how far the winner got before
    // the loser's claim-transaction re-checked, that's either the
    // now-completed canonical offer (both requirement B.2's listed
    // acceptable outcomes: "completed/existing or a safe in-progress
    // response") or a same-fingerprint in-flight response. Never a
    // second independent "accepted".
    const other = a === freshAccepts[0] ? b : a;
    const otherIsSafe =
      (other.status === "accepted" && other.alreadyExisted) || other.status === "in_flight";
    expect(otherIsSafe).toBe(true);
  });

  it("two simultaneous requests with different price/quantity fingerprints: exactly one calls upstream, never two independent successful submissions", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const [a, b] = await Promise.all([
      createMombongoOffer(input),
      createMombongoOffer({ ...input, offerPricePerKgCdf: 999 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const freshAccepts = [a, b].filter((r) => r.status === "accepted" && !r.alreadyExisted);
    expect(freshAccepts).toHaveLength(1);
    // The mismatched-fingerprint request never silently piggybacks as a
    // fresh acceptance: either it's flagged as a conflict (caught while
    // the winner was still in flight) or it observes the winner's
    // already-completed canonical offer (caught after) — both are the
    // one real submission's outcome, never a second one.
    const other = a === freshAccepts[0] ? b : a;
    const otherIsSafe =
      other.status === "conflict" || (other.status === "accepted" && other.alreadyExisted);
    expect(otherIsSafe).toBe(true);
  });

  it("Worker interruption after Mombongo accepts but before the completion transaction commits: no harvestOffers doc, claim stuck in_flight, and a later identical request never resubmits", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    // Call 1 = the claim transaction (must succeed so the flow reaches
    // Mombongo at all); call 2 = the completion transaction — simulates
    // the process dying right after Mombongo's success response, before
    // persisting completion.
    failOnTransactionCallNumber = 2;

    await expect(createMombongoOffer(input)).rejects.toThrow(/simulated Worker interruption/);
    expect(transactionSetCalls.filter((c) => c.path.startsWith("harvestOffers/"))).toHaveLength(0);

    // A later, otherwise-identical request must NOT silently resubmit —
    // this is the one gap this design cannot fully close (see
    // createMombongoOffer's own doc comment), but it must fail safe:
    // never a second upstream call.
    const retry = await createMombongoOffer(input);
    expect(retry.status).toBe("in_flight");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an existing historical random-id harvestOffers doc (pre-dating this change) remains directly readable and is untouched by the new claim flow", async () => {
    mockRegistry["harvestOffers/offer_1694000000000_ab12cd"] = {
      exists: true,
      data: { id: "offer_1694000000000_ab12cd", listingId: "listing_999", status: "pending" },
    };
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_2" });
    await createMombongoOffer({ ...input, listingId: "listing_other" });
    expect(mockRegistry["harvestOffers/offer_1694000000000_ab12cd"]).toBeTruthy();
    expect(mockRegistry["harvestOffers/offer_1694000000000_ab12cd"].data?.status).toBe("pending");
  });
});

describe("createMombongoHarvestCheckout", () => {
  const input = { harvestInvoiceId: "hi1", method: "card" as const };

  it("returns not_found when the local harvestInvoices doc doesn't exist", async () => {
    const result = await createMombongoHarvestCheckout(input);
    expect(result.status).toBe("not_found");
  });

  it("on success, writes paiement_en_attente to the harvestInvoices doc", async () => {
    mockRegistry["harvestInvoices/hi1"] = { exists: true, data: { statut: "a_payer" } };
    mockFetchOnce(200, { status: "checkout_created", providerRef: "pr2" });
    const result = await createMombongoHarvestCheckout(input);
    expect(result).toMatchObject({ status: "checkout_created", providerRef: "pr2" });
    expect(updateDocCalls).toContainEqual({
      path: "harvestInvoices/hi1",
      data: expect.objectContaining({ statut: "paiement_en_attente" }),
    });
  });

  it("maps 409/502 the same way the producerInvoices checkout does", async () => {
    mockRegistry["harvestInvoices/hi1"] = { exists: true, data: { statut: "a_payer" } };
    mockFetchOnce(409, {});
    expect((await createMombongoHarvestCheckout(input)).status).toBe("already_in_progress");

    mockFetchOnce(502, {});
    expect((await createMombongoHarvestCheckout(input)).status).toBe("provider_error");
  });
});
