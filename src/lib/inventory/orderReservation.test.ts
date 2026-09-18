import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelOrderReservation,
  confirmOrderReservation,
  fulfilOrderReservation,
} from "./orderReservation";

/**
 * Sprint 08, Steps C/D — unit coverage for the Worker's own transaction
 * logic, mirroring qcReleaseReceipt.test.ts's mock-registry pattern
 * exactly (module-boundary mocks of `firestore/lite`, not a live
 * emulator — AROM-Backend's own rules.test.mjs covers the real
 * trusted-write-only boundary against the emulator). Extends that same
 * mock with `getDoc`/`getDocs`/`query`/`collection`/`where` since this
 * file's own pre-transaction reads (product validation, FIFO candidate
 * discovery) use them on top of `doc`/`runTransaction`.
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

function order(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    partnerId: "PART-1",
    partnerName: "Boutique Test",
    items: [{ productId: "PRD-1", format: "500 ml", quantity: 10, name: "Jus 500ml" }],
    ...overrides,
  };
}

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

beforeEach(() => {
  mockRegistry = {};
  mockTxSetCalls.length = 0;
  mockTxUpdateCalls.length = 0;
});

describe("confirmOrderReservation", () => {
  it("reserves stock and moves pending -> confirmed when enough is available", async () => {
    setDocs({
      "orders/ORD-1": { exists: true, data: order() },
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance() },
      "stockBalance/500ml": { exists: true, data: globalBalance() },
    });

    const result = await confirmOrderReservation("ORD-1", "staff-1");

    expect(result).toEqual({ status: "success", alreadyApplied: false });
    const orderUpdate = mockTxUpdateCalls.find((c) => c.path === "orders/ORD-1");
    expect(orderUpdate?.data.status).toBe("confirmed");
    expect((orderUpdate?.data.reservation as { status: string }).status).toBe("reserved");
    const balanceUpdate = mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml");
    expect(balanceUpdate?.data.reserved).toBe(10);
    const lotUpdate = mockTxUpdateCalls.find(
      (c) => c.path === "stockLotBalance/LOT-PRO-1-QC-1-500ml",
    );
    expect(lotUpdate?.data.reserved).toBe(10);
  });

  it("reports insufficient_stock and reserves nothing when available is short — never a partial reservation", async () => {
    setDocs({
      "orders/ORD-1": {
        exists: true,
        data: order({ items: [{ productId: "PRD-1", format: "500 ml", quantity: 999 }] }),
      },
      "products/PRD-1": { exists: true, data: product() },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": { exists: true, data: lotBalance() },
      "stockBalance/500ml": { exists: true, data: globalBalance() },
    });

    const result = await confirmOrderReservation("ORD-1", "staff-1");

    expect(result.status).toBe("insufficient_stock");
    if (result.status === "insufficient_stock") {
      expect(result.shortfalls).toEqual([{ format: "500ml", requested: 999, available: 50 }]);
    }
    expect(mockTxUpdateCalls.find((c) => c.path === "orders/ORD-1")).toBeUndefined();
    expect(mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml")).toBeUndefined();
  });

  it("rejects an item referencing an unknown or inactive product rather than trusting the order's own snapshot", async () => {
    setDocs({
      "orders/ORD-1": { exists: true, data: order() },
      "products/PRD-1": { exists: true, data: product({ active: false }) },
    });

    const result = await confirmOrderReservation("ORD-1", "staff-1");
    expect(result.status).toBe("invalid_items");
  });

  it("is idempotent: retrying an already-confirmed, already-reserved order reports success without double-reserving", async () => {
    setDocs({
      "orders/ORD-1": {
        exists: true,
        data: order({
          status: "confirmed",
          reservation: {
            status: "reserved",
            items: [{ format: "500ml", quantity: 10, allocations: [] }],
            reservedAt: "x",
            reservedByUid: "staff-1",
          },
        }),
      },
    });

    const result = await confirmOrderReservation("ORD-1", "staff-1");
    expect(result).toEqual({ status: "success", alreadyApplied: true });
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  it("rejects confirming an order that is not pending (e.g. already fulfilled)", async () => {
    setDocs({ "orders/ORD-1": { exists: true, data: order({ status: "fulfilled" }) } } as never);
    const result = await confirmOrderReservation("ORD-1", "staff-1");
    expect(result.status).toBe("invalid_state");
  });

  it("reports not_found for a nonexistent order", async () => {
    setDocs({});
    const result = await confirmOrderReservation("ORD-MISSING", "staff-1");
    expect(result).toEqual({ status: "not_found", reason: "order_not_found" });
  });
});

describe("cancelOrderReservation", () => {
  function reservedOrder() {
    return order({
      status: "confirmed",
      reservation: {
        status: "reserved",
        items: [
          {
            format: "500ml",
            quantity: 10,
            allocations: [
              {
                origin: "production",
                productionId: "PRO-1",
                qualityControlId: "QC-1",
                quantity: 10,
              },
            ],
          },
        ],
        reservedAt: "2026-09-10T00:00:00.000Z",
        reservedByUid: "staff-1",
      },
    });
  }

  it("releases the reservation, decrementing reserved but never onHand", async () => {
    setDocs({
      "orders/ORD-1": { exists: true, data: reservedOrder() },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 50, reserved: 10 }) },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": {
        exists: true,
        data: lotBalance({ onHand: 50, reserved: 10 }),
      },
    });

    const result = await cancelOrderReservation("ORD-1", "staff-1");

    expect(result).toEqual({ status: "success", alreadyApplied: false });
    expect(mockTxUpdateCalls.find((c) => c.path === "orders/ORD-1")?.data.status).toBe("cancelled");
    const balance = mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml");
    expect(balance?.data.reserved).toBe(0);
    expect(balance?.data.onHand).toBeUndefined();
  });

  it("is idempotent: a retry that finds the reservation already released no-ops rather than double-releasing", async () => {
    setDocs({
      "orders/ORD-1": {
        exists: true,
        data: order({
          status: "cancelled",
          reservation: { status: "released", items: [], reservedAt: "x", reservedByUid: "staff-1" },
        }),
      },
    });

    const result = await cancelOrderReservation("ORD-1", "staff-1");
    expect(result).toEqual({ status: "success", alreadyApplied: true });
    expect(mockTxUpdateCalls).toHaveLength(0);
  });

  it("rejects cancelling an order with no active reservation", async () => {
    setDocs({ "orders/ORD-1": { exists: true, data: order({ status: "pending" }) } });
    const result = await cancelOrderReservation("ORD-1", "staff-1");
    expect(result.status).toBe("invalid_state");
  });
});

describe("fulfilOrderReservation", () => {
  function reservedOrder() {
    return order({
      status: "confirmed",
      reservation: {
        status: "reserved",
        items: [
          {
            format: "500ml",
            quantity: 10,
            allocations: [
              {
                origin: "production",
                productionId: "PRO-1",
                qualityControlId: "QC-1",
                quantity: 10,
              },
            ],
          },
        ],
        reservedAt: "2026-09-10T00:00:00.000Z",
        reservedByUid: "staff-1",
      },
    });
  }

  it("closes the reservation, decrements onHand and reserved exactly once, writes one Sortie row and one vente", async () => {
    setDocs({
      "orders/ORD-1": { exists: true, data: reservedOrder() },
      "stockBalance/500ml": { exists: true, data: globalBalance({ onHand: 50, reserved: 10 }) },
      "stockLotBalance/LOT-PRO-1-QC-1-500ml": {
        exists: true,
        data: lotBalance({ onHand: 50, reserved: 10 }),
      },
    });

    const result = await fulfilOrderReservation("ORD-1", "staff-1");

    expect(result).toEqual({ status: "success", alreadyApplied: false });
    const orderUpdate = mockTxUpdateCalls.find((c) => c.path === "orders/ORD-1");
    expect(orderUpdate?.data.status).toBe("fulfilled");
    const balance = mockTxUpdateCalls.find((c) => c.path === "stockBalance/500ml");
    expect(balance?.data.onHand).toBe(40);
    expect(balance?.data.reserved).toBe(0);
    const sortie = mockTxSetCalls.find((c) => c.path === "stockPF/PF-OUT-ORD-1-PRO-1-500ml");
    expect(sortie?.data.type).toBe("Sortie");
    expect(sortie?.data.quantite).toBe(10);
    const vente = mockTxSetCalls.find((c) => c.path === "ventes/VTE-ORD-ORD-1-0");
    expect(vente).toBeDefined();
  });

  it("is idempotent: a retry against an already-fulfilled order reports success without a second deduction", async () => {
    setDocs({
      "orders/ORD-1": {
        exists: true,
        data: order({
          status: "fulfilled",
          reservation: {
            status: "fulfilled",
            items: [],
            reservedAt: "x",
            reservedByUid: "staff-1",
          },
        }),
      },
    });

    const result = await fulfilOrderReservation("ORD-1", "staff-1");
    expect(result).toEqual({ status: "success", alreadyApplied: true });
    expect(mockTxSetCalls).toHaveLength(0);
  });

  it("rejects fulfilling an order with no active reservation", async () => {
    setDocs({ "orders/ORD-1": { exists: true, data: order({ status: "pending" }) } });
    const result = await fulfilOrderReservation("ORD-1", "staff-1");
    expect(result.status).toBe("invalid_state");
  });
});
