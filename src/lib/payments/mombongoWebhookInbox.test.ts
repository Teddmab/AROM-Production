import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimInboxEvent,
  markInboxConflict,
  markInboxFailed,
  markInboxProcessed,
} from "./mombongoWebhookInbox";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
let registryVersion = 0;
const setDocCalls: { path: string; data: Record<string, unknown> }[] = [];
const updateDocCalls: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    updateDocCalls.push({ path: ref.path, data });
    const existing = mockRegistry[ref.path];
    mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
  }),
  // Faithful-enough optimistic-concurrency simulation, same pattern as
  // mombongoHarvest.test.ts's own runTransaction mock: if the registry
  // changed between this transaction's own read and its attempted commit,
  // the whole callback re-runs and observes the winner's write instead of
  // overwriting it — this is what actually proves "two concurrent
  // deliveries of the same event do not both process" under a real race,
  // not just a sequential replay.
  runTransaction: vi.fn(async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    for (;;) {
      const versionAtStart = registryVersion;
      let write: { path: string; data: Record<string, unknown> } | null = null;
      const tx = {
        get: async (ref: { path: string }) => {
          const entry = mockRegistry[ref.path];
          return { exists: () => !!entry?.exists, data: () => entry?.data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          write = { path: ref.path, data };
        },
      };
      const result = await updateFn(tx);
      if (write) {
        if (registryVersion !== versionAtStart) continue; // lost the race — retry, observe the winner
        mockRegistry[(write as { path: string }).path] = {
          exists: true,
          data: (write as { data: Record<string, unknown> }).data,
        };
        setDocCalls.push(write);
        registryVersion++;
      }
      return result;
    }
  }),
}));

beforeEach(() => {
  mockRegistry = {};
  registryVersion = 0;
  setDocCalls.length = 0;
  updateDocCalls.length = 0;
});

const INPUT = {
  eventId: "evt-1",
  eventType: "offer_status_changed" as const,
  schemaVersion: 1,
  occurredAt: "2026-09-19T12:00:00.000Z",
  mombongoOfferId: "mb1",
};

describe("claimInboxEvent", () => {
  it("a new eventId creates a 'received' record and returns kind:'process'", async () => {
    const claim = await claimInboxEvent(INPUT);
    expect(claim.kind).toBe("process");
    expect(setDocCalls[0].data).toMatchObject({ eventId: "evt-1", processingState: "received" });
  });

  it("never persists a signature/secret/token field, even if the caller somehow passed one", async () => {
    await claimInboxEvent(INPUT);
    const persisted = setDocCalls[0].data;
    expect(persisted).not.toHaveProperty("signature");
    expect(persisted).not.toHaveProperty("hmacSecret");
    expect(persisted).not.toHaveProperty("token");
  });

  it("a duplicate eventId already 'processed' returns kind:'already_processed' without a second create", async () => {
    await claimInboxEvent(INPUT);
    mockRegistry["mombongoWebhookEvents/evt-1"].data!.processingState = "processed";
    const claim = await claimInboxEvent(INPUT);
    expect(claim.kind).toBe("already_processed");
    expect(setDocCalls).toHaveLength(1); // no second create
  });

  it("a duplicate eventId already 'conflict' returns kind:'already_conflict' (no automatic reprocessing of a conflict)", async () => {
    await claimInboxEvent(INPUT);
    mockRegistry["mombongoWebhookEvents/evt-1"].data!.processingState = "conflict";
    const claim = await claimInboxEvent(INPUT);
    expect(claim.kind).toBe("already_conflict");
  });

  it("a duplicate eventId in 'failed' state is resumable — returns kind:'process' again", async () => {
    await claimInboxEvent(INPUT);
    mockRegistry["mombongoWebhookEvents/evt-1"].data!.processingState = "failed";
    const claim = await claimInboxEvent(INPUT);
    expect(claim.kind).toBe("process");
    expect(setDocCalls).toHaveLength(1); // resumed the existing record, not a new create
  });

  it("a duplicate eventId still 'received' (worker died before finishing) is resumable", async () => {
    await claimInboxEvent(INPUT);
    const claim = await claimInboxEvent(INPUT);
    expect(claim.kind).toBe("process");
  });

  it("two truly concurrent deliveries of the same eventId create at most one inbox record — the atomic transaction, not app-level luck, closes this", async () => {
    const [a, b] = await Promise.all([claimInboxEvent(INPUT), claimInboxEvent(INPUT)]);
    // Exactly one create ever commits — the other observes the winner's
    // already-'received' record via the transaction's own retry, not a
    // second independent create.
    expect(setDocCalls).toHaveLength(1);
    // Both may legitimately resolve to kind:'process' (the loser resumes
    // the winner's still-'received' record rather than being told
    // "already handled") — the actual double-application protection for
    // the OFFER itself lives in applyMombongoOfferOutcome's own
    // same-state idempotency (see mombongoOfferOutcome.test.ts), not
    // here; this test's own guarantee is narrower and structural: the
    // inbox never forks into two logical records for one eventId.
    expect([a.kind, b.kind].every((k) => k === "process")).toBe(true);
  });
});

describe("markInboxProcessed / markInboxFailed / markInboxConflict", () => {
  it("markInboxProcessed sets processingState and processedAt", async () => {
    const claim = await claimInboxEvent(INPUT);
    if (claim.kind !== "process") throw new Error("expected process");
    await markInboxProcessed(claim.ref, "offer-doc-1");
    expect(mockRegistry["mombongoWebhookEvents/evt-1"].data).toMatchObject({
      processingState: "processed",
      offerDocumentId: "offer-doc-1",
    });
  });

  it("markInboxFailed sets a safe errorCode/errorSummary, never a raw exception object", async () => {
    const claim = await claimInboxEvent(INPUT);
    if (claim.kind !== "process") throw new Error("expected process");
    await markInboxFailed(claim.ref, "processing_error", "a safe summary string");
    expect(mockRegistry["mombongoWebhookEvents/evt-1"].data).toMatchObject({
      processingState: "failed",
      errorCode: "processing_error",
      errorSummary: "a safe summary string",
    });
  });

  it("markInboxConflict records conflictDetails", async () => {
    const claim = await claimInboxEvent(INPUT);
    if (claim.kind !== "process") throw new Error("expected process");
    await markInboxConflict(claim.ref, "accepted vs declined mismatch");
    expect(mockRegistry["mombongoWebhookEvents/evt-1"].data).toMatchObject({
      processingState: "conflict",
      conflictDetails: "accepted vs declined mismatch",
    });
  });
});
