import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./direct-sale";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";
import { createDirectSale } from "@/lib/inventory/directSale";

vi.mock("@/lib/auth/verifyCommercialInventoryCaller", () => ({
  verifyCommercialInventoryCaller: vi.fn(),
}));
vi.mock("@/lib/inventory/directSale", () => ({ createDirectSale: vi.fn() }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/inventory/direct-sale", {
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

const VALID_BODY = {
  saleId: "VTE-DS-abc123",
  format: "500 ml",
  quantity: 5,
  prixUnitaire: 5000,
  commerciale: "Alain",
};

beforeEach(() => {
  vi.mocked(verifyCommercialInventoryCaller).mockReset();
  vi.mocked(createDirectSale).mockReset();
});

describe("POST /api/inventory/direct-sale", () => {
  it("rejects an unauthorized caller with 401, never calling createDirectSale", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue(null);
    const res = await post(request(VALID_BODY, { authorization: "Bearer bad" }));
    expect(res.status).toBe(401);
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content-type with 400 before even checking auth", async () => {
    const res = await post(
      new Request("http://localhost/api/inventory/direct-sale", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect(res.status).toBe(400);
    expect(verifyCommercialInventoryCaller).not.toHaveBeenCalled();
  });

  it("rejects a request missing saleId/format/commerciale with 400", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    expect(
      (
        await post(
          request(
            { format: "500 ml", quantity: 5, prixUnitaire: 5000, commerciale: "Alain" },
            { authorization: "Bearer good" },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          request(
            { saleId: "VTE-DS-x", quantity: 5, prixUnitaire: 5000, commerciale: "Alain" },
            { authorization: "Bearer good" },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          request(
            { saleId: "VTE-DS-x", format: "500 ml", quantity: 5, prixUnitaire: 5000 },
            { authorization: "Bearer good" },
          ),
        )
      ).status,
    ).toBe(400);
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  it("passes malformed quantity/price through as NaN for the lib to reject, rather than silently defaulting", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(createDirectSale).mockResolvedValue({
      status: "invalid_items",
      reason: "invalid_quantity",
    });
    await post(
      request(
        {
          saleId: "VTE-DS-x",
          format: "500 ml",
          quantity: "5",
          prixUnitaire: 5000,
          commerciale: "Alain",
        },
        { authorization: "Bearer good" },
      ),
    );
    expect(createDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: NaN }),
      "u1",
      expect.any(String),
    );
  });

  it("maps every outcome to the right HTTP status", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });

    vi.mocked(createDirectSale).mockResolvedValue({
      status: "success",
      alreadyApplied: false,
      saleId: "VTE-DS-abc123",
    });
    expect((await post(request(VALID_BODY, { authorization: "Bearer good" }))).status).toBe(200);

    vi.mocked(createDirectSale).mockResolvedValue({ status: "invalid_sale_id" });
    expect((await post(request(VALID_BODY, { authorization: "Bearer good" }))).status).toBe(400);

    vi.mocked(createDirectSale).mockResolvedValue({
      status: "invalid_items",
      reason: "unknown_product",
    });
    expect((await post(request(VALID_BODY, { authorization: "Bearer good" }))).status).toBe(422);

    vi.mocked(createDirectSale).mockResolvedValue({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 5, available: 2 }],
    });
    expect((await post(request(VALID_BODY, { authorization: "Bearer good" }))).status).toBe(409);

    vi.mocked(createDirectSale).mockResolvedValue({ status: "error", reason: "internal_error" });
    expect((await post(request(VALID_BODY, { authorization: "Bearer good" }))).status).toBe(500);
  });

  it("an unexpected throw from createDirectSale is still reported as 500, never left unhandled", async () => {
    vi.mocked(verifyCommercialInventoryCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(createDirectSale).mockRejectedValue(new Error("boom"));
    const res = await post(request(VALID_BODY, { authorization: "Bearer good" }));
    expect(res.status).toBe(500);
  });
});
