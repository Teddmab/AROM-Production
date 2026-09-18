import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./create-offer";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { createMombongoOffer } from "@/lib/payments/mombongoHarvest";
import { createExternalHarvestOfferRequestFixture } from "@/lib/payments/mombongoContract";

vi.mock("@/lib/auth/verifyMombongoCaller", () => ({ verifyMombongoCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongoHarvest", () => ({ createMombongoOffer: vi.fn() }));

function request(body: unknown) {
  return new Request("http://localhost/api/mombongo/create-offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  vi.mocked(verifyMombongoCaller).mockReset();
  vi.mocked(createMombongoOffer).mockReset();
});

describe("POST /api/mombongo/create-offer", () => {
  it("rejects an unauthorized caller with 401", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue(null);
    expect((await post(request(createExternalHarvestOfferRequestFixture))).status).toBe(401);
  });

  it("rejects a request missing required fields with 400", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    expect((await post(request({ listingId: "l1" }))).status).toBe(400);
  });

  it("maps rejected to 400 and error to 502, passing caller uid through as createdByUid", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });

    vi.mocked(createMombongoOffer).mockResolvedValue({
      status: "rejected",
      httpStatus: 400,
      message: "x",
    });
    expect((await post(request(createExternalHarvestOfferRequestFixture))).status).toBe(400);

    vi.mocked(createMombongoOffer).mockResolvedValue({
      status: "accepted",
      offerDocId: "d1",
      mombongoOfferId: "mb1",
      alreadyExisted: false,
      offer: {
        id: "d1",
        listingId: "l1",
        mombongoOfferId: "mb1",
        offerQuantityKg: 1,
        offerPricePerKgCdf: 1,
        message: null,
        commodity: null,
        province: null,
        territory: null,
        quality: null,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByUid: "u1",
      },
    });
    await post(request(createExternalHarvestOfferRequestFixture));
    expect(createMombongoOffer).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUid: "u1" }),
    );
  });

  it("passes through the optional commodity/province/territory/quality display fields", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(createMombongoOffer).mockResolvedValue({
      status: "accepted",
      offerDocId: "d1",
      mombongoOfferId: "mb1",
      alreadyExisted: false,
      offer: {
        id: "d1",
        listingId: "l1",
        mombongoOfferId: "mb1",
        offerQuantityKg: 1,
        offerPricePerKgCdf: 1,
        message: null,
        commodity: "Ananas",
        province: "Kongo Central",
        territory: "Madimba",
        quality: "A",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdByUid: "u1",
      },
    });
    await post(
      request({
        ...createExternalHarvestOfferRequestFixture,
        commodity: "Ananas",
        province: "Kongo Central",
        territory: "Madimba",
        quality: "A",
      }),
    );
    expect(createMombongoOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        commodity: "Ananas",
        province: "Kongo Central",
        territory: "Madimba",
        quality: "A",
      }),
    );
  });
});
