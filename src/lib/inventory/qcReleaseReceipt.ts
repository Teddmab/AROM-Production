import { doc, runTransaction } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import type { StockFormat } from "@/lib/erp/stockFormat";

/**
 * Sprint 08, Step B — forward-only QC-release receipt. Called by
 * `/api/inventory/qc-release` once a mobile client's own quality-control
 * transaction has already committed the (immutable) `qualityControls` doc.
 * This function never writes `qualityControls` itself — only `stockPF`
 * (the immutable movement trail) and both balance projections
 * (`stockBalance`, `stockLotBalance`), all in one Firestore transaction,
 * via `firebase/firestore/lite`'s own `runTransaction` (confirmed present
 * and contract-identical to the full SDK during the Sprint 08 design
 * audit — see AROM-Documentation/automation-engine.md).
 *
 * Concurrency audit (Step B hardening, 2026-09): `qualityControls` and
 * `productions` are read by `tx.get()` — inside this same transaction,
 * not via a plain `getDoc()` beforehand. Packaging quantities
 * (`q500`/`q330`/`q300`) are derived only from that transactional
 * production snapshot. This matters because Firestore's optimistic
 * concurrency only protects documents the transaction actually read as
 * part of its own read set: if `productions/{id}` were read outside the
 * transaction (the original Step B shape), a concurrent edit to packaging
 * between that read and this transaction's commit would go completely
 * undetected — the transaction's write set never touched `productions` at
 * all, so Firestore has nothing to conflict on, and a stale quantity could
 * commit into `stockPF`/`stockLotBalance`/`stockBalance` unnoticed. Reading
 * transactionally means any such concurrent edit forces an automatic retry
 * (Firestore re-runs this callback from scratch against the now-current
 * data) rather than silently committing stale packaging — see
 * qcReleaseReceipt.test.ts's "concurrency" describe block for the
 * simulated proof. Authentication/profile validation (who is allowed to
 * call this at all) still happens before this transaction, in the calling
 * route — only the business documents that determine quantities and
 * eligibility are read transactionally.
 *
 * Explicit idempotency states (see automation-engine.md's own "Idempotency"
 * section for the full reasoning):
 *
 * - Nothing exists for a format → create its stockPF Entrée row, its
 *   stockLotBalance, and increment/create the global stockBalance.
 * - Everything already exists for a format → true no-op for that format;
 *   the overall call still reports success (a lost-ack retry must resolve
 *   as synchronized, never permanently failed).
 * - Partial state (a stockPF row exists — e.g. from before Step B shipped
 *   — but its stockLotBalance doesn't yet) → repaired: the *existing*
 *   stockPF row's own recorded quantity (never a freshly re-derived one)
 *   is what gets applied to both balance projections, so a partial repair
 *   can never double-count. See "Partial-repair safety invariant" further
 *   down this same comment for exactly why this is safe today and what
 *   would have to change before physical cutover for it to stay safe.
 * - Conflicting state (an existing stockPF row's content doesn't match
 *   what this release would produce) → a permanent conflict, reported as
 *   such, nothing written for that format, and the whole transaction
 *   aborts (a Firestore transaction is all-or-nothing — a conflict on any
 *   one format means none of this call's writes commit, not a partial
 *   set of them).
 *
 * `stockLotBalance`'s own existence for a given (production, QC, format)
 * is the single source of truth for "was this format's *entire*
 * consequence already applied" — it is created in the same pass as the
 * global balance increment, always, so its presence alone proves the
 * global increment already happened too; nothing else in Step B's scope
 * ever writes to it.
 *
 * Partial-repair safety invariant (Step B hardening, 2026-09 — read before
 * touching the "already applied" / repair branch below): a missing
 * `stockLotBalance` is only safe to treat as "this lot's global
 * contribution was never counted" because `stockBalance` and
 * `stockLotBalance` currently have exactly one writer in the whole system
 * — this function, and always together, in the same transaction (Rules
 * restrict both collections' `create`/`update` to `isInventoryService()`;
 * see firestore.rules). That makes it impossible, TODAY, for any unit of
 * an existing `stockBalance.onHand` to have come from anywhere other than
 * a Worker transaction that also wrote a matching `stockLotBalance`. So
 * "this lot's `stockLotBalance` is missing" really does mean "this lot's
 * quantity was never added to the global total," regardless of what the
 * global total's current value is (it may well be nonzero from *other*
 * lots — that's fine and expected).
 *
 * This invariant is NOT self-maintaining — it depends entirely on nothing
 * else ever writing to `stockBalance`/`stockPF` outside this function. The
 * one concrete way it breaks: a future physical-cutover process that
 * seeds `stockBalance` from a physical count. A physical count taken
 * today would already include bottles produced by pre-Step-B (legacy)
 * `stockPF` Entrée rows — the exact rows this function's own partial-
 * repair branch treats as safe to auto-repair. If cutover seeds a
 * global balance AND this function later runs against one of those same
 * legacy rows (e.g. via a future reconciliation pass), the repair would
 * add that lot's quantity a second time — once via the physical count,
 * once via the auto-repair — a genuine double-count with no way for this
 * code to detect it after the fact, since "lot balance missing" would no
 * longer reliably mean "never counted."
 *
 * The smallest fix, proposed but NOT implemented here (no cutover exists
 * yet to protect against — see AROM-Documentation/automation-engine.md's
 * cutover section): stamp every `stockPF` row this function creates with
 * `balanceApplied: true` at write time. Post-cutover, change the partial-
 * repair branch so a `stockPF` row found WITHOUT that marker is treated as
 * "of unknown provenance relative to the physical count" — routed to a
 * conflict/manual-review outcome instead of auto-repaired — while a row
 * WITH the marker (which, by construction, can only exist alongside its
 * own `stockLotBalance` unless something external deleted that lot
 * balance) keeps today's repair behavior. Adding this marker before a
 * cutover process exists to protect against would be speculative schema
 * churn with nothing to validate it against — see qcReleaseReceipt.test.ts
 * for tests pinning today's actually-safe behavior instead.
 */

const BOTTLE_KEY_BY_FORMAT: Record<StockFormat, "q500" | "q330" | "q300"> = {
  "500ml": "q500",
  "330ml": "q330",
  "300ml": "q300",
};
const STOCK_FORMATS: StockFormat[] = ["500ml", "330ml", "300ml"];

interface QualityControlDoc {
  id: string;
  productionId: string;
  decision: "liberer" | "quarantaine" | "rejeter";
  date: string;
  lot: string;
}

interface ProductionDoc {
  id: string;
  q500?: number;
  q330?: number;
  q300?: number;
}

/**
 * Every non-success variant's `reason` is a plain, stable code — never an
 * interpolated message (a doc id, a raw Firestore error string) — since
 * this result is serialized directly into the HTTP response body by
 * `/api/inventory/qc-release` (endpoint-safety hardening, 2026-09: see
 * that route's own doc comment). Detail beyond the code is logged
 * server-side only, tagged with the caller's correlation id.
 */
export type QcReleaseReceiptResult =
  | { status: "success"; formatsApplied: StockFormat[]; formatsAlreadyApplied: StockFormat[] }
  | { status: "not_found"; reason: "quality_control_not_found" | "production_not_found" }
  | { status: "invalid_state"; reason: "not_a_release"; decision: string }
  | { status: "conflict"; reason: "stockPF_content_mismatch"; format?: StockFormat }
  | { status: "error"; reason: "internal_error" };

function stockPFDocId(productionId: string, qualityControlId: string, format: StockFormat): string {
  return `PF-IN-${productionId}-${qualityControlId}-${format}`;
}
function productionLotBalanceDocId(
  productionId: string,
  qualityControlId: string,
  format: StockFormat,
): string {
  return `LOT-${productionId}-${qualityControlId}-${format}`;
}

class NotFoundError extends Error {
  reason: "quality_control_not_found" | "production_not_found";
  constructor(reason: "quality_control_not_found" | "production_not_found") {
    super(reason);
    this.reason = reason;
  }
}

class InvalidStateError extends Error {
  decision: string;
  constructor(decision: string) {
    super(`quality control decision is not a release: ${decision}`);
    this.decision = decision;
  }
}

class ConflictError extends Error {
  format?: StockFormat;
  constructor(message: string, format?: StockFormat) {
    super(message);
    this.format = format;
  }
}

export async function applyQcReleaseReceipt(
  qualityControlId: string,
  actorUid: string,
  correlationId = "no-correlation-id",
): Promise<QcReleaseReceiptResult> {
  try {
    const result = await runTransaction(serverDb, async (tx) => {
      // Authoritative reads, all inside this transaction, all before any
      // write — see this file's own top doc comment for why `productions`
      // in particular must never be read outside it.
      const qcSnap = await tx.get(doc(serverDb, "qualityControls", qualityControlId));
      if (!qcSnap.exists()) throw new NotFoundError("quality_control_not_found");
      const qc = {
        id: qualityControlId,
        ...(qcSnap.data() as Record<string, unknown>),
      } as QualityControlDoc;

      // "Worker verifies the QC is terminal and releasing" — qualityControls
      // is append-only after creation (firestore.rules' own rule), so
      // `decision` can never change out from under this check; "terminal"
      // is structurally guaranteed by that same rule (only "quarantaine"
      // can ever be resolved by a later, separate document —
      // "liberer"/"rejeter" are final). Checked before the production read
      // below so a non-release control never touches `productions` at all.
      if (qc.decision !== "liberer") throw new InvalidStateError(qc.decision);

      const productionSnap = await tx.get(doc(serverDb, "productions", qc.productionId));
      if (!productionSnap.exists()) throw new NotFoundError("production_not_found");
      const production = {
        id: qc.productionId,
        ...(productionSnap.data() as Record<string, unknown>),
      } as ProductionDoc;

      const formatsWithQuantity = STOCK_FORMATS.filter((format) => {
        const qty = production[BOTTLE_KEY_BY_FORMAT[format]];
        return typeof qty === "number" && qty > 0;
      });

      // All remaining reads before any writes, across every format — same
      // discipline AROM-Mobile's qualitySync.ts already follows for the
      // client-side half of this same release.
      const reads = await Promise.all(
        formatsWithQuantity.map(async (format) => {
          const expectedQuantity = production[BOTTLE_KEY_BY_FORMAT[format]] as number;
          const stockPFId = stockPFDocId(qc.productionId, qc.id, format);
          const lotBalanceId = productionLotBalanceDocId(qc.productionId, qc.id, format);
          const [existingStockPF, existingLotBalance] = await Promise.all([
            tx.get(doc(serverDb, "stockPF", stockPFId)),
            tx.get(doc(serverDb, "stockLotBalance", lotBalanceId)),
          ]);
          return {
            format,
            expectedQuantity,
            stockPFId,
            lotBalanceId,
            existingStockPF,
            existingLotBalance,
          };
        }),
      );

      // Global balance docs, one read per distinct format touched.
      const globalReads = new Map<StockFormat, Awaited<ReturnType<typeof tx.get>>>();
      for (const format of new Set(reads.map((r) => r.format))) {
        globalReads.set(format, await tx.get(doc(serverDb, "stockBalance", format)));
      }

      // Conflict pass — before any writes, so a conflict on any one format
      // aborts the whole transaction rather than leaving others applied.
      for (const r of reads) {
        if (!r.existingStockPF.exists()) continue;
        const data = r.existingStockPF.data() as Record<string, unknown>;
        const matches =
          data.productionId === qc.productionId &&
          data.qualityControlId === qc.id &&
          data.format === r.format &&
          data.quantite === r.expectedQuantity &&
          data.type === "Entrée" &&
          data.source === "production";
        if (!matches) {
          throw new ConflictError(
            `stockPF/${r.stockPFId} already exists with different content than this release would produce`,
            r.format,
          );
        }
      }

      const formatsApplied: StockFormat[] = [];
      const formatsAlreadyApplied: StockFormat[] = [];
      const globalIncrementByFormat = new Map<StockFormat, number>();

      for (const r of reads) {
        if (r.existingLotBalance.exists()) {
          // Already fully applied in an earlier successful attempt — safe
          // only under the invariant documented at the top of this file
          // (stockBalance/stockLotBalance have exactly one writer: this
          // function, always together). Never treat this as proof of
          // anything beyond that until a cutover process exists and this
          // invariant has been re-verified against it.
          formatsAlreadyApplied.push(r.format);
          continue;
        }

        // Ground truth for the quantity applied to both balances is the
        // stockPF row's own recorded quantity — the just-verified existing
        // one if present (a pre-Step-B partial state), or the fresh one
        // about to be written. Never re-derived a second, independent way.
        const quantityForBalance = r.existingStockPF.exists()
          ? ((r.existingStockPF.data() as Record<string, unknown>).quantite as number)
          : r.expectedQuantity;

        if (!r.existingStockPF.exists()) {
          tx.set(doc(serverDb, "stockPF", r.stockPFId), {
            id: r.stockPFId,
            date: qc.date,
            format: r.format,
            type: "Entrée",
            quantite: quantityForBalance,
            source: "production",
            productionId: qc.productionId,
            qualityControlId: qc.id,
            createdAt: new Date().toISOString(),
            createdByUid: actorUid,
          });
        }

        tx.set(doc(serverDb, "stockLotBalance", r.lotBalanceId), {
          origin: "production",
          productionId: qc.productionId,
          qualityControlId: qc.id,
          lot: qc.lot,
          format: r.format,
          onHand: quantityForBalance,
          reserved: 0,
          releasedAt: qc.date,
          updatedAt: new Date().toISOString(),
          lastActorUid: actorUid,
        });

        globalIncrementByFormat.set(
          r.format,
          (globalIncrementByFormat.get(r.format) ?? 0) + quantityForBalance,
        );
        formatsApplied.push(r.format);
      }

      for (const [format, increment] of globalIncrementByFormat) {
        const existingGlobal = globalReads.get(format);
        const nowIso = new Date().toISOString();
        if (existingGlobal?.exists()) {
          const onHand = (existingGlobal.data() as Record<string, unknown>).onHand as number;
          tx.update(doc(serverDb, "stockBalance", format), {
            onHand: onHand + increment,
            updatedAt: nowIso,
            lastActorUid: actorUid,
          });
        } else {
          tx.set(doc(serverDb, "stockBalance", format), {
            format,
            onHand: increment,
            reserved: 0,
            updatedAt: nowIso,
            lastActorUid: actorUid,
          });
        }
      }

      return { formatsApplied, formatsAlreadyApplied };
    });

    return { status: "success", ...result };
  } catch (err) {
    if (err instanceof NotFoundError) return { status: "not_found", reason: err.reason };
    if (err instanceof InvalidStateError) {
      return { status: "invalid_state", reason: "not_a_release", decision: err.decision };
    }
    if (err instanceof ConflictError) {
      console.error(
        `[qc-release-receipt ${correlationId}] conflict (qualityControlId=${qualityControlId}, format=${err.format ?? "?"}):`,
        err.message,
      );
      return { status: "conflict", reason: "stockPF_content_mismatch", format: err.format };
    }
    console.error(
      `[qc-release-receipt ${correlationId}] transaction error (qualityControlId=${qualityControlId}):`,
      err,
    );
    return { status: "error", reason: "internal_error" };
  }
}
