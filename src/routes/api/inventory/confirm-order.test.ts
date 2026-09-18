import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./confirm-order";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";
import { confirmOrderReservation } from "@/lib/inventory/orderReservation";

vi.mock("@/lib/auth/verifyCommercialInventoryCaller", () => ({
  verifyCommercialInventoryCaller: vi.fn(),
}));
vi.mock("@/lib/inventory/orderReservation", () => ({ confirmOrderReservation: vi.fn() }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/inventory/confirm-order", {
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.mocked(verifyCommercialInventoryCaller).mockReset();
  vi.mocked(confirmOrderReservation).mockReset();
});

describe("POST /api/inventory/confirm-order", () => {
  it("rejects an unauthorized caller with 401 before reading the body's business meaning", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue(null);
    const res = await post(request({ orderId: "ORD-1" }, { authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(confirmOrderReservation).not.toHaveBeenCalled();
  });

  it("rejects a request missing orderId with 400", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    const res = await post(request({}, { authorization: "Bearer good" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("missing_fields");
    expect(body.correlationId).toMatch(UUID_RE);
  });

  it("maps success to 200", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(confirmOrderReservation).mockResolvedValue({
      status: "success",
      alreadyApplied: false,
    });
    const res = await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }));
    expect(res.status).toBe(200);
    expect(confirmOrderReservation).toHaveBeenCalledWith("ORD-1", "u1", expect.any(String));
  });

  it("maps insufficient_stock to 409 — the one permanent, never-retry-as-is outcome", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(confirmOrderReservation).mockResolvedValue({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 20, available: 5 }],
    });
    const res = await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.shortfalls).toEqual([{ format: "500ml", requested: 20, available: 5 }]);
  });

  it("maps not_found to 404 and invalid_state to 422", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });

    vi.mocked(confirmOrderReservation).mockResolvedValue({
      status: "not_found",
      reason: "order_not_found",
    });
    expect(
      (await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }))).status,
    ).toBe(404);

    vi.mocked(confirmOrderReservation).mockResolvedValue({
      status: "invalid_state",
      reason: "not_pending",
      orderStatus: "fulfilled",
    });
    expect(
      (await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }))).status,
    ).toBe(422);
  });

  it("never leaks a raw exception — an unexpected throw becomes a stable 500 internal_error", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(confirmOrderReservation).mockRejectedValue(
      new Error("boom, contains a Firestore path secret/{id}"),
    );
    const res = await post(request({ orderId: "ORD-1" }, { authorization: "Bearer good" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
