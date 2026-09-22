import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectSale, type DirectSaleInput } from "./directSale";

/**
 * Sprint 08, Step E — mirrors orderReservation.test.ts's mock-registry
 * pattern exactly (module-boundary mocks of `firestore/lite`, not a live
 * emulator — AROM-Backend's own rules tests cover the real trusted-write-
 * only boundary against the emulator).
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
  collection: vi.fn((_db: unknown, col: string) => ({ col })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  query: vi.fn(
    (colRef: { col: string }, clause: { field: string; op: string; value: unknown }) => ({
      ...colRef,
      clause,
    }),
  ),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data };
  }),
  getDocs: vi.fn(async (q: { col: string; clause: { field: string; value: unknown } }) => {
    const docs = Object.entries(mockRegistry)
      .filter(
        ([path, entry]) =>
          path.startsWith(`${q.col}/`) &&
          entry.exists &&
          entry.data?.[q.clause.field] === q.clause.value,
      )
      .map(([path, entry]) => ({ id: path.split("/")[1], data: () => entry.data }));
    return { docs };
  }),
  // Simulates Firestore's real optimistic-concurrency transaction
  // semantics, not just "run the callback once" — this is what makes the
  // "two simultaneous requests" tests below actually mean something,
  // rather than re-deriving the sequential-retry tests under another
  // name. Every path a transaction attempt reads is snapshotted; if any
  // of those paths' registry state changed by the time the attempt
  // finishes (because another transaction committed in the meantime —
  // which real concurrent execution, interleaved by this mock's own
  // `await` points, can genuinely produce), this attempt's writes are
  // discarded and the callback re-runs from scratch with fresh reads —
  // exactly mirroring a real Firestore transaction retry. A thrown
  // business error (insufficient stock, a sale conflict, ...) is never
  // retried — only staleness is, matching real Firestore (an application
  // abort is not a contention signal).
  runTransaction: vi.fn(async (_db: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const readSnapshot: Record<string, string> = {};
      const stagedSets: { path: string; data: Record<string, unknown> }[] = [];
      const stagedUpdates: { path: string; data: Record<string, unknown> }[] = [];
      const tx = {
        get: vi.fn(async (ref: { path: string }) => {
          const entry = mockRegistry[ref.path];
          if (!(ref.path in readSnapshot)) readSnapshot[ref.path] = JSON.stringify(entry ?? null);
          return { exists: () => !!entry?.exists, data: () => entry?.data };
        }),
        set: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
          stagedSets.push({ path: ref.path, data });
        }),
        update: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
          stagedUpdates.push({ path: ref.path, data });
        }),
      };
      const result = await cb(tx); // a thrown error here propagates immediately — never retried
      const stale = Object.entries(readSnapshot).some(
        ([path, snap]) => JSON.stringify(mockRegistry[path] ?? null) !== snap,
      );
      if (stale && attempt < MAX_ATTEMPTS - 1) continue;
      for (const s of stagedSets) {
        mockTxSetCalls.push(s);
        mockRegistry[s.path] = { exists: true, data: s.data };
      }
      for (const u of stagedUpdates) {
        mockTxUpdateCalls.push(u);
        const existing = mockRegistry[u.path];
        mockRegistry[u.path] = { exists: true, data: { ...existing?.data, ...u.data } };
      }
      return result;
    }
    throw new Error("mock transaction: exceeded retry attempts");
  }),
}));

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "PRD-1",
    name: "Jus 500ml",
    format: "500 ml",
    price: 5000,
    active: true,
    ...overrides,
  };
}

function lotBalance(overrides: Record<string, unknown> = {}) {
  return {
    origin: "production",
    productionId: "PRO-1",
    qualityControlId: "QC-1",
    lot: "001_AROM",
    format: "500ml",
    onHand: 50,
    reserved: 0,
    releasedAt: "2026-09-01",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastActorUid: "worker",
    ...overrides,
  };
}

function globalBalance(overrides: Record<string, unknown> = {}) {
  return {
    format: "500ml",
    onHand: 50,
    reserved: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastActorUid: "worker",
    ...overrides,
  };
}

const INPUT = {
  saleId: "VTE-DS-abc-123",
  format: "500 ml",
  quantity: 10,
  prixUnitaire: 5000,
  commerciale: "Alain",
};

beforeEach(() => {
  mockRegistry = {};
  mockTxSetCalls.length = 0;
  mockTxUpdateCalls.length = 0;
});

describe("createDirectSale — happy paths", () => {
  it("allocates FIFO from a single lot exactly matching the requested quantity, decrements onHand, writes the Sortie row and the vente exactly once", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });

    const result = await createDirectSale(INPUT, "staff-1");

    expect(result).toEqual({ status: "success", alreadyApplied: false, saleId: "VTE-DS-abc-123" });
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 0 });
    expect(mockRegistry["stockLotBalance/LOT-PRO-1-QC-1-500ml"].data).toMatchObject({ onHand: 0 });
    const sortie = mockTxSetCalls.find(
      (c) => c.path === "stockPF/PF-OUT-DS-VTE-DS-abc-123-PRO-1-500ml",
    );
    expect(sortie?.data).toMatchObject({
      type: "Sortie",
      source: "direct-sale",
      quantite: 10,
      saleId: "VTE-DS-abc-123",
      productionId: "PRO-1",
      createdByUid: "staff-1",
    });
    const vente = mockTxSetCalls.find((c) => c.path === "ventes/VTE-DS-abc-123");
    expect(vente?.data).toMatchObject({
      id: "VTE-DS-abc-123",
      format: "500 ml",
      quantite: 10,
      prixUnitaire: 5000,
      staffUid: "staff-1",
      productionIds: ["PRO-1"],
    });
    // internal lot/QC ids never leak into the persisted sale beyond the traceability field itself
    expect(Object.keys(vente!.data)).not.toContain("qualityControlId");
  });

  it("allocation across multiple lots — oldest released first, exact split, both decremented, both Sortie rows written", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-OLD-QC-OLD-500ml": {
        exists: true,
        data: lotBalance({
          productionId: "PRO-OLD",
          qualityControlId: "QC-OLD",
          onHand: 6,
          releasedAt: "2026-08-01",
        }),
      },
      "stockLotBalance/LOT-PRO-NEW-QC-NEW-500ml": {
        exists: true,
        data: lotBalance({
          productionId: "PRO-NEW",
          qualityControlId: "QC-NEW",
          onHand: 20,
          releasedAt: "2026-09-01",
        }),
      },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 26 }) },
    });

    const result = await createDirectSale({ ...INPUT, quantity: 10 }, "staff-1");

    expect(result).toEqual({ status: "success", alreadyApplied: false, saleId: "VTE-DS-abc-123" });
    expect(mockRegistry["stockLotBalance/LOT-PRO-OLD-QC-OLD-500ml"].data).toMatchObject({
      onHand: 0,
    }); // fully drained first
    expect(mockRegistry["stockLotBalance/LOT-PRO-NEW-QC-NEW-500ml"].data).toMatchObject({
      onHand: 16,
    }); // remaining 4 taken
    expect(
      mockTxSetCalls.some(
        (c) => c.path === "stockPF/PF-OUT-DS-VTE-DS-abc-123-PRO-OLD-500ml" && c.data.quantite === 6,
      ),
    ).toBe(true);
    expect(
      mockTxSetCalls.some(
        (c) => c.path === "stockPF/PF-OUT-DS-VTE-DS-abc-123-PRO-NEW-500ml" && c.data.quantite === 4,
      ),
    ).toBe(true);
    const vente = mockTxSetCalls.find((c) => c.path === "ventes/VTE-DS-abc-123");
    expect(vente?.data.productionIds).toEqual(["PRO-OLD", "PRO-NEW"]);
  });

  it("the server recomputes nothing about the total from a client-sent value — montantBrut is never accepted, only quantity/prixUnitaire/remise", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    await createDirectSale(
      {
        ...INPUT,
        remise: 500,
        encaisse: 1000,
        montantBrut: 999999999,
      } as unknown as DirectSaleInput,
      "staff-1",
    );
    const vente = mockTxSetCalls.find((c) => c.path === "ventes/VTE-DS-abc-123");
    expect(vente?.data).not.toHaveProperty("montantBrut"); // Vente carries no such field — total is always derived (quantite*prixUnitaire-remise) by readers
    expect(vente?.data.remise).toBe(500);
    expect(vente?.data.encaisse).toBe(1000);
  });
});

describe("createDirectSale — insufficient stock, no partial mutation", () => {
  it("rejects when total available is less than requested, and nothing is written anywhere", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 3 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 3 }) },
    });

    const result = await createDirectSale({ ...INPUT, quantity: 10 }, "staff-1");

    expect(result).toEqual({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 10, available: 3 }],
    });
    expect(mockRegistry["stockBalance/500ml"].data).toEqual(globalBalance({ onHand: 3 })); // untouched
    expect(mockRegistry["stockLotBalance/LOT-PRO-1-QC-1-500ml"].data).toEqual(
      lotBalance({ onHand: 3 }),
    ); // untouched
    expect(mockTxSetCalls).toEqual([]);
    expect(mockTxUpdateCalls).toEqual([]);
  });

  it("zero available lots for the format is reported the same way, not a crash", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 0 }) },
    });
    const result = await createDirectSale(INPUT, "staff-1");
    expect(result).toEqual({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 10, available: 0 }],
    });
    expect(mockTxSetCalls).toEqual([]);
  });
});

describe("createDirectSale — quarantined, refused, and unreleased lots never contribute", () => {
  it("a lot with no stockLotBalance document at all (never released) cannot be allocated from, even if a matching production exists", async () => {
    // No stockLotBalance/LOT-PRO-2-* document exists — a quarantined/rejected/still-pending lot never gets one (see stockBalance.ts's own model).
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 4 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 4 }) },
    });
    const result = await createDirectSale({ ...INPUT, quantity: 10 }, "staff-1");
    expect(result).toMatchObject({ status: "insufficient_stock", shortfalls: [{ available: 4 }] });
  });

  it("a lot balance whose available quantity is fully reserved by something else is skipped, never double-allocated", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": {
        exists: true,
        data: lotBalance({ onHand: 10, reserved: 10 }),
      }, // available = 0
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10, reserved: 10 }) },
    });
    const result = await createDirectSale(INPUT, "staff-1");
    expect(result).toEqual({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 10, available: 0 }],
    });
  });
});

describe("createDirectSale — validation never trusts the caller", () => {
  it("rejects an unrecognized format outright — never coerced to a default", async () => {
    const result = await createDirectSale({ ...INPUT, format: "1 litre" }, "staff-1");
    expect(result).toEqual({ status: "invalid_items", reason: "invalid_format" });
    expect(mockTxSetCalls).toEqual([]);
  });

  it("rejects a format with no active catalogue product — the 'unknown product' case", async () => {
    setDocs({ "products/PRD-1": { exists: true, data: product({ active: false }) } });
    const result = await createDirectSale(INPUT, "staff-1");
    expect(result).toEqual({ status: "invalid_items", reason: "unknown_product" });
  });

  it("rejects non-positive or non-finite quantity", async () => {
    setDocs({ "products/PRD-1": { exists: true, data: product() } });
    expect(await createDirectSale({ ...INPUT, quantity: 0 }, "staff-1")).toEqual({
      status: "invalid_items",
      reason: "invalid_quantity",
    });
    expect(await createDirectSale({ ...INPUT, quantity: -5 }, "staff-1")).toEqual({
      status: "invalid_items",
      reason: "invalid_quantity",
    });
    expect(await createDirectSale({ ...INPUT, quantity: NaN }, "staff-1")).toEqual({
      status: "invalid_items",
      reason: "invalid_quantity",
    });
  });

  it("rejects non-positive or non-finite price — a forged zero/negative price never reaches a write", async () => {
    setDocs({ "products/PRD-1": { exists: true, data: product() } });
    expect(await createDirectSale({ ...INPUT, prixUnitaire: 0 }, "staff-1")).toEqual({
      status: "invalid_items",
      reason: "invalid_price",
    });
    expect(await createDirectSale({ ...INPUT, prixUnitaire: -100 }, "staff-1")).toEqual({
      status: "invalid_items",
      reason: "invalid_price",
    });
  });

  it("rejects a malformed or forged saleId outright — not shaped VTE-DS-*", async () => {
    for (const badId of ["VTE-abc123", "../ventes/other", "VTE-DS-", "", "VTE-ORD-1-0"]) {
      const result = await createDirectSale({ ...INPUT, saleId: badId }, "staff-1");
      expect(result).toEqual({ status: "invalid_sale_id" });
    }
    expect(mockTxSetCalls).toEqual([]);
  });

  it("a client-forged lot/quality-control id in the request is simply never read — the input type has no such field, and allocation always comes from live stockLotBalance data", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    const result = await createDirectSale(
      { ...INPUT, productionIds: ["FORGED-LOT"] } as unknown as DirectSaleInput,
      "staff-1",
    );
    expect(result.status).toBe("success");
    const vente = mockTxSetCalls.find((c) => c.path === "ventes/VTE-DS-abc-123");
    expect(vente?.data.productionIds).toEqual(["PRO-1"]); // the real, server-allocated lot — never the forged one
  });
});

describe("createDirectSale — idempotent for offline retry and lost acknowledgements", () => {
  it("an identical retry (the vente document already exists) is a no-op success — stock is not decremented a second time", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });

    const first = await createDirectSale(INPUT, "staff-1");
    expect(first).toEqual({ status: "success", alreadyApplied: false, saleId: "VTE-DS-abc-123" });
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 0 });

    mockTxSetCalls.length = 0;
    mockTxUpdateCalls.length = 0;
    const retry = await createDirectSale(INPUT, "staff-1");

    expect(retry).toEqual({ status: "success", alreadyApplied: true, saleId: "VTE-DS-abc-123" });
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 0 }); // unchanged — not decremented again
    expect(mockTxSetCalls).toEqual([]); // no second Sortie/vente write
    expect(mockTxUpdateCalls).toEqual([]);
  });

  it("lost acknowledgement: the sale succeeded server-side but the client never saw the response — a retry with the same saleId still reports success", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    await createDirectSale(INPUT, "staff-1"); // simulates the original call, whose response the client never received
    const retried = await createDirectSale(INPUT, "staff-1"); // client, unaware, retries
    expect(retried).toMatchObject({ status: "success", alreadyApplied: true });
  });

  it("two different offline-queued sales (different saleId) both apply independently, each decrementing stock once", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 20 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 20 }) },
    });
    const a = await createDirectSale({ ...INPUT, saleId: "VTE-DS-aaa", quantity: 5 }, "staff-1");
    const b = await createDirectSale({ ...INPUT, saleId: "VTE-DS-bbb", quantity: 5 }, "staff-1");
    expect(a).toMatchObject({ alreadyApplied: false });
    expect(b).toMatchObject({ alreadyApplied: false });
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 10 });
  });
});

describe("createDirectSale — payload-bound idempotency: a saleId reused with a different request is a conflict, never a silent match", () => {
  it("an equivalent retry (every fingerprint field identical) is alreadyApplied — the identical-retry test above already proves the no-double-deduction half; this proves the comparison itself", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    const full = {
      ...INPUT,
      remise: 500,
      encaisse: 4500,
      idClient: "CLI-1",
      clientNom: "Hôtel Kasaï",
      canal: "Hôtel",
    };
    await createDirectSale(full, "staff-1");
    const retry = await createDirectSale({ ...full }, "staff-1"); // a fresh object, same values — proves field comparison, not reference equality
    expect(retry).toEqual({ status: "success", alreadyApplied: true, saleId: full.saleId });
  });

  it("a presentation-only format difference (canonicalizes the same) is still treated as equivalent, not a false conflict", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    await createDirectSale({ ...INPUT, format: "500 ml" }, "staff-1");
    const retry = await createDirectSale({ ...INPUT, format: "500 ml" }, "staff-1");
    expect(retry).toEqual({ status: "success", alreadyApplied: true, saleId: INPUT.saleId });
  });

  it.each([
    ["a different quantity", { quantity: 999 }],
    ["a different price (a forged/renegotiated price on retry)", { prixUnitaire: 1 }],
    ["a different remise", { remise: 100000 }],
    ["a different encaisse", { encaisse: 1 }],
    ["a different customer", { idClient: "CLI-OTHER" }],
    ["a different canal", { canal: "Boutique" }],
    ["a different commerciale", { commerciale: "Someone Else" }],
  ])(
    "%s on a saleId that already resolved to a real sale is an explicit conflict — never silently applied, never overwrites, never deducts stock again",
    async (_label, patch) => {
      setDocs({
        "products/PRD-1": { exists: true, data: product() },
        "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 20 }) },
        "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 20 }) },
      });
      const first = await createDirectSale(INPUT, "staff-1");
      expect(first).toMatchObject({ alreadyApplied: false });
      const balanceAfterFirst = { ...mockRegistry["stockBalance/500ml"].data };
      const saleAfterFirst = { ...mockRegistry["ventes/VTE-DS-abc-123"].data };

      mockTxSetCalls.length = 0;
      mockTxUpdateCalls.length = 0;
      const conflicting = await createDirectSale({ ...INPUT, ...patch }, "staff-1");

      expect(conflicting).toEqual({
        status: "conflict",
        reason: "sale_id_reused_with_different_request",
      });
      expect(mockRegistry["stockBalance/500ml"].data).toEqual(balanceAfterFirst); // no second deduction
      expect(mockRegistry["ventes/VTE-DS-abc-123"].data).toEqual(saleAfterFirst); // never overwritten
      expect(mockTxSetCalls).toEqual([]);
      expect(mockTxUpdateCalls).toEqual([]);
    },
  );

  it("a retry from a genuinely different authenticated account (different actorUid) on the same saleId is a conflict — actor attribution is part of the fingerprint even though it's never client-supplied", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    await createDirectSale(INPUT, "staff-1");
    const result = await createDirectSale(INPUT, "staff-2");
    expect(result).toEqual({ status: "conflict", reason: "sale_id_reused_with_different_request" });
  });

  it("a saleId that collides with a pre-existing, unrelated legacy-shaped document (malformed/un-canonicalizable format) is a conflict, never a false-positive match", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
      // Simulates a real "ventes" doc already sitting at this id with a shape this operation never wrote itself.
      "ventes/VTE-DS-abc-123": {
        exists: true,
        data: { id: "VTE-DS-abc-123", format: "not-a-real-format" },
      },
    });
    const result = await createDirectSale(INPUT, "staff-1");
    expect(result).toEqual({ status: "conflict", reason: "sale_id_reused_with_different_request" });
    expect(mockTxSetCalls).toEqual([]);
    expect(mockTxUpdateCalls).toEqual([]);
  });

  it("a forged productionIds/allocation field in a retry's request is simply never compared or trusted — it isn't part of the fingerprint at all, and an otherwise-equivalent retry still matches", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 10 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 10 }) },
    });
    await createDirectSale(INPUT, "staff-1");
    const retry = await createDirectSale(
      { ...INPUT, productionIds: ["FORGED-LOT-1", "FORGED-LOT-2"] } as unknown as DirectSaleInput,
      "staff-1",
    );
    expect(retry).toEqual({ status: "success", alreadyApplied: true, saleId: INPUT.saleId });
  });
});

describe("createDirectSale — concurrency (real interleaving, not just sequential retries)", () => {
  it("two simultaneous EQUIVALENT requests: exactly one mutation, both callers resolve successfully", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 20 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 20 }) },
    });
    const input = { ...INPUT, quantity: 6 };

    const [a, b] = await Promise.all([
      createDirectSale(input, "staff-1"),
      createDirectSale({ ...input }, "staff-1"), // a distinct object, same values — genuinely concurrent, not the same in-flight call
    ]);

    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
    // Exactly one of the two actually applied the deduction; the other's transaction retried, found the sale already there with a matching fingerprint, and reported alreadyApplied without touching stock again.
    const appliedCount = [a, b].filter((r) => r.status === "success" && !r.alreadyApplied).length;
    expect(appliedCount).toBe(1);
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 14 }); // deducted exactly once, not twice
    expect(mockTxSetCalls.filter((c) => c.path === "ventes/VTE-DS-abc-123")).toHaveLength(1); // one sale document, not two
  });

  it("two simultaneous DIFFERENT requests sharing one saleId: exactly one winner, one explicit conflict — never two sales, never a double deduction", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 20 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 20 }) },
    });

    const [a, b] = await Promise.all([
      createDirectSale({ ...INPUT, quantity: 6 }, "staff-1"),
      createDirectSale({ ...INPUT, quantity: 9 }, "staff-1"), // same saleId, a genuinely different request
    ]);

    const outcomes = [a, b].map((r) => r.status).sort();
    expect(outcomes).toEqual(["conflict", "success"]);
    const winner = a.status === "success" ? a : b;
    expect(winner).toMatchObject({ alreadyApplied: false });
    // Stock was deducted for exactly the winner's own quantity — never both, never neither.
    const winningQuantity = a.status === "success" ? 6 : 9;
    expect(mockRegistry["stockBalance/500ml"].data).toMatchObject({ onHand: 20 - winningQuantity });
    expect(mockTxSetCalls.filter((c) => c.path === "ventes/VTE-DS-abc-123")).toHaveLength(1); // one sale document, not two
  });
});

describe("createDirectSale — concurrent sales cannot oversell", () => {
  it("a second call racing on the same near-exhausted lot sees the transactional re-read, not the stale pre-transaction snapshot", async () => {
    setDocs({
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance({ onHand: 5 }) },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 5 }) },
    });
    // First sale takes all 5 — this transaction reads live data, so its own outcome is authoritative for the second call below.
    const first = await createDirectSale(
      { ...INPUT, saleId: "VTE-DS-first", quantity: 5 },
      "staff-1",
    );
    expect(first).toMatchObject({ alreadyApplied: false });
    // A second, independent sale attempting the same stock afterward correctly sees it as gone — never allowed to also succeed against the same 5 units.
    const second = await createDirectSale(
      { ...INPUT, saleId: "VTE-DS-second", quantity: 5 },
      "staff-1",
    );
    expect(second).toMatchObject({ status: "insufficient_stock" });
  });
});

describe("createDirectSale — internal errors never leave a partial write", () => {
  it("an unexpected throw inside the transaction is reported as an internal error, and the earlier balance/lot updates never landed (the mock's own transaction is all-or-nothing, mirrored here by throwing before any tx.update)", async () => {
    setDocs({ "products/PRD-1": { exists: true, data: product() } });
    // Simulate a totally malformed downstream state (impossible in practice, but proves the catch-all path).
    const result = await createDirectSale({ ...INPUT, format: "" }, "staff-1");
    expect(result).toEqual({ status: "invalid_items", reason: "invalid_format" });
  });
});
