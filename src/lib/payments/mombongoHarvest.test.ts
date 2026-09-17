import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMombongoHarvestCheckout,
  createMombongoOffer,
  getMombongoListings,
} from "./mombongoHarvest";
import { getMombongoConfig } from "./mombongoConfig";
import { harvestListingFixture } from "./mombongoContract";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
const setDocCalls: { path: string; data: Record<string, unknown> }[] = [];
const updateDocCalls: { path: string; data: Record<string, unknown> }[] = [];

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
  }),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    updateDocCalls.push({ path: ref.path, data });
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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      json: async () => body,
    }),
  );
}

beforeEach(() => {
  mockRegistry = {};
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
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
  });

  it("on acceptance, writes a pending harvestOffers doc", async () => {
    mockFetchOnce(200, { status: "accepted", offerId: "mb_offer_1" });
    const result = await createMombongoOffer(input);
    expect(result).toMatchObject({ status: "accepted", mombongoOfferId: "mb_offer_1" });
    expect(setDocCalls).toHaveLength(1);
    expect(setDocCalls[0].data.status).toBe("pending");
    expect(setDocCalls[0].data.listingId).toBe("listing_701");
  });

  it("maps an unexpected status to error", async () => {
    mockFetchOnce(500, {});
    const result = await createMombongoOffer(input);
    expect(result.status).toBe("error");
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
