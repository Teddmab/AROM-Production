import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./listings";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { getMombongoListings } from "@/lib/payments/mombongoHarvest";
import { getExternalPublishedListingsResponseFixture } from "@/lib/payments/mombongoContract";

vi.mock("@/lib/auth/verifyMombongoCaller", () => ({ verifyMombongoCaller: vi.fn() }));
vi.mock("@/lib/payments/mombongoHarvest", () => ({ getMombongoListings: vi.fn() }));

function request(body: unknown = {}) {
  return new Request("http://localhost/api/mombongo/listings", {
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
  vi.mocked(getMombongoListings).mockReset();
});

describe("POST /api/mombongo/listings", () => {
  it("rejects an unauthorized caller with 401", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue(null);
    expect((await post(request())).status).toBe(401);
  });

  it("returns the contract-shaped listings response on success", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(getMombongoListings).mockResolvedValue(getExternalPublishedListingsResponseFixture);
    const res = await post(request({ commodity: "ananas" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(getExternalPublishedListingsResponseFixture);
  });

  it("maps an upstream error (Mombongo's current live 500/503) to 502, not a throw", async () => {
    vi.mocked(verifyMombongoCaller).mockResolvedValue({ uid: "u1" });
    vi.mocked(getMombongoListings).mockResolvedValue({
      error: "Mombongo returned 503",
      httpStatus: 503,
    });
    const res = await post(request());
    expect(res.status).toBe(502);
  });
});
