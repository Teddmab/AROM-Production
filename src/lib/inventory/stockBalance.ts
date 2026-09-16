import type { StockFormat } from "@/lib/erp/stockFormat";

/**
 * Sprint 08, Step A schema — hand-kept in sync with AROM-Mobile's
 * `src/features/stockBalance/model.ts` (no shared package between the
 * two repos; three interfaces don't justify creating one). This copy is
 * the one the trusted server routes (Steps C/D/E, this repo) actually
 * write against — AROM-Mobile's own copy is read-only display code and
 * never writes these collections itself. See
 * AROM-Documentation/automation-engine.md's "Reservation and balance
 * projections" section for the full design.
 */

export interface StockBalance {
  format: StockFormat;
  onHand: number;
  reserved: number;
  updatedAt: string;
  lastActorUid: string;
}

export type StockLotBalance = StockLotBalanceProduction | StockLotBalanceLegacyOpening;

export interface StockLotBalanceProduction {
  origin: "production";
  productionId: string;
  qualityControlId: string;
  lot: string;
  format: StockFormat;
  onHand: number;
  reserved: number;
  releasedAt: string;
  updatedAt: string;
  lastActorUid: string;
}

export interface StockLotBalanceLegacyOpening {
  origin: "legacy_opening";
  legacyOpeningId: string;
  lot: string;
  format: StockFormat;
  onHand: number;
  reserved: number;
  cutoverAt: string;
  updatedAt: string;
  lastActorUid: string;
}

export function availableQuantity(balance: { onHand: number; reserved: number }): number {
  return balance.onHand - balance.reserved;
}

/** Same allocation order as AROM-Mobile's fifo.ts: legacy-opening stock first always, then production lots by releasedAt ascending, tie-broken by document id. */
export function fifoCompare(
  a: Pick<StockLotBalance, "origin"> & { releasedAt?: string; cutoverAt?: string; id: string },
  b: Pick<StockLotBalance, "origin"> & { releasedAt?: string; cutoverAt?: string; id: string },
): number {
  const aLegacy = a.origin === "legacy_opening";
  const bLegacy = b.origin === "legacy_opening";
  if (aLegacy !== bLegacy) return aLegacy ? -1 : 1;

  const aDate = aLegacy ? a.cutoverAt : a.releasedAt;
  const bDate = bLegacy ? b.cutoverAt : b.releasedAt;
  if (aDate !== bDate) return (aDate ?? "") < (bDate ?? "") ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type FifoAllocation =
  | { origin: "production"; productionId: string; qualityControlId: string; quantity: number }
  | { origin: "legacy_opening"; legacyOpeningId: string; quantity: number };

type FifoCandidate = StockLotBalance & { id: string };

/** Pure allocator — never mutates inputs, never returns a partial result (null instead). */
export function allocateFifo(
  candidates: FifoCandidate[],
  requestedQuantity: number,
): FifoAllocation[] | null {
  const ordered = [...candidates].sort(fifoCompare);
  const allocations: FifoAllocation[] = [];
  let remaining = requestedQuantity;

  for (const candidate of ordered) {
    if (remaining <= 0) break;
    const available = availableQuantity(candidate);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    allocations.push(
      candidate.origin === "legacy_opening"
        ? { origin: "legacy_opening", legacyOpeningId: candidate.legacyOpeningId, quantity: take }
        : {
            origin: "production",
            productionId: candidate.productionId,
            qualityControlId: candidate.qualityControlId,
            quantity: take,
          },
    );
    remaining -= take;
  }

  return remaining === 0 ? allocations : null;
}

export function productionLotBalanceDocId(
  productionId: string,
  qualityControlId: string,
  format: StockFormat,
): string {
  return `LOT-${productionId}-${qualityControlId}-${format}`;
}

export function legacyOpeningBalanceDocId(cutoverDate: string, format: StockFormat): string {
  return `LEGACY-OPENING-${cutoverDate}-${format}`;
}
