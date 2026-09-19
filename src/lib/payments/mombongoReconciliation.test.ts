import { beforeEach, describe, expect, it, vi } from "vitest";
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
      kind: "checkpoint" | "where";
      whereField?: string;
      whereValue?: unknown;
    }) => {
      if (q.kind === "checkpoint") {
        const docs = Object.entries(mockRegistry)
          .filter(([path, v]) => v.exists && path.startsWith("harvestOffers/") && v.data?.updatedAt)
          .sort(([, a], [, b]) =>
            String(b.data?.updatedAt).localeCompare(String(a.data?.updatedAt)),
          );
        return {
          empty: docs.length === 0,
          docs: docs
            .slice(0, 1)
            .map(([path, v]) => ({ id: path.split("/")[1], data: () => v.data })),
        };
      }
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
      ...clauses: { type: "orderBy" | "where" | "limit"; field?: string; value?: unknown }[]
    ) => {
      const whereClause = clauses.find((c) => c?.type === "where");
      return whereClause
        ? {
            ...base,
            kind: "where" as const,
            whereField: whereClause.field,
            whereValue: whereClause.value,
          }
        : { ...base, kind: "checkpoint" as const };
    },
  ),
  orderBy: vi.fn(() => ({ type: "orderBy" as const })),
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

describe("reconcileMombongoOffers", () => {
  it("pagination: follows nextCursor across multiple pages until exhausted", async () => {
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
    expect(mockRegistry["harvestOffers/ext-a"].data?.status).toBe("accepted");
    expect(mockRegistry["harvestOffers/ext-b"].data?.status).toBe("declined");
    // Second page's request carried the cursor from the first.
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondCallBody.cursor).toBe("cursor-1");
  });

  it("checkpoint: derives updatedSince from the current max harvestOffers.updatedAt, not a separately stored value", async () => {
    seedOffer("ext-a", { status: "accepted", updatedAt: "2026-09-19T09:00:00.000Z" });
    seedOffer("ext-b", { status: "accepted", updatedAt: "2026-09-19T15:00:00.000Z" });
    const fetchMock = mockFetchSequence([{ status: 200, body: { offers: [], nextCursor: null } }]);
    await reconcileMombongoOffers();
    const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstCallBody.updatedSince).toBe("2026-09-19T15:00:00.000Z");
  });

  it("legacy 'won' normalizes to 'accepted' during reconciliation", async () => {
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

  it("stale pending on Mombongo's side cannot downgrade an already-terminal local status", async () => {
    seedOffer("ext-a", {
      status: "accepted",
      mombongoOfferId: "mb-a",
      mombongoOccurredAt: "2026-09-19T12:00:00.000Z",
    });
    mockFetchSequence([
      {
        status: 200,
        body: {
          offers: [
            {
              offerId: "mb-a",
              externalReference: "ext-a",
              status: "pending",
              updatedAt: "2026-09-19T13:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    // 'pending' is skipped entirely — nothing authoritative to apply.
    expect(summary.applied).toBe(0);
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

  it("partial-page failure stops processing without silently skipping ahead — already-applied items remain applied", async () => {
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
              offerId: "mb-missing",
              externalReference: null,
              status: "accepted",
              updatedAt: "2026-09-19T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    const summary = await reconcileMombongoOffers();
    // ext-a applied fine; mb-missing has no local correlation at all —
    // classified as notFoundLocally, not a thrown error, so the whole
    // page still completes; the ext-a write is durable regardless.
    expect(mockRegistry["harvestOffers/ext-a"].data?.status).toBe("accepted");
    expect(summary.notFoundLocally).toBe(1);
  });

  it("credentials never appear in the returned summary", async () => {
    mockFetchSequence([{ status: 200, body: { offers: [], nextCursor: null } }]);
    const summary = await reconcileMombongoOffers();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(FAKE_CONFIG.inboundSigningSecret);
    expect(serialized).not.toContain(FAKE_CONFIG.outboundVerifySecret);
    expect(serialized).not.toContain(FAKE_CONFIG.partnerId);
  });

  it("a repeated run with nothing new is safe and idempotent", async () => {
    seedOffer("ext-a", {
      status: "accepted",
      mombongoOfferId: "mb-a",
      mombongoOccurredAt: "2026-09-19T12:00:00.000Z",
    });
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
    expect(summary.alreadyApplied).toBe(1);
    expect(summary.applied).toBe(0);
  });

  it("bubbles a Mombongo API error without throwing", async () => {
    mockFetchSequence([{ status: 500, body: {} }]);
    const summary = await reconcileMombongoOffers();
    expect(summary.error).toBeTruthy();
    expect(summary.pagesProcessed).toBe(0);
  });
});
