import { describe, expect, it } from "vitest";
import { allocateFifo, availableQuantity, fifoCompare } from "./stockBalance";
import type { StockLotBalance } from "./stockBalance";

/**
 * Sprint 08, Steps C/D — smoke coverage for this repo's own copy of the
 * FIFO algorithm (hand-kept in sync with AROM-Mobile's
 * `src/features/stockBalance/fifo.ts`, which already carries the full,
 * exhaustive test suite for this exact logic — see that repo's
 * `stockBalanceFifo.test.ts`). This file only proves the port is
 * behaviorally identical, not a second full re-derivation of the algorithm's
 * own correctness.
 */

function lot(
  overrides: Partial<StockLotBalance> & { id: string },
): StockLotBalance & { id: string } {
  return {
    origin: "production",
    productionId: overrides.id,
    qualityControlId: `QC-${overrides.id}`,
    lot: overrides.id,
    format: "500ml",
    onHand: 0,
    reserved: 0,
    releasedAt: "2026-08-01",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActorUid: "worker",
    ...overrides,
  } as StockLotBalance & { id: string };
}

describe("stockBalance.ts (AROM-Production's port)", () => {
  it("orders legacy-opening stock before production lots regardless of date", () => {
    const legacy = {
      id: "L1",
      origin: "legacy_opening" as const,
      legacyOpeningId: "L1",
      lot: "x",
      format: "500ml" as const,
      onHand: 5,
      reserved: 0,
      cutoverAt: "2026-09-01",
      updatedAt: "x",
      lastActorUid: "w",
    };
    const production = lot({ id: "P1", releasedAt: "2020-01-01", onHand: 5 });
    expect(fifoCompare(legacy, production)).toBeLessThan(0);
  });

  it("spans multiple lots to cover one request, oldest released first", () => {
    const older = lot({ id: "OLD", releasedAt: "2026-01-01", onHand: 5 });
    const newer = lot({ id: "NEW", releasedAt: "2026-02-01", onHand: 10 });
    const allocations = allocateFifo([newer, older], 8);
    expect(allocations).toEqual([
      { origin: "production", productionId: "OLD", qualityControlId: "QC-OLD", quantity: 5 },
      { origin: "production", productionId: "NEW", qualityControlId: "QC-NEW", quantity: 3 },
    ]);
  });

  it("returns null (never a partial allocation) when combined available is short", () => {
    const a = lot({ id: "A", onHand: 3 });
    expect(allocateFifo([a], 10)).toBeNull();
  });

  it("availableQuantity is onHand - reserved", () => {
    expect(availableQuantity({ onHand: 10, reserved: 4 })).toBe(6);
  });
});
