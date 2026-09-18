import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./qc-release";
import { verifyInventoryServiceCaller } from "@/lib/auth/verifyInventoryServiceCaller";
import { applyQcReleaseReceipt } from "@/lib/inventory/qcReleaseReceipt";

vi.mock("@/lib/auth/verifyInventoryServiceCaller", () => ({
  verifyInventoryServiceCaller: vi.fn(),
}));
vi.mock("@/lib/inventory/qcReleaseReceipt", () => ({ applyQcReleaseReceipt: vi.fn() }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/inventory/qc-release", {
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
  vi.mocked(verifyInventoryServiceCaller).mockReset();
  vi.mocked(applyQcReleaseReceipt).mockReset();
});

describe("POST /api/inventory/qc-release", () => {
  it("rejects an unauthenticated/unauthorized caller with 401 before ever reading the body", async () => {
    vi.mocked(verifyInventoryServiceCaller).mockResolvedValue(null);

    const res = await post(request({ qualityControlId: "QC-1" }, { authorization: "Bearer bad" }));

    expect(res.status).toBe(401);
    expect(applyQcReleaseReceipt).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.reason).toBe("unauthorized");
    expect(body.correlationId).toMatch(UUID_RE);
  });

  it("rejects a request missing qualityControlId with 400", async () => {
    vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({ uid: "u1", role: "admin" });

    const res = await post(request({}, { authorization: "Bearer good" }));

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("missing_fields");
    expect(applyQcReleaseReceipt).not.toHaveBeenCalled();
  });

  it.each([[123], [null], [{ nested: true }], [""], ["   "]])(
    "rejects a non-empty-string qualityControlId (%j) with 400, never reaching applyQcReleaseReceipt",
    async (qualityControlId) => {
      vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({ uid: "u1", role: "admin" });

      const res = await post(request({ qualityControlId }, { authorization: "Bearer good" }));

      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("missing_fields");
      expect(applyQcReleaseReceipt).not.toHaveBeenCalled();
    },
  );

  it("trims surrounding whitespace off a valid qualityControlId before calling through", async () => {
    vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(applyQcReleaseReceipt).mockResolvedValue({
      status: "success",
      formatsApplied: [],
      formatsAlreadyApplied: [],
    });

    await post(request({ qualityControlId: "  QC-1  " }, { authorization: "Bearer good" }));

    expect(applyQcReleaseReceipt).toHaveBeenCalledWith(
      "QC-1",
      "u1",
      expect.stringMatching(UUID_RE),
    );
  });

  it("rejects a request whose content-type is not application/json, before touching auth or the body", async () => {
    const res = await post(request({ qualityControlId: "QC-1" }, { "content-type": "text/plain" }));

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid_content_type");
    expect(verifyInventoryServiceCaller).not.toHaveBeenCalled();
    expect(applyQcReleaseReceipt).not.toHaveBeenCalled();
  });

  it("rejects a request whose declared Content-Length exceeds the small fixed cap, before touching auth or the body", async () => {
    const res = await post(request({ qualityControlId: "QC-1" }, { "content-length": "999999" }));

    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("payload_too_large");
    expect(verifyInventoryServiceCaller).not.toHaveBeenCalled();
    expect(applyQcReleaseReceipt).not.toHaveBeenCalled();
  });

  it("passes the verified caller's own uid as the actor and a per-request correlation id, and returns 200 with it echoed back on success", async () => {
    vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({
      uid: "staff-42",
      role: "staff",
      poste: "Directeur de Production",
    });
    vi.mocked(applyQcReleaseReceipt).mockResolvedValue({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });

    const res = await post(request({ qualityControlId: "QC-1" }, { authorization: "Bearer good" }));

    expect(applyQcReleaseReceipt).toHaveBeenCalledWith(
      "QC-1",
      "staff-42",
      expect.stringMatching(UUID_RE),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    expect(body.correlationId).toMatch(UUID_RE);
  });

  it.each([
    ["not_found", 404],
    ["invalid_state", 422],
    ["conflict", 409],
    ["error", 500],
  ] as const)(
    "maps status %s to HTTP %i, and never returns a raw error message or Firestore payload",
    async (status, httpStatus) => {
      vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({ uid: "u1", role: "admin" });
      vi.mocked(applyQcReleaseReceipt).mockResolvedValue({
        status,
        reason: "some_stable_code",
      } as never);

      const res = await post(
        request({ qualityControlId: "QC-1" }, { authorization: "Bearer good" }),
      );

      expect(res.status).toBe(httpStatus);
      const body = await res.json();
      expect(body.correlationId).toMatch(UUID_RE);
      expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack-trace-shaped text anywhere
    },
  );

  it("returns 500 without throwing, and without leaking the exception's message, when applyQcReleaseReceipt itself throws", async () => {
    vi.mocked(verifyInventoryServiceCaller).mockResolvedValue({ uid: "u1", role: "admin" });
    vi.mocked(applyQcReleaseReceipt).mockRejectedValue(
      new Error("some internal Firestore detail nobody outside should see"),
    );

    const res = await post(request({ qualityControlId: "QC-1" }, { authorization: "Bearer good" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      status: "error",
      reason: "internal_error",
      correlationId: body.correlationId,
    });
    expect(JSON.stringify(body)).not.toContain("Firestore detail");
  });
});
