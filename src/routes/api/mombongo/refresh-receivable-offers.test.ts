import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./refresh-receivable-offers";
import { authorizeOfferRefreshCaller } from "@/lib/auth/authorizeOfferRefreshCaller";
import { runOfferRefresh } from "@/lib/payments/mombongoOfferRefresh";

vi.mock("@/lib/auth/authorizeOfferRefreshCaller", () => ({ authorizeOfferRefreshCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongoOfferRefresh", () => ({ runOfferRefresh: vi.fn() }));

const OK = { ok: true as const, uid: "u1", role: "agent_de_collecte" as const };
const SUMMARY = {
  status: "complete" as const,
  examined: 4,
  refreshed: 2,
  unchanged: 1,
  skipped: 1,
  shouldReread: true,
};

function post(init?: RequestInit) {
  const request = new Request(
    "http://localhost/api/mombongo/refresh-receivable-offers?status=declined&partnerId=evil",
    {
      method: "POST",
      headers: { authorization: "Bearer t" },
      ...init,
    },
  );
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return { request, run: () => handlers.POST({ request }) };
}

beforeEach(() => {
  vi.mocked(authorizeOfferRefreshCaller).mockReset();
  vi.mocked(runOfferRefresh).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/mombongo/refresh-receivable-offers", () => {
  it("401 for an unauthenticated caller and never reaches Mombongo", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue({ ok: false, status: 401 });
    const res = await post().run();
    expect(res.status).toBe(401);
    expect(runOfferRefresh).not.toHaveBeenCalled();
  });

  it("403 for a signed-in but unrelated account and never reaches Mombongo", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue({ ok: false, status: 403 });
    const res = await post().run();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(runOfferRefresh).not.toHaveBeenCalled();
  });

  it("passes the Authorization header — and only that — to the authorizer", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockResolvedValue(SUMMARY);
    await post().run();
    expect(authorizeOfferRefreshCaller).toHaveBeenCalledWith("Bearer t");
  });

  it("returns the safe operational summary with 200 for complete and partial", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockResolvedValue(SUMMARY);
    const res = await post().run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);

    vi.mocked(runOfferRefresh).mockResolvedValue({ ...SUMMARY, status: "partial" });
    expect((await post().run()).status).toBe(200);
  });

  it("429 with retryAfterMs when throttled, 502 when Mombongo is unavailable", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockResolvedValue({ status: "throttled", retryAfterMs: 12_000 });
    const throttled = await post().run();
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ status: "throttled", retryAfterMs: 12_000 });

    vi.mocked(runOfferRefresh).mockResolvedValue({
      ...SUMMARY,
      status: "unavailable",
      refreshed: 0,
      shouldReread: false,
    });
    expect((await post().run()).status).toBe(502);
  });

  it("never reads the body or the query: no input can choose pagination, status, role, partner, project or environment", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockResolvedValue(SUMMARY);
    const { request, run } = post({
      body: JSON.stringify({
        role: "admin",
        partnerId: "other",
        status: "declined",
        limit: 100000,
        cursor: "x",
        projectId: "prod",
        baseUrl: "https://evil",
      }),
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
        "x-partner-id": "other",
      },
    });
    const json = vi.spyOn(request, "json");
    const text = vi.spyOn(request, "text");
    const form = vi.spyOn(request, "formData");
    await run();
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(form).not.toHaveBeenCalled();
    expect(runOfferRefresh).toHaveBeenCalledWith();
  });

  it("response carries no credentials, signatures, payloads or thumbnail URLs — only the six summary fields", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockResolvedValue(SUMMARY);
    const body = await (await post().run()).json();
    expect(Object.keys(body).sort()).toEqual([
      "examined",
      "refreshed",
      "shouldReread",
      "skipped",
      "status",
      "unchanged",
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /secret|signature|partner|authorization|storage\.googleapis|thumbnail|token/i,
    );
  });

  it("an internal failure is a generic 500 that leaks nothing and asks for no cache clearing", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockResolvedValue(OK);
    vi.mocked(runOfferRefresh).mockRejectedValue(
      new Error("secret https://storage.googleapis.com/x?X-Goog-Signature=abc"),
    );
    const res = await post().run();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /googleapis|Signature|secret/,
    );
  });

  it("an authorization infrastructure failure is 503 (never a silent allow)", async () => {
    vi.mocked(authorizeOfferRefreshCaller).mockRejectedValue(new Error("firestore down"));
    const res = await post().run();
    expect(res.status).toBe(503);
    expect(runOfferRefresh).not.toHaveBeenCalled();
  });
});
