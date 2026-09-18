import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyQcReleaseReceipt } from "./qcReleaseReceipt";

/**
 * Sprint 08, Step B — unit coverage for the Worker's own transaction logic,
 * mirroring AROM-Mobile's qualitySync.test.ts mock-registry pattern (this
 * function is the server-side continuation of that same release flow).
 * `firestore/lite`'s `getDoc`/`runTransaction` are mocked at the module
 * boundary rather than run against a live emulator — AROM-Backend's own
 * rules.test.mjs ("trusted-write-only create boundary") already exercises
 * these exact document shapes against the real Firestore emulator as the
 * inventory-service identity; this file covers the pure application logic
 * (idempotency branching, quantity ground truth, conflict detection, global
 * increment arithmetic) deterministically instead.
 */

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
const mockTxSetCalls: { path: string; data: Record<string, unknown> }[] = [];
const mockTxUpdateCalls: { path: string; data: Record<string, unknown> }[] = [];

function setDocs(next: Record<string, { exists: boolean; data?: Record<string, unknown> }>) {
  mockRegistry = next;
}

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` })),
  runTransaction: vi.fn(async (_db: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: vi.fn(async (ref: { path: string }) => {
        const entry = mockRegistry[ref.path];
        return { exists: () => !!entry?.exists, data: () => entry?.data };
      }),
      set: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
        mockTxSetCalls.push({ path: ref.path, data });
        mockRegistry[ref.path] = { exists: true, data };
      }),
      update: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
        mockTxUpdateCalls.push({ path: ref.path, data });
        const existing = mockRegistry[ref.path];
        mockRegistry[ref.path] = { exists: true, data: { ...existing?.data, ...data } };
      }),
    };
    return cb(tx);
  }),
}));

function qc(overrides: Record<string, unknown> = {}) {
  return {
    id: "QC-1",
    productionId: "PRO-1",
    decision: "liberer",
    date: "2026-09-10",
    lot: "001_AROM",
    ...overrides,
  };
}

function production(overrides: Record<string, unknown> = {}) {
  return { id: "PRO-1", ...overrides };
}

beforeEach(() => {
  mockRegistry = {};
  mockTxSetCalls.length = 0;
  mockTxUpdateCalls.length = 0;
});

describe("applyQcReleaseReceipt", () => {
  it("a release with one packaged format creates stockPF, stockLotBalance, and the global stockBalance in one pass", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    expect(mockTxSetCalls.map((c) => c.path).sort()).toEqual(
      [
        "stockBalance/500ml",
        "stockLotBalance/LOT-PRO-1-QC-1-500ml",
        "stockPF/PF-IN-PRO-1-QC-1-500ml",
      ].sort(),
    );
    const stockPF = mockTxSetCalls.find((c) => c.path === "stockPF/PF-IN-PRO-1-QC-1-500ml")!.data;
    expect(stockPF).toMatchObject({
      format: "500ml",
      type: "Entrée",
      quantite: 60,
      source: "production",
      productionId: "PRO-1",
      qualityControlId: "QC-1",
      createdByUid: "actor-1",
    });
    const lotBalance = mockTxSetCalls.find(
      (c) => c.path === "stockLotBalance/LOT-PRO-1-QC-1-500ml",
    )!.data;
    expect(lotBalance).toMatchObject({
      origin: "production",
      productionId: "PRO-1",
      qualityControlId: "QC-1",
      format: "500ml",
      onHand: 60,
      reserved: 0,
      lastActorUid: "actor-1",
    });
    const globalBalance = mockTxSetCalls.find((c) => c.path === "stockBalance/500ml")!.data;
    expect(globalBalance).toMatchObject({
      format: "500ml",
      onHand: 60,
      reserved: 0,
      lastActorUid: "actor-1",
    });
  });

  it("multiple formats — one stockPF/stockLotBalance row per format, each format's own global balance created independently", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 10, q330: 20, q300: 0 }) },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result.status).toBe("success");
    if (result.status === "success")
      expect(result.formatsApplied.sort()).toEqual(["330ml", "500ml"]);
    expect(
      mockTxSetCalls
        .filter((c) => c.path.startsWith("stockPF/"))
        .map((c) => c.path)
        .sort(),
    ).toEqual(["stockPF/PF-IN-PRO-1-QC-1-330ml", "stockPF/PF-IN-PRO-1-QC-1-500ml"].sort());
    // q300 is zero — no row for it at all.
    expect(mockTxSetCalls.some((c) => c.path.includes("300ml"))).toBe(false);
  });

  it("zero/absent quantities are entirely omitted — a legacy production with no packaging data creates no fabricated stock", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({}) },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({ status: "success", formatsApplied: [], formatsAlreadyApplied: [] });
    expect(mockTxSetCalls).toHaveLength(0);
  });

  it("a quarantine decision is rejected as invalid_state — no production read, no writes", async () => {
    setDocs({ "qualityControls/QC-1": { exists: true, data: qc({ decision: "quarantaine" }) } });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "invalid_state",
      reason: "not_a_release",
      decision: "quarantaine",
    });
    expect(mockTxSetCalls).toHaveLength(0);
  });

  it("a rejeter decision is rejected as invalid_state", async () => {
    setDocs({ "qualityControls/QC-1": { exists: true, data: qc({ decision: "rejeter" }) } });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "invalid_state",
      reason: "not_a_release",
      decision: "rejeter",
    });
  });

  it("a missing qualityControls doc reports not_found", async () => {
    setDocs({});

    const result = await applyQcReleaseReceipt("QC-missing", "actor-1");

    expect(result).toEqual({ status: "not_found", reason: "quality_control_not_found" });
  });

  it("a release whose production doc is missing reports not_found", async () => {
    setDocs({ "qualityControls/QC-1": { exists: true, data: qc() } });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({ status: "not_found", reason: "production_not_found" });
  });

  it("complete Worker consequence (stockPF + stockLotBalance + stockBalance all present and consistent) — reports success with formatsAlreadyApplied, touches nothing", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 60,
          type: "Entrée",
          source: "production",
        },
      },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": {
        exists: true,
        data: { origin: "production", onHand: 60, reserved: 0 },
      },
      "stockBalance/500ml": { exists: true, data: { format: "500ml", onHand: 60, reserved: 0 } },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: [],
      formatsAlreadyApplied: ["500ml"],
    });
    expect(mockTxSetCalls).toHaveLength(0);
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  it("everything already exists and matches (stockLotBalance present, no stockBalance seeded) — reports success with formatsAlreadyApplied, no new writes at all (full lost-ack idempotency)", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 60,
          type: "Entrée",
          source: "production",
        },
      },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": {
        exists: true,
        data: { origin: "production", onHand: 60, reserved: 0 },
      },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: [],
      formatsAlreadyApplied: ["500ml"],
    });
    expect(mockTxSetCalls).toHaveLength(0);
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  it("a duplicate Worker call (same call repeated back-to-back) is a pure no-op on the second attempt", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
    });

    const first = await applyQcReleaseReceipt("QC-1", "actor-1");
    expect(first).toEqual({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    mockTxSetCalls.length = 0;
    mockTxUpdateCalls.length = 0;

    const second = await applyQcReleaseReceipt("QC-1", "actor-1");
    expect(second).toEqual({
      status: "success",
      formatsApplied: [],
      formatsAlreadyApplied: ["500ml"],
    });
    expect(mockTxSetCalls).toHaveLength(0);
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  // Partial-repair safety invariant (see qcReleaseReceipt.ts's own top doc
  // comment): a missing stockLotBalance is only safe to auto-repair
  // because stockBalance/stockLotBalance have exactly one writer in the
  // whole system — this function, always together. These two tests pin
  // that today, both when nothing else has ever touched this format's
  // global balance ("legacy stockPF only") and when OTHER lots already
  // have ("stockPF + global balance but missing lot balance"), the repair
  // is correct — the global increment is additive on top of whatever is
  // already there, never a reset, and never a guess about what that
  // existing value already includes.
  it("legacy stockPF only — stockPF exists (pre-Step-B), no stockLotBalance, no stockBalance at all yet — repairs by creating the lot balance and the global balance for the first time, using the existing stockPF's own quantity, never re-writing stockPF", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 60,
          type: "Entrée",
          source: "production",
        },
      },
      // No stockLotBalance/stockBalance yet — the partial-state case.
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    expect(mockTxSetCalls.some((c) => c.path === "stockPF/PF-IN-PRO-1-QC-1-500ml")).toBe(false); // never re-written
    expect(
      mockTxSetCalls.find((c) => c.path === "stockLotBalance/LOT-PRO-1-QC-1-500ml")?.data,
    ).toMatchObject({ onHand: 60 });
    expect(mockTxSetCalls.find((c) => c.path === "stockBalance/500ml")?.data).toMatchObject({
      onHand: 60,
    });
  });

  it("stockPF + global balance but missing lot balance — the existing global balance came from OTHER lots (the only possible source today), so this lot's repair adds on top of it rather than replacing it", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 60,
          type: "Entrée",
          source: "production",
        },
      },
      // No stockLotBalance for THIS lot, but the format's global balance
      // already has 100 on hand from some other, already-lot-balanced
      // release — the only way that value could exist under today's
      // single-writer invariant.
      "stockBalance/500ml": { exists: true, data: { format: "500ml", onHand: 100, reserved: 0 } },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    expect(mockTxSetCalls.some((c) => c.path === "stockPF/PF-IN-PRO-1-QC-1-500ml")).toBe(false);
    expect(mockTxSetCalls.some((c) => c.path === "stockBalance/500ml")).toBe(false); // update, not a fresh set
    expect(mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml")?.data).toMatchObject({
      onHand: 160, // 100 (other lots) + 60 (this lot's repair) — additive, never a guess/reset
    });
  });

  it("conflicting existing state — an existing stockPF row's quantity disagrees with the production's own field — reports conflict, no writes at all", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 61,
          type: "Entrée",
          source: "production",
        },
      },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    // Endpoint-safety hardening: `reason` is always the same stable code,
    // never an interpolated message carrying the internal document id —
    // this result is serialized straight into the HTTP response.
    expect(result).toEqual({
      status: "conflict",
      reason: "stockPF_content_mismatch",
      format: "500ml",
    });
    expect(mockTxSetCalls).toHaveLength(0);
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  it("conflicting existing state — an existing stockPF row references a different production/QC — reports conflict, no writes", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-OTHER",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 60,
          type: "Entrée",
          source: "production",
        },
      },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result.status).toBe("conflict");
    expect(mockTxSetCalls).toHaveLength(0);
  });

  it("a conflict on one format aborts the whole call — a second, otherwise-clean format is never written either (all-or-nothing)", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60, q330: 20 }) },
      "stockPF/PF-IN-PRO-1-QC-1-500ml": {
        exists: true,
        data: {
          productionId: "PRO-1",
          qualityControlId: "QC-1",
          format: "500ml",
          quantite: 99,
          type: "Entrée",
          source: "production",
        },
      },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result.status).toBe("conflict");
    expect(mockTxSetCalls.some((c) => c.path.includes("330ml"))).toBe(false);
  });

  it("the global balance's onHand accumulates across two separate releases for the same format (update path, not overwritten)", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
      "stockBalance/500ml": { exists: true, data: { format: "500ml", onHand: 100, reserved: 0 } },
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result.status).toBe("success");
    expect(mockTxSetCalls.some((c) => c.path === "stockBalance/500ml")).toBe(false); // update, not set
    expect(mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml")?.data).toMatchObject({
      onHand: 160,
    });
  });

  it("an unexpected transaction error is reported as status: error rather than thrown", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": {
        exists: true,
        data: production({ q500: "not-a-number" as unknown as number }),
      },
    });
    // A non-numeric quantity fails the `typeof qty === "number"` filter,
    // so this actually resolves as a no-format-applied success — use an
    // explicit throw instead to exercise the generic error path.
    const { runTransaction } = await import("firebase/firestore/lite");
    (runTransaction as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");
    expect(result).toEqual({ status: "error", reason: "internal_error" });
  });
});

describe("concurrency — production changes mid-transaction never leak a stale quantity into a commit", () => {
  it("a packaging edit that lands after the Worker's own read of the production doc, but before commit, forces a retry — only the retried (fresh) quantity is ever committed, never the stale one", async () => {
    setDocs({
      "qualityControls/QC-1": { exists: true, data: qc() },
      "productions/PRO-1": { exists: true, data: production({ q500: 60 }) },
    });

    const { runTransaction } = await import("firebase/firestore/lite");
    // Mirrors the shared mock's own tx shape, but run up to twice and only
    // ever merges the LAST attempt's writes into the shared registry —
    // this is what real Firestore does on a commit-time conflict: the
    // whole callback (including every read it made) is discarded and
    // re-run from scratch against current data, and only the retried
    // attempt's writes ever land. A concurrent packaging edit is injected
    // right after the first attempt's own read of `productions/PRO-1`,
    // simulating another actor correcting it mid-transaction.
    (runTransaction as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_db: unknown, cb: (tx: unknown) => Promise<unknown>) => {
        let result: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const pending = new Map<
            string,
            { op: "set" | "update"; data: Record<string, unknown> }
          >();
          const tx = {
            get: vi.fn(async (ref: { path: string }) => {
              const entry = mockRegistry[ref.path];
              const snap = { exists: () => !!entry?.exists, data: () => entry?.data };
              if (attempt === 1 && ref.path === "productions/PRO-1") {
                // The concurrent write: lands the instant after this
                // attempt's own read, so this attempt still computes
                // everything from the now-stale q500:60 it just saw.
                mockRegistry["productions/PRO-1"] = {
                  exists: true,
                  data: production({ q500: 50 }),
                };
              }
              return snap;
            }),
            set: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
              pending.set(ref.path, { op: "set", data });
            }),
            update: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
              pending.set(ref.path, { op: "update", data });
            }),
          };
          result = await cb(tx);
          if (attempt === 1) continue; // discarded — never merged, exactly like a real aborted attempt
          for (const [path, w] of pending) {
            const existing = mockRegistry[path];
            mockRegistry[path] =
              w.op === "set"
                ? { exists: true, data: w.data }
                : { exists: true, data: { ...existing?.data, ...w.data } };
          }
        }
        return result;
      },
    );

    const result = await applyQcReleaseReceipt("QC-1", "actor-1");

    expect(result).toEqual({
      status: "success",
      formatsApplied: ["500ml"],
      formatsAlreadyApplied: [],
    });
    // Only the retry's writes ever reached the registry, and it read the
    // corrected quantity (50) — the first attempt's stale 60 was
    // computed but discarded, never committed anywhere.
    expect(mockRegistry["stockPF/PF-IN-PRO-1-QC-1-500ml"]?.data).toMatchObject({ quantite: 50 });
    expect(mockRegistry["stockLotBalance/LOT-PRO-1-QC-1-500ml"]?.data).toMatchObject({
      onHand: 50,
    });
    expect(mockRegistry["stockBalance/500ml"]?.data).toMatchObject({ onHand: 50 });
  });
});
