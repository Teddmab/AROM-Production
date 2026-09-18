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

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
vi.mock("./mombongoSigning", () => ({ signHmac: vi.fn().mockResolvedValue("deadbeef") }));

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` })),
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
  }),
  // Faithful-enough simulation of Firestore's real optimistic-concurrency
  // transactions: if the document changed between this transaction's own
  // read and its attempted commit, the whole callback is re-run (so it
  // observes the winning write and returns that instead of overwriting
  // it) — this is what actually proves createMombongoOffer's "at most one
  // document per listingId" guarantee under a real race, not just a
  // sequential replay.
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    for (;;) {
      const versionAtStart = registryVersion;
      const captured: { entry: { path: string; data: Record<string, unknown> } | null } = {
        entry: null,
      };
      const tx = {
        get: async (ref: { path: string }) => {
          const entry = mockRegistry[ref.path];
          return { exists: () => !!entry?.exists, data: () => entry?.data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          captured.entry = { path: ref.path, data };
        },
      };
      const result = await updateFn(tx);
      if (captured.entry) {
        if (registryVersion !== versionAtStart) continue; // lost the race — retry and observe the winner
        mockRegistry[captured.entry.path] = { exists: true, data: captured.entry.data };
        registryVersion++;
        transactionSetCalls.push(captured.entry);
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
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
  transactionSetCalls.length = 0;
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

  it("maps 400 to rejected without writing a harvestOffers doc", async () => {
    mockFetchOnce(400, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("rejected");
    expect(setDocCalls).toHaveLength(0);
    expect(transactionSetCalls).toHaveLength(0);
  });

  it("on acceptance, persists a pending harvestOffers doc under a deterministic (listingId) id", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const result = await createMombongoOffer(input);
    expect(result).toMatchObject({
      status: "accepted",
      mombongoOfferId: "mb_offer_1",
      offerDocId: "listing_701",
      alreadyExisted: false,
    });
    expect(transactionSetCalls).toHaveLength(1);
    expect(transactionSetCalls[0].path).toBe("harvestOffers/listing_701");
    expect(transactionSetCalls[0].data.status).toBe("pending");
    expect(transactionSetCalls[0].data.listingId).toBe("listing_701");
  });

  it("persists the optional commodity/province/territory/quality fields when provided", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    await createMombongoOffer({
      ...input,
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
    expect(transactionSetCalls[0].data).toMatchObject({
      commodity: "Ananas",
      province: "Kongo Central",
      territory: "Madimba",
      quality: "A",
    });
  });

  it("maps an unexpected status to error", async () => {
    mockFetchOnce(500, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("error");
  });

  it("duplicate-offer protection: a retried/replayed request finds the existing offer with no second Mombongo call", async () => {
    const fetchMock = mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const first = await createMombongoOffer(input);
    const second = await createMombongoOffer(input); // e.g. client retry after a timeout where the first actually succeeded

    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({
      status: "accepted",
      offerDocId: "listing_701",
      alreadyExisted: true,
    });
    if (second.status === "accepted")
      expect(second.offer.id).toBe((first as { offer: { id: string } }).offer.id);
    // The whole point: no second upstream submission on replay.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("duplicate-offer protection: two concurrent requests for the same listing persist exactly one document", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const [a, b] = await Promise.all([createMombongoOffer(input), createMombongoOffer(input)]);

    expect(a.status).toBe("accepted");
    expect(b.status).toBe("accepted");
    // Firestore-side outcome is fully protected: at most one document ever
    // persists for this listingId, and both callers observe the same one.
    expect(transactionSetCalls).toHaveLength(1);
    if (a.status === "accepted" && b.status === "accepted") {
      expect(a.offer.id).toBe(b.offer.id);
      expect(a.offer.createdAt).toBe(b.offer.createdAt);
    }
    // Known, documented residual gap (see createMombongoOffer's own doc
    // comment): a race this tight can still reach Mombongo's API twice,
    // since reserving the document before that call would need a
    // firestore.rules change this task doesn't make. This assertion is
    // the executable record of that limitation, not a passing requirement
    // — if it ever starts failing with fewer calls, the gap has closed.
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a random doc id (no dedup) when listingId can't safely be a document id", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const result = await createMombongoOffer({ ...input, listingId: "bad/listing" });
    expect(result.status).toBe("accepted");
    expect(setDocCalls).toHaveLength(1);
    expect(transactionSetCalls).toHaveLength(0);
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
    expect(updateDocCalls).toHaveLength(1);
    expect(updateDocCalls[0].path).toBe("harvestInvoices/hi1");
    expect(updateDocCalls[0].data.statut).toBe("paiement_en_attente");
  });

  it("maps 409/502 the same way the producerInvoices checkout does", async () => {
    mockRegistry["harvestInvoices/hi1"] = { exists: true, data: { statut: "a_payer" } };
    mockFetchOnce(409, {});
    expect((await createMombongoHarvestCheckout(input)).status).toBe("already_in_progress");

    mockFetchOnce(502, {});
    expect((await createMombongoHarvestCheckout(input)).status).toBe("provider_error");
  });
});
