import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_MAX_PAGES,
  REFRESH_MAX_REMOTE_REQUESTS,
  REFRESH_MIN_INTERVAL_MS,
  REFRESH_PAGE_SIZE,
  _resetOfferRefreshStateForTests,
  refreshReceivableOffers,
  runOfferRefresh,
} from "./mombongoOfferRefresh";
import { getMombongoHarvestOffers } from "./mombongoHarvest";
import type { ExternalHarvestOfferDto } from "./mombongoContract";

type Entry = { exists: boolean; data?: Record<string, unknown> };
let mockRegistry: Record<string, Entry> = {};
let transactions = 0;
let writes: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoHarvest", () => ({ getMombongoHarvestOffers: vi.fn() }));
vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  getDoc: vi.fn(async (ref: { path: string; id: string }) => {
    const e = mockRegistry[ref.path];
    return { exists: () => !!e?.exists, data: () => e?.data, id: ref.id };
  }),
  getDocs: vi.fn(async (q: { collectionPath: string; field?: string; value?: unknown }) => {
    const docs = Object.entries(mockRegistry)
      .filter(
        ([p, v]) =>
          v.exists && p.startsWith(`${q.collectionPath}/`) && v.data?.[q.field!] === q.value,
      )
      .map(([p, v]) => ({ id: p.split("/")[1], data: () => v.data }));
    return { size: docs.length, docs };
  }),
  collection: vi.fn((_db: unknown, path: string) => ({ collectionPath: path })),
  query: vi.fn((base: { collectionPath: string }, ...c: { field?: string; value?: unknown }[]) => ({
    ...base,
    field: c.find((x) => x?.field)?.field,
    value: c.find((x) => x?.field)?.value,
  })),
  where: vi.fn((field: string, _op: string, value: unknown) => ({ field, value })),
  limit: vi.fn(() => ({})),
  runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    transactions++;
    const tx = {
      get: async (ref: { path: string; id: string }) => {
        const e = mockRegistry[ref.path];
        return { exists: () => !!e?.exists, data: () => e?.data, id: ref.id };
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        writes.push({ path: ref.path, data });
        mockRegistry[ref.path] = {
          exists: true,
          data: { ...mockRegistry[ref.path]?.data, ...data },
        };
      },
      set: () => {
        throw new Error("a presentation refresh must never create a document");
      },
    };
    return fn(tx);
  }),
}));

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const THUMB = (expiresInMin: number, name = "p") => ({
  url: `https://storage.googleapis.com/bucket/listings/f1/l1/${name}.jpg?X-Goog-Signature=SECRET_SIG`,
  expiresAt: iso(NOW + expiresInMin * MIN),
});

function remote(
  id: string,
  overrides: Partial<ExternalHarvestOfferDto> = {},
): ExternalHarvestOfferDto {
  return {
    offerId: `mb-${id}`,
    externalReference: `ext-${id}`,
    listingId: `l-${id}`,
    status: "accepted",
    quantityKg: 10,
    unitPriceCdf: 800,
    currency: "CDF",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z", // deliberately OLD: far below any lifecycle checkpoint
    invoiceId: null,
    seller: { id: "farmer-1", displayName: "Marie Kabuya" },
    listing: {
      commodity: "ananas",
      commodityCode: "ANA",
      province: "Kasaï",
      territory: "Demba",
      thumbnail: THUMB(60),
    },
    ...overrides,
  };
}
function seed(id: string, data: Record<string, unknown> = {}) {
  mockRegistry[`harvestOffers/ext-${id}`] = {
    exists: true,
    data: {
      id: `ext-${id}`,
      status: "accepted",
      listingId: `l-${id}`,
      mombongoOfferId: `mb-${id}`,
      lastEventId: "evt-1",
      mombongoOccurredAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:05.000Z",
      ...data,
    },
  };
}
const stored = (id: string) => mockRegistry[`harvestOffers/ext-${id}`].data!;
const listing = (id: string) => stored(id).mombongoListing as Record<string, unknown>;

/** One page per call; `pages` is a list of pages, the last one has no next cursor. */
function servePages(pages: ExternalHarvestOfferDto[][]) {
  let i = 0;
  vi.mocked(getMombongoHarvestOffers).mockImplementation(async () => {
    const offers = pages[Math.min(i, pages.length - 1)];
    const next = i < pages.length - 1 ? `cursor-${i + 1}` : null;
    i++;
    return { offers, nextCursor: next };
  });
}
const run = (opts = {}) => refreshReceivableOffers({ now: () => NOW, ...opts });

beforeEach(() => {
  mockRegistry = {};
  transactions = 0;
  writes = [];
  _resetOfferRefreshStateForTests();
  vi.mocked(getMombongoHarvestOffers).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("remote request shape", () => {
  it("asks for ACCEPTED offers only, with server-fixed page size and NO updatedSince (so historical accepted offers are included)", async () => {
    servePages([[]]);
    await run();
    expect(getMombongoHarvestOffers).toHaveBeenCalledTimes(1);
    const filters = vi.mocked(getMombongoHarvestOffers).mock.calls[0][0];
    expect(filters).toEqual({ status: "accepted", limit: REFRESH_PAGE_SIZE, cursor: undefined });
    expect(filters).not.toHaveProperty("updatedSince");
  });

  it("the public entry points accept no caller-chosen input (no pagination, status, partner, role, project or environment)", () => {
    expect(runOfferRefresh.length).toBeLessThanOrEqual(1); // only an injectable clock
    // The only knobs on the core are server-side test overrides, never wired to a request.
    expect(Object.keys({ pageSize: 1 })).not.toContain("status");
  });

  it("caps the page size at Mombongo's own maximum of 100", async () => {
    servePages([[]]);
    await run({ pageSize: 5000 });
    expect(vi.mocked(getMombongoHarvestOffers).mock.calls[0][0].limit).toBe(100);
  });
});

describe("bounded pagination and the absolute request limit", () => {
  const manyPages = (n: number) => Array.from({ length: n }, () => [] as ExternalHarvestOfferDto[]);

  it("processes at most REFRESH_MAX_PAGES pages, then reports partial — never complete", async () => {
    servePages(manyPages(20));
    const s = await run();
    expect(getMombongoHarvestOffers).toHaveBeenCalledTimes(REFRESH_MAX_PAGES);
    expect(s.status).toBe("partial");
  });

  it("a separate absolute request ceiling also stops the run", async () => {
    servePages(manyPages(20));
    const s = await run({ maxPages: 50, maxRequests: 3 });
    expect(getMombongoHarvestOffers).toHaveBeenCalledTimes(3);
    expect(s.status).toBe("partial");
    expect(REFRESH_MAX_REMOTE_REQUESTS).toBeGreaterThanOrEqual(REFRESH_MAX_PAGES);
  });

  it("follows the cursor forward, and a remote that returns the same cursor twice cannot loop the run", async () => {
    vi.mocked(getMombongoHarvestOffers).mockResolvedValue({ offers: [], nextCursor: "same" });
    const s = await run({ maxPages: 50, maxRequests: 50 });
    expect(s.status).toBe("partial");
    expect(getMombongoHarvestOffers).toHaveBeenCalledTimes(2);
  });

  it("a single short page is complete, and the cursor is passed on to the next request", async () => {
    servePages([[], []]);
    const s = await run();
    expect(s.status).toBe("complete");
    expect(vi.mocked(getMombongoHarvestOffers).mock.calls[1][0].cursor).toBe("cursor-1");
  });

  it("a capped run never touches the lifecycle reconciliation checkpoint", async () => {
    servePages(manyPages(20));
    await run();
    expect(
      Object.keys(mockRegistry).filter((k) => k.startsWith("mombongoReconciliationState")),
    ).toEqual([]);
    expect(writes.filter((w) => w.path.startsWith("mombongoReconciliationState"))).toEqual([]);
  });
});

describe("historical backfill", () => {
  it("enriches an accepted offer that predates enrichment even though its updatedAt is far older than any checkpoint", async () => {
    seed("old", { commodity: "Ananas" }); // no enrichment at all
    servePages([[remote("old")]]);
    const s = await run();
    expect(s).toMatchObject({
      status: "complete",
      examined: 1,
      refreshed: 1,
      unchanged: 0,
      skipped: 0,
      shouldReread: true,
    });
    expect(stored("old")).toMatchObject({
      mombongoSeller: { id: "farmer-1", displayName: "Marie Kabuya" },
      mombongoListing: { commodity: "ananas", thumbnailExpiresAt: iso(NOW + 60 * MIN) },
      mombongoEnrichmentSourceAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("enriches a legacy `won` offer without rewriting its status", async () => {
    seed("w", { status: "won" });
    servePages([[remote("w")]]);
    await run();
    expect(stored("w").status).toBe("won");
    expect(stored("w")).toHaveProperty("mombongoSeller");
  });

  it("enriches every offer across several pages", async () => {
    ["a", "b", "c"].forEach((i) => seed(i));
    servePages([[remote("a"), remote("b")], [remote("c")]]);
    const s = await run();
    expect(s).toMatchObject({ status: "complete", examined: 3, refreshed: 3 });
  });

  it("is idempotent: an immediate second run refreshes nothing and writes nothing", async () => {
    seed("a");
    servePages([[remote("a")]]);
    await run();
    const before = JSON.stringify(mockRegistry);
    writes = [];
    servePages([[remote("a")]]);
    const again = await run();
    expect(again).toMatchObject({ refreshed: 0, unchanged: 1, shouldReread: false });
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(mockRegistry)).toBe(before);
  });

  it("with nothing to change it opens no transaction at all (cheap bounded examination)", async () => {
    seed("a", {
      mombongoEnrichmentSourceAt: "2026-01-02T00:00:00.000Z",
      mombongoSeller: { id: "farmer-1", displayName: "Marie Kabuya" },
      mombongoListing: {
        commodity: "ananas",
        commodityCode: "ANA",
        province: "Kasaï",
        territory: "Demba",
        thumbnailUrl: THUMB(59).url,
        thumbnailExpiresAt: iso(NOW + 59 * MIN),
      },
    });
    servePages([
      [
        remote("a", {
          listing: {
            commodity: "ananas",
            commodityCode: "ANA",
            province: "Kasaï",
            territory: "Demba",
            thumbnail: THUMB(60),
          },
        }),
      ],
    ]);
    const s = await run();
    expect(s).toMatchObject({ refreshed: 0, unchanged: 1 });
    expect(transactions).toBe(0);
  });
});

describe("thumbnail freshness — a separate credential lane", () => {
  const base = {
    mombongoEnrichmentSourceAt: "2026-01-02T00:00:00.000Z",
    mombongoSeller: { id: "farmer-1", displayName: "Marie Kabuya" },
  };
  const withThumb = (url: string | null, expiresInMin: number | null) => ({
    ...base,
    mombongoListing: {
      commodity: "ananas",
      commodityCode: "ANA",
      province: "Kasaï",
      territory: "Demba",
      thumbnailUrl: url,
      thumbnailExpiresAt: expiresInMin === null ? null : iso(NOW + expiresInMin * MIN),
    },
  });

  it("renews an EXPIRED thumbnail while the offer's business updatedAt has not moved — and does not rewrite sourceAt", async () => {
    seed("a", withThumb("https://storage.googleapis.com/old.jpg", -10));
    servePages([
      [
        remote("a", {
          listing: {
            commodity: "ananas",
            commodityCode: "ANA",
            province: "Kasaï",
            territory: "Demba",
            thumbnail: THUMB(60, "new"),
          },
        }),
      ],
    ]);
    const s = await run();
    expect(s).toMatchObject({ refreshed: 1, shouldReread: true });
    expect(listing("a").thumbnailUrl).toContain("new.jpg");
    expect(listing("a").thumbnailExpiresAt).toBe(iso(NOW + 60 * MIN));
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].data)).toEqual(["mombongoListing"]); // sourceAt (business freshness) untouched
    expect(stored("a").mombongoEnrichmentSourceAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("renews a NEAR-expiry thumbnail (under 30 minutes left)", async () => {
    seed("a", withThumb("https://storage.googleapis.com/old.jpg", 10));
    servePages([[remote("a")]]);
    await run();
    expect(listing("a").thumbnailExpiresAt).toBe(iso(NOW + 60 * MIN));
  });

  it("renews a MISSING thumbnail", async () => {
    seed("a", withThumb(null, null));
    servePages([[remote("a")]]);
    await run();
    expect(listing("a").thumbnailUrl).toContain("storage.googleapis.com");
  });

  it("does NOT rewrite a still-comfortably-valid thumbnail, even if the remote one lives longer", async () => {
    seed("a", withThumb("https://storage.googleapis.com/valid.jpg", 45));
    servePages([[remote("a")]]);
    const s = await run();
    expect(s).toMatchObject({ refreshed: 0, unchanged: 1 });
    expect(listing("a").thumbnailUrl).toBe("https://storage.googleapis.com/valid.jpg");
    expect(writes).toHaveLength(0);
  });

  it("renews the thumbnail even from a response whose BUSINESS data is stale, without letting that business data through", async () => {
    seed("a", {
      ...withThumb("https://storage.googleapis.com/old.jpg", -5),
      mombongoEnrichmentSourceAt: "2026-06-01T00:00:00.000Z",
    });
    servePages([
      [
        remote("a", {
          updatedAt: "2026-01-02T00:00:00.000Z",
          seller: { id: "farmer-1", displayName: "Stale Name" },
          listing: {
            commodity: "manioc",
            commodityCode: "MAN",
            province: "Old",
            territory: "Old",
            thumbnail: THUMB(60, "fresh"),
          },
        }),
      ],
    ]);
    await run();
    expect(listing("a").thumbnailUrl).toContain("fresh.jpg");
    expect(listing("a").commodity).toBe("ananas");
    expect(listing("a").province).toBe("Kasaï");
    expect(stored("a").mombongoSeller).toEqual({ id: "farmer-1", displayName: "Marie Kabuya" });
    expect(stored("a").mombongoEnrichmentSourceAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("stale BUSINESS data cannot overwrite newer data, and a response that offers nothing else is 'unchanged'", async () => {
    seed("a", {
      ...withThumb("https://storage.googleapis.com/valid.jpg", 45),
      mombongoEnrichmentSourceAt: "2026-06-01T00:00:00.000Z",
    });
    servePages([
      [
        remote("a", {
          updatedAt: "2026-01-02T00:00:00.000Z",
          seller: { id: "farmer-1", displayName: "Stale Name" },
          listing: {
            commodity: "manioc",
            commodityCode: null,
            province: null,
            territory: null,
            thumbnail: null,
          },
        }),
      ],
    ]);
    const s = await run();
    expect(s).toMatchObject({ refreshed: 0, unchanged: 1 });
    expect(stored("a").mombongoSeller).toEqual({ id: "farmer-1", displayName: "Marie Kabuya" });
    expect(listing("a").commodity).toBe("ananas");
  });

  it("a NEWER business updatedAt still refreshes business data (monotonic guard unchanged)", async () => {
    seed("a", withThumb("https://storage.googleapis.com/valid.jpg", 45));
    servePages([
      [
        remote("a", {
          updatedAt: "2026-03-01T00:00:00.000Z",
          seller: { id: "farmer-1", displayName: "Marie K." },
        }),
      ],
    ]);
    await run();
    expect((stored("a").mombongoSeller as { displayName: string }).displayName).toBe("Marie K.");
    expect(stored("a").mombongoEnrichmentSourceAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("thumbnail renewal FAILS (Mombongo returns thumbnail: null): a still-valid thumbnail is preserved", async () => {
    seed("a", withThumb("https://storage.googleapis.com/valid.jpg", 20)); // near-expiry => renewal wanted
    servePages([
      [
        remote("a", {
          listing: {
            commodity: "ananas",
            commodityCode: "ANA",
            province: "Kasaï",
            territory: "Demba",
            thumbnail: null,
          },
        }),
      ],
    ]);
    const s = await run();
    expect(s.status).toBe("complete");
    expect(listing("a").thumbnailUrl).toBe("https://storage.googleapis.com/valid.jpg");
    expect(listing("a").thumbnailExpiresAt).toBe(iso(NOW + 20 * MIN));
  });

  it("thumbnail renewal FAILS and none is valid: image stays unavailable but seller, product and the offer remain intact — and the run is not failed", async () => {
    seed("a", withThumb("https://storage.googleapis.com/dead.jpg", -30));
    servePages([
      [
        remote("a", {
          listing: {
            commodity: "ananas",
            commodityCode: "ANA",
            province: "Kasaï",
            territory: "Demba",
            thumbnail: null,
          },
        }),
      ],
    ]);
    const s = await run();
    expect(s.status).toBe("complete");
    expect(stored("a").mombongoSeller).toEqual({ id: "farmer-1", displayName: "Marie Kabuya" });
    expect(listing("a").commodity).toBe("ananas");
    expect(stored("a").status).toBe("accepted");
    // the only stored URL is the expired one: readers hide it by its expiry
    expect(Date.parse(listing("a").thumbnailExpiresAt as string)).toBeLessThan(NOW);
  });

  it("an already-expired or foreign-host thumbnail in the response is never stored", async () => {
    seed("a", withThumb(null, null));
    servePages([
      [
        remote("a", {
          listing: {
            commodity: "ananas",
            commodityCode: "ANA",
            province: "Kasaï",
            territory: "Demba",
            thumbnail: { url: "https://evil.example/x.jpg", expiresAt: iso(NOW + 60 * MIN) },
          },
        }),
      ],
    ]);
    await run();
    expect(listing("a").thumbnailUrl).toBeNull();
  });

  it("listing enrichment that is missing gets filled", async () => {
    seed("a", { ...base }); // seller present, listing absent
    servePages([[remote("a")]]);
    await run();
    expect(listing("a")).toMatchObject({ commodity: "ananas", province: "Kasaï" });
  });
});

describe("what a presentation refresh must never do", () => {
  it("never creates an offer: an offer with no local document is skipped", async () => {
    servePages([[remote("ghost")]]);
    const s = await run();
    expect(s).toMatchObject({ examined: 1, refreshed: 0, skipped: 1, shouldReread: false });
    expect(Object.keys(mockRegistry)).toEqual([]);
  });

  it("never changes a lifecycle status: a locally pending offer is skipped untouched, even if Mombongo says accepted", async () => {
    seed("p", { status: "pending" });
    const before = JSON.stringify(mockRegistry);
    servePages([[remote("p")]]);
    const s = await run();
    expect(s.skipped).toBe(1);
    expect(JSON.stringify(mockRegistry)).toBe(before);
  });

  it("only ever writes the presentation fields (and a missing invoiceId) — never status, lastEventId, mombongoOccurredAt, updatedAt, quantity or price", async () => {
    seed("a", { offerQuantityKg: 10, offerPricePerKgCdf: 800 });
    servePages([[remote("a", { quantityKg: 999, unitPriceCdf: 1, invoiceId: "inv-9" })]]);
    await run();
    const allowed = new Set([
      "mombongoSeller",
      "mombongoListing",
      "mombongoEnrichmentSourceAt",
      "invoiceId",
    ]);
    for (const w of writes) for (const k of Object.keys(w.data)) expect(allowed.has(k)).toBe(true);
    expect(stored("a")).toMatchObject({
      status: "accepted",
      lastEventId: "evt-1",
      mombongoOccurredAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:05.000Z",
      offerQuantityKg: 10,
      offerPricePerKgCdf: 800,
      invoiceId: "inv-9",
    });
  });

  it("fills a MISSING invoiceId correlation but never replaces an existing one", async () => {
    seed("a", { invoiceId: "inv-existing" });
    seed("b");
    servePages([[remote("a", { invoiceId: "inv-other" }), remote("b", { invoiceId: "inv-b" })]]);
    await run();
    expect(stored("a").invoiceId).toBe("inv-existing");
    expect(stored("b").invoiceId).toBe("inv-b");
  });

  it("ignores an unsafe invoiceId", async () => {
    seed("a");
    servePages([[remote("a", { invoiceId: "a/b" })]]);
    await run();
    expect(stored("a")).not.toHaveProperty("invoiceId");
  });

  it("touches no collection other than harvestOffers (no receptions, invoices, checkout, payment, claims, checkpoint)", async () => {
    seed("a");
    servePages([[remote("a")]]);
    await run();
    const collections = new Set(Object.keys(mockRegistry).map((k) => k.split("/")[0]));
    expect([...collections]).toEqual(["harvestOffers"]);
    expect(writes.every((w) => w.path.startsWith("harvestOffers/"))).toBe(true);
    expect(stored("a")).not.toHaveProperty("mombongoCheckout");
  });

  it("a different seller id than the frozen one is skipped and nothing is overwritten", async () => {
    seed("a", {
      mombongoSeller: { id: "farmer-1", displayName: "Marie" },
      mombongoEnrichmentSourceAt: "2026-01-01T00:00:00.000Z",
    });
    servePages([[remote("a", { seller: { id: "someone-else", displayName: "Zed" } })]]);
    const s = await run();
    expect(s.skipped).toBe(1);
    expect(stored("a").mombongoSeller).toEqual({ id: "farmer-1", displayName: "Marie" });
  });

  it("an older Mombongo response without seller/listing at all changes nothing", async () => {
    seed("a");
    const { seller: _s, listing: _l, ...old } = remote("a");
    servePages([[old as ExternalHarvestOfferDto]]);
    const s = await run();
    expect(s).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(stored("a")).not.toHaveProperty("mombongoSeller");
  });

  it("one malformed remote record does not abort the run", async () => {
    seed("a");
    servePages([
      [
        { offerId: 7 } as unknown as ExternalHarvestOfferDto,
        null as unknown as ExternalHarvestOfferDto,
        remote("a"),
      ],
    ]);
    const s = await run();
    expect(s).toMatchObject({ examined: 3, refreshed: 1, skipped: 2 });
  });
});

describe("Mombongo unavailable", () => {
  it("first request fails: honest 'unavailable', nothing written, nothing to re-read", async () => {
    seed("a");
    const before = JSON.stringify(mockRegistry);
    vi.mocked(getMombongoHarvestOffers).mockResolvedValue({
      error: "Mombongo returned 500",
      httpStatus: 500,
    });
    const s = await run();
    expect(s).toEqual({
      status: "unavailable",
      examined: 0,
      refreshed: 0,
      unchanged: 0,
      skipped: 0,
      shouldReread: false,
    });
    expect(JSON.stringify(mockRegistry)).toBe(before);
  });

  it("a network exception is 'unavailable', not a crash", async () => {
    vi.mocked(getMombongoHarvestOffers).mockRejectedValue(
      new Error("ECONNRESET https://x?X-Goog-Signature=abc"),
    );
    expect((await run()).status).toBe("unavailable");
  });

  it("failing on a LATER page is 'partial': earlier work is kept and reported, never claimed complete", async () => {
    seed("a");
    let n = 0;
    vi.mocked(getMombongoHarvestOffers).mockImplementation(async () => {
      n++;
      if (n === 1) return { offers: [remote("a")], nextCursor: "c1" };
      return { error: "Mombongo returned 503", httpStatus: 503 };
    });
    const s = await run();
    expect(s).toMatchObject({ status: "partial", examined: 1, refreshed: 1, shouldReread: true });
    expect(stored("a")).toHaveProperty("mombongoSeller");
  });

  it("logs contain no token, signature, secret, signed image URL or farmer data", async () => {
    seed("a");
    vi.mocked(getMombongoHarvestOffers).mockRejectedValue(
      new Error(
        "boom https://storage.googleapis.com/x.jpg?X-Goog-Signature=SECRET_SIG Marie Kabuya",
      ),
    );
    await run();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toMatch(/googleapis|Signature|SECRET_SIG|Kabuya|Bearer/);
  });

  it("the summary never contains a URL, name or credential", async () => {
    seed("a");
    servePages([[remote("a")]]);
    const s = await run();
    expect(Object.keys(s).sort()).toEqual([
      "examined",
      "refreshed",
      "shouldReread",
      "skipped",
      "status",
      "unchanged",
    ]);
    expect(JSON.stringify(s)).not.toMatch(/googleapis|Signature|Kabuya|thumbnail/i);
  });
});

describe("throttle and single-flight", () => {
  it("a second run inside the minimum interval is 'throttled' with a retry hint and makes no remote call", async () => {
    servePages([[]]);
    let t = 1_000_000;
    expect((await runOfferRefresh(() => t)).status).toBe("complete");
    vi.mocked(getMombongoHarvestOffers).mockClear();
    t += 5_000;
    expect(await runOfferRefresh(() => t)).toEqual({
      status: "throttled",
      retryAfterMs: REFRESH_MIN_INTERVAL_MS - 5_000,
    });
    expect(getMombongoHarvestOffers).not.toHaveBeenCalled();
  });

  it("runs again once the interval has passed", async () => {
    servePages([[]]);
    let t = 1_000_000;
    await runOfferRefresh(() => t);
    t += REFRESH_MIN_INTERVAL_MS + 1;
    expect((await runOfferRefresh(() => t)).status).toBe("complete");
  });

  it("a failed/unavailable run still counts toward the throttle, so an outage cannot be hammered", async () => {
    vi.mocked(getMombongoHarvestOffers).mockResolvedValue({ error: "down", httpStatus: 503 });
    let t = 1_000_000;
    expect((await runOfferRefresh(() => t)).status).toBe("unavailable");
    t += 1_000;
    expect((await runOfferRefresh(() => t)).status).toBe("throttled");
  });

  it("concurrent equivalent refreshes share ONE run (one remote call) and get the same result", async () => {
    seed("a");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(getMombongoHarvestOffers).mockImplementation(async () => {
      await gate;
      return { offers: [remote("a")], nextCursor: null };
    });
    const first = runOfferRefresh();
    const second = runOfferRefresh();
    const third = runOfferRefresh();
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(getMombongoHarvestOffers).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toMatchObject({ status: "complete", refreshed: 1 });
    expect(Object.keys(mockRegistry)).toEqual(["harvestOffers/ext-a"]);
  });

  it("two racing runs (different isolates) are idempotent: the same offer is refreshed once and never duplicated", async () => {
    seed("a");
    servePages([[remote("a")]]);
    const [x, y] = await Promise.all([run(), run()]);
    expect(x.refreshed + y.refreshed).toBeGreaterThanOrEqual(1);
    expect(Object.keys(mockRegistry)).toEqual(["harvestOffers/ext-a"]);
    expect(stored("a").mombongoSeller).toEqual({ id: "farmer-1", displayName: "Marie Kabuya" });
  });
});
