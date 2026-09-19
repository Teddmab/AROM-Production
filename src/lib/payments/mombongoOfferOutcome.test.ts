import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMombongoOfferOutcome } from "./mombongoOfferOutcome";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  getDoc: vi.fn(async (ref: { path: string; id: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.id };
  }),
  getDocs: vi.fn(async (q: { collectionPath: string; wheres: [string, unknown][] }) => {
    const docs = Object.entries(mockRegistry)
      .filter(([path, v]) => v.exists && path.startsWith(`${q.collectionPath}/`))
      .filter(([, v]) => q.wheres.every(([field, value]) => v.data?.[field] === value))
      .map(([path, v]) => ({ id: path.split("/")[1], data: () => v.data! }));
    return { size: docs.length, empty: docs.length === 0, docs };
  }),
  collection: vi.fn((_db: unknown, path: string) => ({
    collectionPath: path,
    wheres: [] as [string, unknown][],
  })),
  query: vi.fn(
    (base: { collectionPath: string }, ...clauses: { field: string; value: unknown }[]) => ({
      collectionPath: base.collectionPath,
      wheres: clauses
        .filter((c) => c && "field" in c)
        .map((c) => [c.field, c.value] as [string, unknown]),
    }),
  ),
  where: vi.fn((field: string, _op: string, value: unknown) => ({ field, value })),
  limit: vi.fn(() => ({})),
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

function seedOffer(id: string, data: Record<string, unknown>) {
  mockRegistry[`harvestOffers/${id}`] = { exists: true, data: { id, ...data } };
}

const BASE_INPUT = {
  mombongoOfferId: "mb1",
  externalReference: "ext-1",
  occurredAt: "2026-09-19T12:00:00.000Z",
  eventId: "evt-1",
} as const;

beforeEach(() => {
  mockRegistry = {};
});

describe("applyMombongoOfferOutcome — exact correlation", () => {
  it("finds the offer by externalReference (its own doc id) directly", async () => {
    seedOffer("ext-1", { status: "pending", listingId: "l1", mombongoOfferId: "mb1" });
    const result = await applyMombongoOfferOutcome({ ...BASE_INPUT, status: "accepted" });
    expect(result).toMatchObject({ kind: "applied", offerDocId: "ext-1" });
  });

  it("falls back to a mombongoOfferId query when externalReference doesn't resolve directly (pre-v2 offer)", async () => {
    seedOffer("random-doc-id", { status: "pending", listingId: "l1", mombongoOfferId: "mb1" });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      externalReference: null,
      status: "accepted",
    });
    expect(result).toMatchObject({ kind: "applied", offerDocId: "random-doc-id" });
  });

  it("never correlates by listingId alone — no match by mombongoOfferId means not_found even if a listingId would match", async () => {
    seedOffer("some-doc", {
      status: "pending",
      listingId: "l1",
      mombongoOfferId: "a-different-offer",
    });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      externalReference: null,
      status: "accepted",
    });
    expect(result.kind).toBe("not_found");
  });

  it("tolerates event arrival before the submission response is stored (offer doc doesn't exist yet)", async () => {
    const result = await applyMombongoOfferOutcome({ ...BASE_INPUT, status: "accepted" });
    expect(result.kind).toBe("not_found");
  });
});

describe("applyMombongoOfferOutcome — transitions and terminal-conflict safety", () => {
  it("pending -> accepted applies", async () => {
    seedOffer("ext-1", { status: "pending", listingId: "l1", mombongoOfferId: "mb1" });
    const result = await applyMombongoOfferOutcome({ ...BASE_INPUT, status: "accepted" });
    expect(result.kind).toBe("applied");
    expect(mockRegistry["harvestOffers/ext-1"].data?.status).toBe("accepted");
  });

  it("pending -> declined applies", async () => {
    seedOffer("ext-1", { status: "pending", listingId: "l1", mombongoOfferId: "mb1" });
    const result = await applyMombongoOfferOutcome({ ...BASE_INPUT, status: "declined" });
    expect(result.kind).toBe("applied");
  });

  it("legacy 'won' + incoming 'accepted' normalizes to accepted (canonically same-state)", async () => {
    seedOffer("ext-1", { status: "won", listingId: "l1", mombongoOfferId: "mb1" });
    const result = await applyMombongoOfferOutcome({ ...BASE_INPUT, status: "accepted" });
    expect(result.kind).toBe("applied");
    expect(mockRegistry["harvestOffers/ext-1"].data?.status).toBe("accepted");
  });

  it("same-state replay with an older/equal occurredAt is a no-op (already_applied)", async () => {
    seedOffer("ext-1", {
      status: "accepted",
      listingId: "l1",
      mombongoOfferId: "mb1",
      mombongoOccurredAt: "2026-09-19T12:00:00.000Z",
    });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      status: "accepted",
      occurredAt: "2026-09-19T12:00:00.000Z",
    });
    expect(result.kind).toBe("already_applied");
  });

  it("same-state replay with a newer occurredAt updates metadata", async () => {
    seedOffer("ext-1", {
      status: "accepted",
      listingId: "l1",
      mombongoOfferId: "mb1",
      mombongoOccurredAt: "2026-09-19T12:00:00.000Z",
    });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      status: "accepted",
      occurredAt: "2026-09-19T13:00:00.000Z",
    });
    expect(result.kind).toBe("applied");
    expect(mockRegistry["harvestOffers/ext-1"].data?.mombongoOccurredAt).toBe(
      "2026-09-19T13:00:00.000Z",
    );
  });

  it("a conflicting terminal outcome (accepted vs declined) is recorded as a conflict, never overwritten", async () => {
    seedOffer("ext-1", {
      status: "accepted",
      listingId: "l1",
      mombongoOfferId: "mb1",
      mombongoOccurredAt: "2026-09-19T10:00:00.000Z",
    });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      status: "declined",
      occurredAt: "2026-09-19T11:00:00.000Z",
    });
    expect(result.kind).toBe("conflict");
    expect(mockRegistry["harvestOffers/ext-1"].data?.status).toBe("accepted"); // untouched
  });

  it("a stale (older-occurredAt) conflicting event is classified as stale, not applied", async () => {
    seedOffer("ext-1", {
      status: "accepted",
      listingId: "l1",
      mombongoOfferId: "mb1",
      mombongoOccurredAt: "2026-09-19T12:00:00.000Z",
    });
    const result = await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      status: "declined",
      occurredAt: "2026-09-19T01:00:00.000Z",
    });
    expect(result.kind).toBe("stale");
    expect(mockRegistry["harvestOffers/ext-1"].data?.status).toBe("accepted"); // untouched
  });

  it("invoiceId is set exactly once and then left untouched by a later same-state replay with a different invoiceId", async () => {
    seedOffer("ext-1", {
      status: "accepted",
      listingId: "l1",
      mombongoOfferId: "mb1",
      invoiceId: "inv-1",
      mombongoOccurredAt: "t1",
    });
    await applyMombongoOfferOutcome({
      ...BASE_INPUT,
      status: "accepted",
      occurredAt: "t2",
      invoiceId: "inv-2",
    });
    expect(mockRegistry["harvestOffers/ext-1"].data?.invoiceId).toBe("inv-1");
  });
});
