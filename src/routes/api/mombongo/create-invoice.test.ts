import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./create-invoice";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { createMombongoInvoice } from "@/lib/payments/mombongo";
import { createExternalInvoiceRequestFixture } from "@/lib/payments/mombongoContract";

vi.mock("@/lib/auth/verifyMombongoCaller", () => ({ verifyMombongoCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongo", () => ({ createMombongoInvoice: vi.fn() }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mombongo/create-invoice", {
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
  vi.mocked(verifyMombongoCaller).mockReset();
  vi.mocked(createMombongoInvoice).mockReset();
});

describe("POST /api/mombongo/create-invoice", () => {
  it("rejects an unauthorized caller with 401 before reading the body", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue(null);
    const res = await post(request({ producerInvoiceId: "inv1" }));
    expect(res.status).toBe(401);
    expect(createMombongoInvoice).not.toHaveBeenCalled();
  });

  it("rejects a request missing producerInvoiceId with 400", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    const res = await post(request({}));
    expect(res.status).toBe(400);
  });

  it("accepts a request shaped per the checked-in contract fixture and maps success to 200", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(createMombongoInvoice).mockResolvedValue({
      status: "accepted",
      mombongoInvoiceId: "mb1",
    });
    const res = await post(
      request({
        producerInvoiceId: createExternalInvoiceRequestFixture.externalInvoiceId,
        reference: createExternalInvoiceRequestFixture.reference,
        dueDate: createExternalInvoiceRequestFixture.dueDate,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("maps not_found/unsupported_currency/error to 404/501/502", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });

    vi.mocked(createMombongoInvoice).mockResolvedValue({
      status: "not_found",
      httpStatus: 404,
      message: "x",
    });
    expect((await post(request({ producerInvoiceId: "i" }))).status).toBe(404);

    vi.mocked(createMombongoInvoice).mockResolvedValue({
      status: "unsupported_currency",
      httpStatus: 501,
      message: "x",
    });
    expect((await post(request({ producerInvoiceId: "i" }))).status).toBe(501);

    vi.mocked(createMombongoInvoice).mockResolvedValue({
      status: "error",
      httpStatus: 503,
      message: "x",
    });
    expect((await post(request({ producerInvoiceId: "i" }))).status).toBe(502);
  });

  it("never leaks a raw exception — an unexpected throw becomes a stable 500", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(createMombongoInvoice).mockRejectedValue(new Error("boom with a secret inside"));
    const res = await post(request({ producerInvoiceId: "i" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
