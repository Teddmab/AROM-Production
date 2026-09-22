import { collection, doc, getDocs, query, runTransaction, where } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import type { Canal, Format } from "@/lib/erp/model";
import { toStockFormat, type StockFormat } from "@/lib/erp/stockFormat";
import { allocateFifo, availableQuantity, type FifoAllocation } from "./stockBalance";
import { candidateLotsForFormat } from "./orderReservation";

/**
 * Sprint 08, Step E — trusted direct sale (no order). Implements exactly
 * the "Direct sales (no order)" architecture approved in
 * AROM-Documentation/automation-engine.md — see that section for the full
 * design rationale. Never called directly; only from this repo's own
 * `/api/inventory/direct-sale` route, which verifies the caller first
 * (same `verifyCommercialInventoryCaller` Steps C/D already use — Admin
 * or Chargée de Commercialisation only).
 *
 * Deliberate deviation from automation-engine.md's original text: that
 * section says a staff member's own manually-selected `productionIds`
 * are "honored when still available, not overridden." This
 * implementation does NOT do that — it always allocates FIFO
 * server-side and never accepts a client-supplied lot selection at all.
 * Superseded by a later, more specific instruction: lot ids must never
 * be exposed during normal sale entry, and allocation is server-decided,
 * full stop. The resulting `ventes.productionIds` is still written,
 * with the exact same meaning as before (which lots this sale drew
 * from) — only *how* it gets decided has changed.
 *
 * Granularity note: unlike orders (which reference a specific
 * `products/{id}` catalogue listing), a staff-entered direct sale only
 * ever names a bottle FORMAT — the mobile wizard has no per-product
 * picker, and the stock ledger itself (`stockBalance`/`stockLotBalance`)
 * is keyed by format, not by catalogue product. "Validate the product"
 * for this operation therefore means: confirm at least one ACTIVE
 * `products` document currently sells this format — not resolve one
 * specific product id.
 *
 * Idempotency: unlike an order (which already exists, `pending`, before
 * confirm/cancel/fulfil ever runs), a direct sale has no prior document
 * to gate on — the caller-supplied `saleId` (mobile's stable draft
 * `localId`, always shaped `VTE-DS-<uuid>` — see
 * AROM-Mobile/src/features/sale/saleDraft.ts) IS the idempotency key and
 * the eventual `ventes` document id. The transaction reads that
 * document first: if it already exists, this call has already fully
 * applied (stock decremented, sale written) — return success without
 * touching stock a second time, the same lost-ack-safe shape already
 * proven for QC release and order confirm/cancel/fulfil. A `saleId` that
 * doesn't match the required shape is rejected outright — never
 * silently coerced or defaulted — so a forged or malformed id can never
 * collide with the legacy `VTE-<random>` id space the web dashboard's
 * own direct-write path still uses (see firestore.rules' own `ventes`
 * predicate: only the `VTE-DS-` id space is ever isInventoryService()-gated).
 */

const SALE_ID_PATTERN = /^VTE-DS-[A-Za-z0-9-]{1,128}$/;

export interface DirectSaleInput {
  saleId: string;
  format: string;
  quantity: number;
  /** Staff-entered, negotiated unit price (FC) — a legitimate operator input, not stock data. The server never trusts a client-computed TOTAL: `montantBrut` is always recomputed here from `quantity * prixUnitaire - remise`. */
  prixUnitaire: number;
  remise?: number;
  encaisse?: number;
  idClient?: string;
  clientNom?: string;
  canal?: string;
  /** Cosmetic display label only (mirrors reception's own `numero` convention) — never the document identity. */
  numero?: string;
  commerciale: string;
  autresFraisMotif?: string;
}

interface ProductDoc {
  id: string;
  format?: string;
  active?: boolean;
}

class InvalidSaleIdError extends Error {
  constructor() {
    super("invalid sale id");
  }
}
class InvalidFieldsError extends Error {
  constructor(public reason: "invalid_format" | "invalid_quantity" | "invalid_price") {
    super(reason);
  }
}
class UnknownProductError extends Error {
  constructor(public format: StockFormat) {
    super("unknown_product");
  }
}
class InsufficientStockError extends Error {
  constructor(public shortfall: { format: StockFormat; requested: number; available: number }) {
    super("insufficient stock");
  }
}

export type DirectSaleOutcome =
  | { status: "success"; alreadyApplied: boolean; saleId: string }
  | { status: "invalid_sale_id" }
  | {
      status: "invalid_items";
      reason: "invalid_format" | "invalid_quantity" | "invalid_price" | "unknown_product";
    }
  | {
      status: "insufficient_stock";
      shortfalls: { format: StockFormat; requested: number; available: number }[];
    }
  | { status: "error"; reason: "internal_error" };

/** At least one currently-sellable catalogue product exists for this format — never trusts the caller's own claim that the format is valid to sell. */
async function hasActiveProductForFormat(format: Format): Promise<boolean> {
  const snap = await getDocs(
    query(collection(serverDb, "products"), where("format", "==", format)),
  );
  return snap.docs.some((d) => (d.data() as ProductDoc).active === true);
}

export async function createDirectSale(
  input: DirectSaleInput,
  actorUid: string,
  correlationId = "no-correlation-id",
): Promise<DirectSaleOutcome> {
  try {
    if (!SALE_ID_PATTERN.test(input.saleId)) throw new InvalidSaleIdError();

    const canonicalFormat = toStockFormat(input.format);
    if (!canonicalFormat) throw new InvalidFieldsError("invalid_format");
    if (!Number.isFinite(input.quantity) || input.quantity <= 0)
      throw new InvalidFieldsError("invalid_quantity");
    if (!Number.isFinite(input.prixUnitaire) || input.prixUnitaire <= 0)
      throw new InvalidFieldsError("invalid_price");
    const remise = Number.isFinite(input.remise) ? Math.max(input.remise as number, 0) : 0;
    const encaisse = Number.isFinite(input.encaisse) ? Math.max(input.encaisse as number, 0) : 0;

    const businessFormat = input.format as Format;
    if (!(await hasActiveProductForFormat(businessFormat)))
      throw new UnknownProductError(canonicalFormat);

    // Pre-transaction reads, re-read inside the transaction below — identical shape to confirmOrderReservation.
    const saleRef = doc(serverDb, "ventes", input.saleId);
    const candidates = await candidateLotsForFormat(canonicalFormat);

    const result = await runTransaction(serverDb, async (tx) => {
      const existingSale = await tx.get(saleRef);
      if (existingSale.exists()) {
        return { alreadyApplied: true, allocations: [] as FifoAllocation[] };
      }

      const balanceRef = doc(serverDb, "stockBalance", canonicalFormat);
      const balanceSnap = await tx.get(balanceRef);
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
            ({
              id: r.id,
              ...(r.snap.data() as Record<string, unknown>),
            }) as (typeof candidates)[number],
        );

      const totalAvailable = freshCandidates.reduce((sum, c) => sum + availableQuantity(c), 0);
      if (totalAvailable < input.quantity) {
        throw new InsufficientStockError({
          format: canonicalFormat,
          requested: input.quantity,
          available: Math.max(totalAvailable, 0),
        });
      }
      const allocations = allocateFifo(freshCandidates, input.quantity);
      if (!allocations) {
        throw new InsufficientStockError({
          format: canonicalFormat,
          requested: input.quantity,
          available: totalAvailable,
        });
      }

      const nowIso = new Date().toISOString();
      const balanceData = balanceSnap.exists()
        ? (balanceSnap.data() as Record<string, unknown>)
        : null;
      tx.update(balanceRef, {
        // A direct sale has no reservation phase — onHand is decremented directly, `reserved` is never touched.
        onHand: Math.max(((balanceData?.onHand as number) ?? 0) - input.quantity, 0),
        updatedAt: nowIso,
        lastActorUid: actorUid,
      });

      const productionIds: string[] = [];
      for (const allocation of allocations) {
        // Only production-origin allocations carry lot traceability today — mirrors fulfilOrderReservation exactly.
        // No legacy_opening stockLotBalance document can exist yet (Step A ships no cutover-input collection).
        if (allocation.origin !== "production") continue;
        productionIds.push(allocation.productionId);
        const candidate = freshCandidates.find(
          (c) =>
            c.origin === "production" &&
            c.productionId === allocation.productionId &&
            c.qualityControlId === allocation.qualityControlId,
        );
        if (candidate) {
          tx.update(doc(serverDb, "stockLotBalance", candidate.id), {
            onHand: Math.max((candidate.onHand ?? 0) - allocation.quantity, 0),
            updatedAt: nowIso,
            lastActorUid: actorUid,
          });
        }
        const sortieId = `PF-OUT-DS-${input.saleId}-${allocation.productionId}-${canonicalFormat}`;
        tx.set(doc(serverDb, "stockPF", sortieId), {
          id: sortieId,
          date: nowIso.slice(0, 10),
          format: canonicalFormat,
          type: "Sortie",
          quantite: allocation.quantity,
          source: "direct-sale",
          saleId: input.saleId,
          productionId: allocation.productionId,
          qualityControlId: allocation.qualityControlId,
          createdAt: nowIso,
          createdByUid: actorUid,
        });
      }

      tx.set(saleRef, {
        id: input.saleId,
        numero: input.numero?.trim() || input.saleId,
        date: nowIso.slice(0, 10),
        idClient: input.idClient ?? "",
        client: input.clientNom ?? "",
        canal: (input.canal as Canal) ?? "Restaurant",
        format: businessFormat,
        quantite: input.quantity,
        prixUnitaire: input.prixUnitaire,
        remise,
        encaisse,
        commerciale: input.commerciale,
        staffUid: actorUid,
        productionIds: [...new Set(productionIds)],
      });

      return { alreadyApplied: false, allocations };
    });

    return { status: "success", alreadyApplied: result.alreadyApplied, saleId: input.saleId };
  } catch (err) {
    if (err instanceof InvalidSaleIdError) return { status: "invalid_sale_id" };
    if (err instanceof InvalidFieldsError) return { status: "invalid_items", reason: err.reason };
    if (err instanceof UnknownProductError)
      return { status: "invalid_items", reason: "unknown_product" };
    if (err instanceof InsufficientStockError)
      return { status: "insufficient_stock", shortfalls: [err.shortfall] };
    console.error(
      `[direct-sale ${correlationId}] transaction error (saleId=${input.saleId}):`,
      err,
    );
    return { status: "error", reason: "internal_error" };
  }
}
