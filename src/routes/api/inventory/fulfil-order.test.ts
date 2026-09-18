import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./fulfil-order";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";
import { fulfilOrderReservation } from "@/lib/inventory/orderReservation";

vi.mock("@/lib/auth/verifyCommercialInventoryCaller", () => ({
  verifyCommercialInventoryCaller: vi.fn(),
}));
vi.mock("@/lib/inventory/orderReservation", () => ({ fulfilOrderReservation: vi.fn() }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/inventory/fulfil-order", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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
  vi.mocked(verifyCommercialInventoryCaller).mockReset();
  vi.mocked(fulfilOrderReservation).mockReset();
});

describe("POST /api/inventory/fulfil-order", () => {
  it("rejects an unauthorized caller with 401", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue(null);
    const res = await post(request({ orderId: "ORD-1" }, { authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(fulfilOrderReservation).not.toHaveBeenCalled();
  });

  it("rejects a request missing orderId with 400", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    const res = await post(request({}, { authorization: "Bearer good" }));
    expect(res.status).toBe(400);
  });

  it("maps success to 200, invalid_state to 422, not_found to 404", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });

    vi.mocked(fulfilOrderReservation).mockResolvedValue({
      status: "success",
      alreadyApplied: false,
    });
    expect(
      (await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }))).status,
    ).toBe(200);

    vi.mocked(fulfilOrderReservation).mockResolvedValue({
      status: "invalid_state",
      reason: "not_confirmed",
      orderStatus: "pending",
    });
    expect(
      (await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }))).status,
    ).toBe(422);

    vi.mocked(fulfilOrderReservation).mockResolvedValue({
      status: "not_found",
      reason: "order_not_found",
    });
    expect(
      (await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }))).status,
    ).toBe(404);
  });
});
