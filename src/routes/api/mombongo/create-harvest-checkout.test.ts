import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./create-harvest-checkout";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { createMombongoHarvestCheckout } from "@/lib/payments/mombongoHarvest";

vi.mock("@/lib/auth/verifyMombongoCaller", () => ({ verifyMombongoCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongoHarvest", () => ({ createMombongoHarvestCheckout: vi.fn() }));

function request(body: unknown) {
  return new Request("http://localhost/api/mombongo/create-harvest-checkout", {
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
  vi.mocked(createMombongoHarvestCheckout).mockReset();
});

describe("POST /api/mombongo/create-harvest-checkout", () => {
  it("rejects an unauthorized caller with 401", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue(null);
    expect((await post(request({ harvestInvoiceId: "hi1", method: "card" }))).status).toBe(401);
  });

  it("rejects mobile_money without phone/operator with 400", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    const res = await post(request({ harvestInvoiceId: "hi1", method: "mobile_money" }));
    expect(res.status).toBe(400);
  });

  it("maps not_found/success to 404/200", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });

    vi.mocked(createMombongoHarvestCheckout).mockResolvedValue({
      status: "not_found",
      httpStatus: 404,
      message: "x",
    });
    expect((await post(request({ harvestInvoiceId: "hi1", method: "card" }))).status).toBe(404);

    vi.mocked(createMombongoHarvestCheckout).mockResolvedValue({
      status: "checkout_created",
      providerRef: "pr1",
    });
    expect((await post(request({ harvestInvoiceId: "hi1", method: "card" }))).status).toBe(200);
  });

  it("maps reception_approval_required (payment boundary, contract v2) to 403", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(createMombongoHarvestCheckout).mockResolvedValue({
      status: "reception_approval_required",
      httpStatus: 403,
      message: "x",
    });
    expect((await post(request({ harvestInvoiceId: "hi1", method: "card" }))).status).toBe(403);
  });
});
