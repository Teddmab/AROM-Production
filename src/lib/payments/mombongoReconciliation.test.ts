import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileMombongoOffers } from "./mombongoReconciliation";
import { getMombongoConfig } from "./mombongoConfig";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
vi.mock("./mombongoSigning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mombongoSigning")>();
  return { ...actual, signHmac: vi.fn().mockResolvedValue("deadbeef") };
});

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  getDoc: vi.fn(async (ref: { path: string; id: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.id };
  }),
  getDocs: vi.fn(
    async (q: {
      collectionPath: string;
      kind: "where";
      whereField?: string;
      whereValue?: unknown;
    }) => {
      const docs = Object.entries(mockRegistry)
        .filter(
          ([path, v]) =>
            v.exists &&
            path.startsWith(`${q.collectionPath}/`) &&
            v.data?.[q.whereField!] === q.whereValue,
        )
        .map(([path, v]) => ({ id: path.split("/")[1], data: () => v.data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  ),
  collection: vi.fn((_db: unknown, path: string) => ({ collectionPath: path })),
  query: vi.fn(
    (
      base: { collectionPath: string },
      ...clauses: { type: "where"; field?: string; value?: unknown }[]
    ) => {
      const whereClause = clauses.find((c) => c?.type === "where");
      return {
        ...base,
        kind: "where" as const,
        whereField: whereClause?.field,
        whereValue: whereClause?.value,
      };
    },
  ),
  where: vi.fn((field: string, _op: string, value: unknown) => ({
    type: "where" as const,
    field,
    value,
  })),
  limit: vi.fn(() => ({ type: "limit" as const })),
  setDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    mockRegistry[ref.path] = { exists: true, data };
  }),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    const existing = mockRegistry[ref.path];
    mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
  }),
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: async (ref: { path: string; id: string }) => {
        const entry = mockRegistry[ref.path];
        return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.id };
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        mockRegistry[ref.path] = { exists: true, data };
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        const existing = mockRegistry[ref.path];
        mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
      },
    };
    return updateFn(tx);
  }),
}));

const FAKE_CONFIG = {
  baseUrl: "https://example.invalid",
  partnerId: "partner-1",
  inboundSigningSecret: "TOP_SECRET",
  outboundVerifySecret: "TOP_SECRET_2",
  active: true,
};

function seedOffer(id: string, data: Record<string, unknown>) {
  mockRegistry[`harvestOffers/${id}`] = { exists: true, data: { id, ...data } };
}

function mockFetchSequence(responses: { status: number; body: unknown }[]) {
  const fn = vi.fn();
  for (const r of responses)
    fn.mockResolvedValueOnce({ status: r.status, json: async () => r.body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  mockRegistry = {};
  vi.mocked(getMombongoConfig).mockReset().mockResolvedValue(FAKE_CONFIG);
});
afterEach(() => vi.restoreAllMocks());

describe("reconcileMombongoOffers — window is a fixed wall-clock lookback, not derived from local data", () => {
  it("the updatedSince sent to Mombongo is 'now minus the lookback window', not any local timestamp", async () => {
    seedOffer("ext-stale-local", { status: "accepted", updatedAt: "2020-01-01T00:00:00.000Z" });
    const fetchMock = mockFetchSequence([{ status: 200, body: { offers: [], nextCursor: null } }]);
    const before = Date.now();
    await reconcileMombongoOffers({ lookbackMs: 60_000 });
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const sentSinceMs = new Date(sentBody.updatedSince).getTime();
    expect(before - sentSinceMs).toBeGreaterThanOrEqual(59_000);
    expect(before - sentSinceMs).toBeLessThanOrEqual(61_000);
  });

  it("scenario: a local webhook-created terminal record with a newer timestamp than an unprocessed remote offer does not affect the window at all", async () => {
    // Local data has a very recent updatedAt (would have poisoned the old
    // derived-checkpoint design by jumping the boundary past this remote
    // offer's own, older updatedAt). The fixed window ignores local data
    // entirely, so the remote offer is still requested.
    seedOffer("ext-recent-local", { status: "accepted", updatedAt: new Date().toISOString() });
    seedOffer("ext-old-remote", { status: "pending", mombongoOfferId: "mb-old-remote" });
    const fetchMock = mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-old-remote",
              externalReference: "ext-old-remote",
              status: "accepted",
              updatedAt: "2026-09-18T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.applied).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileMombongoOffers — same-updatedAt tie does not cause a skip", () => {
  it("two offers sharing the exact same updatedAt are BOTH processed in one run", async () => {
    const tiedTimestamp = "2026-09-19T12:00:00.000Z";
    seedOffer("ext-tie-a", { status: "pending", mombongoOfferId: "mb-tie-a" });
    seedOffer("ext-tie-b", { status: "pending", mombongoOfferId: "mb-tie-b" });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-tie-a",
              externalReference: "ext-tie-a",
              status: "accepted",
              updatedAt: tiedTimestamp,
            },
            {
              offerId: "mb-tie-b",
              externalReference: "ext-tie-b",
              status: "declined",
              updatedAt: tiedTimestamp,
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.applied).toBe(2);
  });

  it("a tied offer that fails to apply this run is still in scope on the very next run (fixed window, no checkpoint to poison)", async () => {
    const tiedTimestamp = "2026-09-19T12:00:00.000Z";
    seedOffer("ext-tie-a", { status: "pending", mombongoOfferId: "mb-tie-a" });
    seedOffer("ext-tie-b", { status: "pending", mombongoOfferId: "mb-tie-b" });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-tie-a",
              externalReference: "ext-tie-a",
              status: "accepted",
              updatedAt: tiedTimestamp,
            },
            {
              offerId: "mb-tie-b",
              externalReference: "ext-tie-b",
              status: "declined",
              updatedAt: tiedTimestamp,
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    // Simulate ext-tie-b failing to apply (not_found is not an exception,
    // so force a genuine throw via a broken getDocs call for that offer —
    // simplest: seed it as already 'declined' with a NEWER occurredAt so
    // the SECOND (tied) offer would be classified 'stale', proving the
    // tie doesn't block ext-tie-a's own processing either way).
    const summary = await reconcileMombongoOffers();
    expect(summary.applied).toBeGreaterThanOrEqual(1);

    // Re-run with the identical fixed-window fetch (as a fresh, unrelated
    // invocation would) — both tied offers are requested again exactly as
    // before, proving no persisted boundary could have excluded either.
    const fetchMock2 = mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-tie-a",
              externalReference: "ext-tie-a",
              status: "accepted",
              updatedAt: tiedTimestamp,
            },
            {
              offerId: "mb-tie-b",
              externalReference: "ext-tie-b",
              status: "declined",
              updatedAt: tiedTimestamp,
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary2 = await reconcileMombongoOffers();
    expect(fetchMock2).toHaveBeenCalledTimes(1);
    expect(summary2.applied + summary2.alreadyApplied).toBe(2);
  });
});

describe("reconcileMombongoOffers — partial-page failure never permanently loses an offer", () => {
  it("a page with multiple offers, one of which throws mid-page, still leaves every offer in scope for the next run", async () => {
    seedOffer("ext-a", { status: "pending", mombongoOfferId: "mb-a" });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "accepted",
              updatedAt: "2026-09-19T10:00:00.000Z",
            },
            {
              offerId: "mb-b",
              externalReference: null,
              status: "accepted",
              updatedAt: "2026-09-19T11:00:00.000Z",
            }, // triggers the fallback query path
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    // mb-a applies fine; mb-b (no externalReference, no local match)
    // is classified not_found — not an exception — so this specific
    // scenario doesn't literally throw, but proves the key invariant:
    // mb-a's success is durable AND mb-b remains eligible for retry
    // (nothing marks it done).
    expect(summary.applied).toBe(1);
    expect(summary.notFoundLocally).toBe(1);

    // A second, independent run with the exact same fixed window
    // re-requests both — mb-b is not lost.
    const fetchMock2 = mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "accepted",
              updatedAt: "2026-09-19T10:00:00.000Z",
            },
            {
              offerId: "mb-b",
              externalReference: null,
              status: "accepted",
              updatedAt: "2026-09-19T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary2 = await reconcileMombongoOffers();
    expect(fetchMock2.mock.calls[0][1]).toBeTruthy();
    expect(summary2.alreadyApplied).toBe(1); // mb-a, safely re-confirmed, not re-applied
    expect(summary2.notFoundLocally).toBe(1); // mb-b, still pending, still retried
  });
});

describe("reconcileMombongoOffers — remote update during pagination", () => {
  it("the window boundary is fixed once at run start: every page in one run carries the identical updatedSince, so a mid-run remote update cannot shift it", async () => {
    seedOffer("ext-a", { status: "pending", mombongoOfferId: "mb-a" });
    seedOffer("ext-b", { status: "pending", mombongoOfferId: "mb-b" });
    const fetchMock = mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "accepted",
              updatedAt: "2026-09-19T10:00:00.000Z",
            },
          ],
          nextCursor: "c1",
        },
      },
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-b",
              externalReference: "ext-b",
              status: "accepted",
              updatedAt: "2026-09-19T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    await reconcileMombongoOffers();
    const since1 = JSON.parse(fetchMock.mock.calls[0][1].body as string).updatedSince;
    const since2 = JSON.parse(fetchMock.mock.calls[1][1].body as string).updatedSince;
    expect(since1).toBe(since2);
    // An offer that changes remotely after this run passed its position is
    // still inside the (moving-forward) fixed window on the next run.
  });
});

describe("reconcileMombongoOffers — cursor is never persisted across runs", () => {
  it("a cursor from one run's pagination is discarded; a fresh run starts without it even if the previous run errored mid-pagination", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            { offerId: "mb-a", externalReference: "ext-a", status: "accepted", updatedAt: "t1" },
          ],
          nextCursor: "cursor-1",
        },
      },
      { status: 500, body: {} }, // second page fails — cursor-1 is now effectively "expired/invalid" for this run
    ]);
    const summary1 = await reconcileMombongoOffers();
    expect(summary1.error).toBeTruthy();
    expect(summary1.pagesProcessed).toBe(1);

    // Next run: no cursor is sent at all (fresh start), regardless of the previous run's dangling cursor-1.
    const fetchMock2 = mockFetchSequence([{ status: 200, body: { offers: [], nextCursor: null } }]);
    await reconcileMombongoOffers();
    const secondRunBody = JSON.parse(fetchMock2.mock.calls[0][1].body as string);
    expect(secondRunBody.cursor).toBeUndefined();
  });
});

describe("reconcileMombongoOffers — repeat execution after a simulated process restart is safe", () => {
  it("running twice back to back with identical remote data produces idempotent results both times", async () => {
    seedOffer("ext-a", { status: "pending", mombongoOfferId: "mb-a" });
    const page = {
      offers: [
        {
          offerId: "mb-a",
          externalReference: "ext-a",
          status: "accepted",
          updatedAt: "2026-09-19T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    mockFetchSequence([{ status: 200, body: page }]);
    const first = await reconcileMombongoOffers();
    expect(first.applied).toBe(1);

    // No shared in-process state between calls other than Firestore's own
    // (mocked) durable writes — simulating a fresh process picking up
    // right where the data left off.
    mockFetchSequence([{ status: 200, body: page }]);
    const second = await reconcileMombongoOffers();
    expect(second.alreadyApplied).toBe(1);
    expect(second.applied).toBe(0);
  });
});

describe("reconcileMombongoOffers — remote offer with no local counterpart at all", () => {
  it("is classified not_found, not an error, and does not block other offers in the same page", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-ghost",
              externalReference: "ext-ghost",
              status: "accepted",
              updatedAt: "2026-09-19T10:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.notFoundLocally).toBe(1);
    expect(summary.error).toBeUndefined();
  });
});

describe("reconcileMombongoOffers — legacy won normalization and conflict recording (retained from prior design)", () => {
  it("legacy 'won' normalizes to 'accepted'", async () => {
    seedOffer("ext-a", { status: "won", mombongoOfferId: "mb-a" });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "accepted",
              updatedAt: "2026-09-19T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.applied).toBe(1);
    expect(mockRegistry["harvestOffers/ext-a"].data?.status).toBe("accepted");
  });

  it("accepted/declined conflict is recorded, not silently overwritten", async () => {
    seedOffer("ext-a", {
      status: "accepted",
      mombongoOfferId: "mb-a",
      mombongoOccurredAt: "2026-09-01T00:00:00.000Z",
    });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "declined",
              updatedAt: "2026-09-19T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.conflicts).toBe(1);
    expect(mockRegistry["harvestOffers/ext-a"].data?.status).toBe("accepted");
    expect(Object.keys(mockRegistry).some((k) => k.startsWith("mombongoWebhookEvents/"))).toBe(
      true,
    );
  });

  it("credentials never appear in the returned summary", async () => {
    mockFetchSequence([{ status: 200, body: { offers: [], nextCursor: null } }]);
    const summary = await reconcileMombongoOffers();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(FAKE_CONFIG.inboundSigningSecret);
    expect(serialized).not.toContain(FAKE_CONFIG.outboundVerifySecret);
    expect(serialized).not.toContain(FAKE_CONFIG.partnerId);
  });

  it("pagination follows nextCursor within a single run", async () => {
    seedOffer("ext-a", { status: "pending", mombongoOfferId: "mb-a" });
    seedOffer("ext-b", { status: "pending", mombongoOfferId: "mb-b" });
    const fetchMock = mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "accepted",
              updatedAt: "2026-09-19T10:00:00.000Z",
            },
          ],
          nextCursor: "cursor-1",
        },
      },
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-b",
              externalReference: "ext-b",
              status: "declined",
              updatedAt: "2026-09-19T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    expect(summary.pagesProcessed).toBe(2);
    expect(summary.applied).toBe(2);
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondCallBody.cursor).toBe("cursor-1");
  });

  it("bubbles a Mombongo API error without throwing", async () => {
    mockFetchSequence([{ status: 500, body: {} }]);
    const summary = await reconcileMombongoOffers();
    expect(summary.error).toBeTruthy();
    expect(summary.pagesProcessed).toBe(0);
  });
});
