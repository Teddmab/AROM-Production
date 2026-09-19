import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./reconcile-offers";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { reconcileMombongoOffers } from "@/lib/payments/mombongoReconciliation";

vi.mock("@/lib/auth/verifyMombongoCaller", () => ({ verifyMombongoCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongoReconciliation", () => ({ reconcileMombongoOffers: vi.fn() }));

function request() {
  return new Request("http://localhost/api/mombongo/reconcile-offers", { method: "POST" });
}

async function post(req: Request) {
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return handlers.POST({ request: req });
}

// The route's in-process throttle is module-level state (see its own doc
// comment — no persisted, cross-instance store exists without a Backend
// Rules change). Fake timers advanced well past the throttle window
// between tests keep each test's call from being incidentally throttled
// by the previous one's real-time proximity, without weakening the
// throttle logic itself.
let now = Date.now();
beforeEach(() => {
  vi.mocked(verifyMombongoCaller).mockReset();
  vi.mocked(reconcileMombongoOffers).mockReset();
  now += 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/mombongo/reconcile-offers", () => {
  it("rejects an unauthorized caller with 401 — mobile can trigger this, but never reaches Mombongo directly", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue(null);
    expect((await post(request())).status).toBe(401);
    expect(reconcileMombongoOffers).not.toHaveBeenCalled();
  });

  it("returns the summary with 200 on success, no credentials in the body", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(reconcileMombongoOffers).mockResolvedValue({
      pagesProcessed: 1,
      offersExamined: 2,
      applied: 1,
      alreadyApplied: 1,
      conflicts: 0,
      notFoundLocally: 0,
    });
    const res = await post(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("partnerId");
    expect(body).not.toHaveProperty("secret");
  });

  it("throttles a second call arriving within the minimum interval", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(reconcileMombongoOffers).mockResolvedValue({
      pagesProcessed: 0,
      offersExamined: 0,
      applied: 0,
      alreadyApplied: 0,
      conflicts: 0,
      notFoundLocally: 0,
    });
    expect((await post(request())).status).toBe(200);
    now += 1_000; // still inside the throttle window
    vi.spyOn(Date, "now").mockReturnValue(now);
    const res = await post(request());
    expect(res.status).toBe(429);
    expect(reconcileMombongoOffers).toHaveBeenCalledTimes(1);
  });

  it("maps a reconciliation error to 502", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(reconcileMombongoOffers).mockResolvedValue({
      pagesProcessed: 0,
      offersExamined: 0,
      applied: 0,
      alreadyApplied: 0,
      conflicts: 0,
      notFoundLocally: 0,
      error: "Mombongo returned 500",
    });
    expect((await post(request())).status).toBe(502);
  });
});
