import { collection, doc, getDocs, query, runTransaction, where } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { toStockFormat, type StockFormat } from "@/lib/erp/stockFormat";
import {
  allocateFifo,
  availableQuantity,
  productionLotBalanceDocId,
  type FifoAllocation,
  type StockLotBalance,
} from "./stockBalance";

/**
 * Sprint 08, Steps C/D — order confirmation, cancellation, and fulfilment.
 * Implements exactly the architecture approved in
 * AROM-Documentation/automation-engine.md's "Reservation and balance
 * projections" section — see that doc for the full design rationale.
 * Never called directly; only from this repo's own
 * `/api/inventory/{confirm-order,cancel-order,fulfil-order}` routes,
 * which verify the caller first.
 *
 * FIFO candidate discovery: a Firestore transaction can only `get()` a
 * document by an already-known reference, never run a query — so the
 * list of candidate `stockLotBalance` documents for a format is queried
 * *outside* the transaction first (every lot balance for that format;
 * this business runs at a scale where that's a handful of documents, not
 * a paginated concern), then every one of those specific references is
 * re-read with `tx.get()` inside the transaction for the actual
 * allocation — so a lot that became unavailable in the gap is simply
 * re-read as unavailable and skipped by `allocateFifo`, never allocated
 * from stale data. If the re-read set can no longer cover the request,
 * the whole transaction aborts as insufficient stock — a legitimate
 * "someone else already took it" outcome, not a bug.
 */

interface OrderItemDoc {
  productId?: string;
  format?: string;
  quantity?: number;
}

interface OrderDoc {
  id: string;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  items: OrderItemDoc[];
  partnerId?: string;
  partnerName?: string;
  createdAt?: string;
  payment?: { method?: string; status?: string };
  reservation?: {
    status: "reserved" | "released" | "fulfilled";
    items: { format: StockFormat; quantity: number; allocations: FifoAllocation[] }[];
    reservedAt: string;
    reservedByUid: string;
  };
}

interface ProductDoc {
  id: string;
  format?: string;
  active?: boolean;
}

class NotFoundError extends Error {
  constructor(public reason: "order_not_found") {
    super(reason);
  }
}
class InvalidStateError extends Error {
  constructor(
    public reason: "not_pending" | "not_confirmed" | "no_reservation",
    public status: string,
  ) {
    super(`order is not in the expected state (${status})`);
  }
}
class InvalidItemsError extends Error {
  constructor(
    public reason: "unknown_product" | "stale_price_or_format" | "invalid_format",
    public productId?: string,
  ) {
    super(reason);
  }
}
class InsufficientStockError extends Error {
  constructor(public shortfalls: { format: StockFormat; requested: number; available: number }[]) {
    super("insufficient stock");
  }
}

type ReservationOutcome =
  | { status: "success"; alreadyApplied: boolean }
  | { status: "not_found"; reason: "order_not_found" }
  | { status: "invalid_state"; reason: string; orderStatus: string }
  | { status: "invalid_items"; reason: string; productId?: string }
  | {
      status: "insufficient_stock";
      shortfalls: { format: StockFormat; requested: number; available: number }[];
    }
  | { status: "error"; reason: "internal_error" };

/** Aggregates an order's items by canonical format, validating every productId against live `products` data — never the order's own item.format snapshot for this decision, only for display. */
async function aggregateAndValidateItems(items: OrderItemDoc[]): Promise<Map<StockFormat, number>> {
  const byFormat = new Map<StockFormat, number>();
  for (const item of items) {
    const productId = item.productId;
    const quantity = item.quantity;
    if (!productId || typeof quantity !== "number" || quantity <= 0) {
      throw new InvalidItemsError("invalid_format", productId);
    }
    const productSnap = await getDocsSingle(productId);
    if (!productSnap || productSnap.active !== true) {
      throw new InvalidItemsError("unknown_product", productId);
    }
    const canonical = toStockFormat(productSnap.format ?? "");
    if (!canonical) throw new InvalidItemsError("stale_price_or_format", productId);
    byFormat.set(canonical, (byFormat.get(canonical) ?? 0) + quantity);
  }
  return byFormat;
}

async function getDocsSingle(productId: string): Promise<ProductDoc | null> {
  const { getDoc } = await import("firebase/firestore/lite");
  const snap = await getDoc(doc(serverDb, "products", productId));
  return snap.exists()
    ? ({ id: productId, ...(snap.data() as Record<string, unknown>) } as ProductDoc)
    : null;
}

/** Every stockLotBalance document currently on record for one format — queried outside the transaction, re-read inside it (see this file's own top comment). Exported for reuse by directSale.ts (Sprint 08, Step E), which needs the identical pre-transaction discovery step. */
export async function candidateLotsForFormat(
  format: StockFormat,
): Promise<(StockLotBalance & { id: string })[]> {
  const snap = await getDocs(
    query(collection(serverDb, "stockLotBalance"), where("format", "==", format)),
  );
  return snap.docs.map(
    (d) =>
      ({ id: d.id, ...(d.data() as Record<string, unknown>) }) as StockLotBalance & { id: string },
  );
}

export async function confirmOrderReservation(
  orderId: string,
  actorUid: string,
  correlationId = "no-correlation-id",
): Promise<ReservationOutcome> {
  try {
    // Pre-transaction reads: the order (to know its items) and every
    // candidate lot per required format. Re-read transactionally below.
    const { getDoc } = await import("firebase/firestore/lite");
    const orderSnap = await getDoc(doc(serverDb, "orders", orderId));
    if (!orderSnap.exists()) throw new NotFoundError("order_not_found");
    const order = { id: orderId, ...(orderSnap.data() as Record<string, unknown>) } as OrderDoc;

    if (order.status === "confirmed" && order.reservation?.status === "reserved") {
      return { status: "success", alreadyApplied: true };
    }
    if (order.status !== "pending") {
      throw new InvalidStateError("not_pending", order.status);
    }

    const byFormat = await aggregateAndValidateItems(order.items ?? []);
    const candidatesByFormat = new Map<StockFormat, (StockLotBalance & { id: string })[]>();
    for (const format of byFormat.keys()) {
      candidatesByFormat.set(format, await candidateLotsForFormat(format));
    }

    const result = await runTransaction(serverDb, async (tx) => {
      const orderRef = doc(serverDb, "orders", orderId);
      const freshOrderSnap = await tx.get(orderRef);
      if (!freshOrderSnap.exists()) throw new NotFoundError("order_not_found");
      const freshOrder = {
        id: orderId,
        ...(freshOrderSnap.data() as Record<string, unknown>),
      } as OrderDoc;
      if (freshOrder.status === "confirmed" && freshOrder.reservation?.status === "reserved") {
        return {
          alreadyApplied: true,
          reservationItems: [] as {
            format: StockFormat;
            quantity: number;
            allocations: FifoAllocation[];
          }[],
        };
      }
      if (freshOrder.status !== "pending")
        throw new InvalidStateError("not_pending", freshOrder.status);

      // Re-read every candidate + the global balance for every format, all before any write.
      const perFormat = await Promise.all(
        [...byFormat.entries()].map(async ([format, requested]) => {
          const candidates = candidatesByFormat.get(format) ?? [];
          const reread = await Promise.all(
            candidates.map(async (c) => ({
              id: c.id,
              snap: await tx.get(doc(serverDb, "stockLotBalance", c.id)),
            })),
          );
          const freshCandidates = reread
            .filter((r) => r.snap.exists())
            .map(
              (r) =>
                ({ id: r.id, ...(r.snap.data() as Record<string, unknown>) }) as StockLotBalance & {
                  id: string;
                },
            );
          const balanceSnap = await tx.get(doc(serverDb, "stockBalance", format));
          return { format, requested, freshCandidates, balanceSnap };
        }),
      );

      const shortfalls: { format: StockFormat; requested: number; available: number }[] = [];
      const allocationsByFormat = new Map<StockFormat, FifoAllocation[]>();
      for (const { format, requested, freshCandidates, balanceSnap } of perFormat) {
        const totalAvailable = freshCandidates.reduce((sum, c) => sum + availableQuantity(c), 0);
        if (totalAvailable < requested) {
          shortfalls.push({ format, requested, available: Math.max(totalAvailable, 0) });
          continue;
        }
        const allocations = allocateFifo(freshCandidates, requested);
        if (!allocations) {
          shortfalls.push({ format, requested, available: totalAvailable });
          continue;
        }
        allocationsByFormat.set(format, allocations);
        void balanceSnap; // read already establishes the transaction's optimistic-concurrency dependency on this doc
      }

      if (shortfalls.length > 0) throw new InsufficientStockError(shortfalls);

      const nowIso = new Date().toISOString();
      const reservationItems: {
        format: StockFormat;
        quantity: number;
        allocations: FifoAllocation[];
      }[] = [];

      for (const { format, requested, balanceSnap } of perFormat) {
        const allocations = allocationsByFormat.get(format);
        if (!allocations) continue;
        reservationItems.push({ format, quantity: requested, allocations });

        const balanceData = balanceSnap.exists()
          ? (balanceSnap.data() as Record<string, unknown>)
          : null;
        tx.update(doc(serverDb, "stockBalance", format), {
          reserved: ((balanceData?.reserved as number) ?? 0) + requested,
          updatedAt: nowIso,
          lastActorUid: actorUid,
        });

        for (const allocation of allocations) {
          // Match back to the actual candidate document by its real id —
          // never reconstruct a lot's doc id from allocation fields alone
          // (a legacy_opening allocation's own `legacyOpeningId` is a
          // display-shaped field on the balance document, not guaranteed
          // to equal the doc id's own formula).
          const candidate = (candidatesByFormat.get(format) ?? []).find((c) =>
            allocation.origin === "production"
              ? c.origin === "production" &&
                c.productionId === allocation.productionId &&
                c.qualityControlId === allocation.qualityControlId
              : c.origin === "legacy_opening" && c.legacyOpeningId === allocation.legacyOpeningId,
          );
          if (!candidate) continue;
          tx.update(doc(serverDb, "stockLotBalance", candidate.id), {
            reserved: candidate.reserved + allocation.quantity,
            updatedAt: nowIso,
            lastActorUid: actorUid,
          });
        }
      }

      tx.update(orderRef, {
        status: "confirmed",
        reservation: {
          status: "reserved",
          items: reservationItems,
          reservedAt: nowIso,
          reservedByUid: actorUid,
        },
      });

      return { alreadyApplied: false, reservationItems };
    });

    return { status: "success", alreadyApplied: result.alreadyApplied };
  } catch (err) {
    return handleReservationError(err, correlationId, "confirm-order", orderId);
  }
}

export async function cancelOrderReservation(
  orderId: string,
  actorUid: string,
  correlationId = "no-correlation-id",
): Promise<ReservationOutcome> {
  try {
    const result = await runTransaction(serverDb, async (tx) => {
      const orderRef = doc(serverDb, "orders", orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new NotFoundError("order_not_found");
      const order = { id: orderId, ...(orderSnap.data() as Record<string, unknown>) } as OrderDoc;

      if (order.status === "cancelled" && order.reservation?.status === "released") {
        return { alreadyApplied: true };
      }
      if (order.status !== "confirmed" || order.reservation?.status !== "reserved") {
        throw new InvalidStateError("not_confirmed", order.status);
      }

      const nowIso = new Date().toISOString();
      for (const item of order.reservation.items) {
        const balanceSnap = await tx.get(doc(serverDb, "stockBalance", item.format));
        const balanceData = balanceSnap.exists()
          ? (balanceSnap.data() as Record<string, unknown>)
          : null;
        tx.update(doc(serverDb, "stockBalance", item.format), {
          reserved: Math.max(((balanceData?.reserved as number) ?? 0) - item.quantity, 0),
          updatedAt: nowIso,
          lastActorUid: actorUid,
        });
        // legacy_opening allocations are skipped here deliberately, not
        // silently: Step A ships no cutover-input collection at all, so no
        // legacy_opening stockLotBalance document can exist yet (see
        // stockBalance.ts's own doc comment) — nothing to release against.
        // The global stockBalance.reserved decrement above still happens
        // for every allocation regardless of origin, so a legacy-origin
        // reservation (once reachable) still releases correctly at the
        // aggregate level; only its own per-lot bucket wouldn't yet, and
        // must be revisited before a physical cutover ever ships.
        for (const allocation of item.allocations) {
          if (allocation.origin !== "production") continue;
          const lotId = productionLotBalanceDocId(
            allocation.productionId,
            allocation.qualityControlId,
            item.format,
          );
          const lotSnap = await tx.get(doc(serverDb, "stockLotBalance", lotId));
          if (!lotSnap.exists()) continue;
          const lotData = lotSnap.data() as Record<string, unknown>;
          tx.update(doc(serverDb, "stockLotBalance", lotId), {
            reserved: Math.max(((lotData.reserved as number) ?? 0) - allocation.quantity, 0),
            updatedAt: nowIso,
            lastActorUid: actorUid,
          });
        }
      }

      tx.update(orderRef, {
        status: "cancelled",
        "reservation.status": "released",
      });

      return { alreadyApplied: false };
    });

    return { status: "success", alreadyApplied: result.alreadyApplied };
  } catch (err) {
    return handleReservationError(err, correlationId, "cancel-order", orderId);
  }
}

export async function fulfilOrderReservation(
  orderId: string,
  actorUid: string,
  correlationId = "no-correlation-id",
): Promise<ReservationOutcome> {
  try {
    const result = await runTransaction(serverDb, async (tx) => {
      const orderRef = doc(serverDb, "orders", orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists()) throw new NotFoundError("order_not_found");
      const order = { id: orderId, ...(orderSnap.data() as Record<string, unknown>) } as OrderDoc;

      if (order.status === "fulfilled" && order.reservation?.status === "fulfilled") {
        return { alreadyApplied: true };
      }
      if (order.status !== "confirmed" || order.reservation?.status !== "reserved") {
        throw new InvalidStateError("not_confirmed", order.status);
      }

      const nowIso = new Date().toISOString();
      for (const item of order.reservation.items) {
        const balanceSnap = await tx.get(doc(serverDb, "stockBalance", item.format));
        const balanceData = balanceSnap.exists()
          ? (balanceSnap.data() as Record<string, unknown>)
          : null;
        tx.update(doc(serverDb, "stockBalance", item.format), {
          onHand: Math.max(((balanceData?.onHand as number) ?? 0) - item.quantity, 0),
          reserved: Math.max(((balanceData?.reserved as number) ?? 0) - item.quantity, 0),
          updatedAt: nowIso,
          lastActorUid: actorUid,
        });

        for (const allocation of item.allocations) {
          if (allocation.origin !== "production") continue; // only production-origin allocations carry lot traceability for the Sortie row
          const lotId = productionLotBalanceDocId(
            allocation.productionId,
            allocation.qualityControlId,
            item.format,
          );
          const lotSnap = await tx.get(doc(serverDb, "stockLotBalance", lotId));
          if (lotSnap.exists()) {
            const lotData = lotSnap.data() as Record<string, unknown>;
            tx.update(doc(serverDb, "stockLotBalance", lotId), {
              onHand: Math.max(((lotData.onHand as number) ?? 0) - allocation.quantity, 0),
              reserved: Math.max(((lotData.reserved as number) ?? 0) - allocation.quantity, 0),
              updatedAt: nowIso,
              lastActorUid: actorUid,
            });
          }
          const sortieId = `PF-OUT-${orderId}-${allocation.productionId}-${item.format}`;
          tx.set(doc(serverDb, "stockPF", sortieId), {
            id: sortieId,
            date: nowIso.slice(0, 10),
            format: item.format,
            type: "Sortie",
            quantite: allocation.quantity,
            source: "order",
            orderId,
            productionId: allocation.productionId,
            qualityControlId: allocation.qualityControlId,
            createdAt: nowIso,
            createdByUid: actorUid,
          });
        }
      }

      const items = order.items ?? [];
      items.forEach((item, idx) => {
        const numero =
          items.length > 1
            ? `CMD-${orderId.slice(-6).toUpperCase()}-${idx + 1}`
            : `CMD-${orderId.slice(-6).toUpperCase()}`;
        tx.set(doc(serverDb, "ventes", `VTE-ORD-${orderId}-${idx}`), {
          id: `VTE-ORD-${orderId}-${idx}`,
          numero,
          date: nowIso.slice(0, 10),
          idClient: order.partnerId,
          client: order.partnerName,
          canal: "Grossiste",
          format: item.format,
          quantite: item.quantity,
          prixUnitaire: 0,
          remise: 0,
          encaisse: order.payment ? (item.quantity ?? 0) : 0,
          commerciale: "Boutique partenaire",
        });
      });

      tx.update(orderRef, {
        status: "fulfilled",
        fulfilledAt: nowIso,
        "reservation.status": "fulfilled",
      });

      return { alreadyApplied: false };
    });

    return { status: "success", alreadyApplied: result.alreadyApplied };
  } catch (err) {
    return handleReservationError(err, correlationId, "fulfil-order", orderId);
  }
}

function handleReservationError(
  err: unknown,
  correlationId: string,
  routeName: string,
  orderId: string,
): ReservationOutcome {
  if (err instanceof NotFoundError) return { status: "not_found", reason: err.reason };
  if (err instanceof InvalidStateError)
    return { status: "invalid_state", reason: err.reason, orderStatus: err.status };
  if (err instanceof InvalidItemsError)
    return { status: "invalid_items", reason: err.reason, productId: err.productId };
  if (err instanceof InsufficientStockError)
    return { status: "insufficient_stock", shortfalls: err.shortfalls };
  console.error(`[${routeName} ${correlationId}] transaction error (orderId=${orderId}):`, err);
  return { status: "error", reason: "internal_error" };
}
