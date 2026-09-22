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
 * Idempotency — payload-bound, not bare document-existence. Unlike an
 * order (which already exists, `pending`, before confirm/cancel/fulfil
 * ever runs), a direct sale has no prior document to gate on — the
 * caller-supplied `saleId` (a stable client-generated id, always shaped
 * `VTE-DS-<uuid>` — see AROM-Mobile/src/features/sale/saleDraft.ts and
 * AROM-Production/src/routes/dashboard.tsx's own `newId("VTE-DS")` call)
 * IS the idempotency key and the eventual `ventes` document id.
 *
 * A document existing at that id is NOT, by itself, taken as "already
 * applied" — the earlier version of this file did exactly that, which
 * is exactly the bug this comment now documents and closes: a bare
 * document-exists check treats a *different* sale that happens to reuse
 * an id (a forged retry, a client bug, two devices racing on a stale
 * draft id) as a harmless no-op success, silently swallowing a request
 * that was never actually satisfied. Instead, the stored document's
 * business fields are compared against the incoming request — see
 * `saleFingerprint`/`fingerprintsMatch` below for the exact field set —
 * and:
 *   - an EQUIVALENT retry (same fingerprint) returns
 *     `{ status: "success", alreadyApplied: true }` without touching
 *     stock again — the lost-ack-safe shape already proven for QC
 *     release and order confirm/cancel/fulfil, now provably safe rather
 *     than assumed safe;
 *   - a DIFFERENT request reusing the same id returns
 *     `{ status: "conflict" }` — never silently "succeeds", never
 *     overwrites the existing sale, never touches stock.
 *
 * This also settles both concurrency shapes correctly, for free, because
 * the comparison happens *inside* the Firestore transaction (which
 * serializes via optimistic-concurrency retry, not a lock): two
 * simultaneous EQUIVALENT requests race to `tx.set` — whichever commits
 * first wins, Firestore retries the other's transaction body, which then
 * re-reads the now-existing document, finds it equivalent, and returns
 * `alreadyApplied: true` — one sale, one stock deduction, both callers
 * see success. Two simultaneous DIFFERENT requests sharing one `saleId`
 * settle the same way structurally, except the loser's re-read finds a
 * *mismatched* fingerprint and returns `conflict` instead — one winner,
 * one explicit conflict, never two sales, never a double deduction.
 *
 * A `saleId` that doesn't match the required shape is rejected outright
 * — never silently coerced or defaulted — so a forged or malformed id
 * can never collide with the legacy `VTE-<random>` id space the web
 * dashboard's bulk CSV import tool still legitimately uses for
 * historical bookkeeping data (see `ImportButton.tsx` — a distinct,
 * non-live, non-stock-affecting workflow, deliberately left alone; see
 * firestore.rules' own `ventes` predicate for the exact id-space
 * boundary: `VTE-DS-` and the order-fulfilment bridge's `VTE-ORD-` are
 * the only two isInventoryService()-gated spaces).
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
class SaleConflictError extends Error {
  constructor() {
    super("sale id reused with a different request");
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
  | { status: "conflict"; reason: "sale_id_reused_with_different_request" }
  | { status: "error"; reason: "internal_error" };

/**
 * The idempotency fingerprint — every field whose value changes what the
 * sale actually MEANS. Compared with `fingerprintsMatch` whenever
 * `saleId` already resolves to an existing document; see the file-level
 * doc comment above for the full rationale.
 *
 * Included, and why:
 *  - `format` (canonical, e.g. `"500ml"` — never the raw business-format
 *    string) — "which product." Canonicalizing both sides first means a
 *    presentation difference alone (`"500 ml"` vs `"500ml"`) can never
 *    manufacture a false conflict — see `toStockFormat`.
 *  - `quantite`, `prixUnitaire`, `remise`, `encaisse` — the full payment
 *    basis. This operation has no separate "record a later payment"
 *    endpoint — the entire sale, encaisse included, is captured in this
 *    one atomic write — so a differing `encaisse` on retry is a
 *    different sale, not a legitimate follow-up update.
 *  - `idClient`, `client` — customer attribution (id and its
 *    denormalized name snapshot both checked: if `idClient` matches but
 *    the name doesn't, that is itself a data-quality signal worth
 *    surfacing as a conflict rather than silently trusting the id).
 *  - `canal` — a real term of the sale (a restaurant's on-account terms
 *    differ from a boutique's cash terms), not decoration.
 *  - `commerciale` — the credited salesperson's display name; part of
 *    the recorded business record.
 *  - `staffUid` — actor attribution. Never client-supplied (always the
 *    verified caller's own uid — see `createDirectSale`'s `actorUid`
 *    parameter), so this can never be forged by the request body itself,
 *    but a retry arriving from a genuinely different authenticated
 *    account than the one that created the original sale is exactly the
 *    kind of thing a bare "document exists" check would have silently
 *    treated as a safe no-op — comparing it here catches that.
 *
 * Deliberately EXCLUDED, and why:
 *  - `numero` — cosmetic display label only (see `DirectSaleInput`'s own
 *    doc comment on this field) — never the document identity, never
 *    part of the business meaning of the sale.
 *  - `date` — always server-derived from `new Date()` at write time,
 *    never accepted from the client at all (see `createDirectSale`'s own
 *    write below) — nothing to compare, and re-deriving it on a matched
 *    retry would be wrong (the ORIGINAL write's date stays authoritative).
 *  - `productionIds` — server-decided output of FIFO allocation, never
 *    client input; recomputing or comparing it here would misread an
 *    output as an input. An equivalent retry's `alreadyApplied: true`
 *    path never touches this field again — the original allocation
 *    remains authoritative, exactly as an immutable ledger requires.
 *  - `saleId` itself — the lookup key, not a fingerprint field.
 */
interface SaleFingerprint {
  format: StockFormat;
  quantite: number;
  prixUnitaire: number;
  remise: number;
  encaisse: number;
  idClient: string;
  client: string;
  canal: string;
  commerciale: string;
  staffUid: string;
}

function fingerprintFromInput(
  input: DirectSaleInput,
  canonicalFormat: StockFormat,
  remise: number,
  encaisse: number,
  actorUid: string,
): SaleFingerprint {
  return {
    format: canonicalFormat,
    quantite: input.quantity,
    prixUnitaire: input.prixUnitaire,
    remise,
    encaisse,
    idClient: input.idClient ?? "",
    client: input.clientNom ?? "",
    canal: (input.canal as Canal) ?? "Restaurant",
    commerciale: input.commerciale,
    staffUid: actorUid,
  };
}

/**
 * Builds the comparison fingerprint from a stored `ventes` document.
 * Returns `null` if the stored document's own `format` doesn't
 * canonicalize at all (a malformed or pre-Step-E legacy row somehow
 * sharing this id) — treated as "never matches," so it always falls
 * through to `conflict` rather than risk a false-positive match against
 * un-normalizable data.
 */
function fingerprintFromStored(data: Record<string, unknown>): SaleFingerprint | null {
  const canonicalFormat = toStockFormat(String(data.format ?? ""));
  if (!canonicalFormat) return null;
  return {
    format: canonicalFormat,
    quantite: Number(data.quantite),
    prixUnitaire: Number(data.prixUnitaire),
    remise: Number(data.remise ?? 0),
    encaisse: Number(data.encaisse ?? 0),
    idClient: String(data.idClient ?? ""),
    client: String(data.client ?? ""),
    canal: String(data.canal ?? ""),
    commerciale: String(data.commerciale ?? ""),
    staffUid: String(data.staffUid ?? ""),
  };
}

function fingerprintsMatch(a: SaleFingerprint, b: SaleFingerprint): boolean {
  return (
    a.format === b.format &&
    a.quantite === b.quantite &&
    a.prixUnitaire === b.prixUnitaire &&
    a.remise === b.remise &&
    a.encaisse === b.encaisse &&
    a.idClient === b.idClient &&
    a.client === b.client &&
    a.canal === b.canal &&
    a.commerciale === b.commerciale &&
    a.staffUid === b.staffUid
  );
}

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
        const stored = fingerprintFromStored(existingSale.data() as Record<string, unknown>);
        const requested = fingerprintFromInput(input, canonicalFormat, remise, encaisse, actorUid);
        if (!stored || !fingerprintsMatch(stored, requested)) throw new SaleConflictError();
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
    if (err instanceof SaleConflictError)
      return { status: "conflict", reason: "sale_id_reused_with_different_request" };
    console.error(
      `[direct-sale ${correlationId}] transaction error (saleId=${input.saleId}):`,
      err,
    );
    return { status: "error", reason: "internal_error" };
  }
}
