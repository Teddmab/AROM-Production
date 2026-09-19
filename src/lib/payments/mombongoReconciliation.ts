import { hashSha256Hex } from "./mombongoSigning";
import { getMombongoHarvestOffers } from "./mombongoHarvest";
import { applyMombongoOfferOutcome } from "./mombongoOfferOutcome";
import { claimInboxEvent, markInboxConflict, markInboxProcessed } from "./mombongoWebhookInbox";

/**
 * Trusted server-side reconciliation (contract v2, Section G). Reuses
 * `applyMombongoOfferOutcome` — the exact same function the
 * `offer_status_changed` webhook uses — so reconciliation and webhook
 * processing share one authorization/transition surface, never a
 * separate loophole.
 *
 * CHECKPOINT DESIGN — REVISED (superseded the original "derive updatedSince
 * from the max local harvestOffers.updatedAt" approach, which was PROVEN
 * unsafe, not merely theoretically risky):
 *
 *   1. Two offers can share the exact same `updatedAt` (real, not
 *      hypothetical — Mombongo's own reconciliation index is `(updatedAt
 *      asc, __name__ asc)` specifically because ties are expected). If one
 *      of a tied pair is processed and the other fails/is skipped, the
 *      derived checkpoint equals BOTH their timestamps — but
 *      `getExternalHarvestOffers` filters `updatedAt > updatedSince`
 *      (strict), so the unprocessed twin is silently excluded from every
 *      future page, forever.
 *   2. A "not_found" offer (arrived before its harvestOffers doc existed
 *      locally) writes nothing, so its remote `updatedAt` never appears in
 *      the local max. If a LATER offer in the same page (larger
 *      `updatedAt`) succeeds, the derived checkpoint jumps past the
 *      not-found offer's own timestamp — it can never be re-fetched again,
 *      even though it was never actually resolved.
 *
 *   Both are genuine, provable, permanent-skip bugs — not edge cases worth
 *   hand-waving. AROM-Backend's `externalIntegrations/mombongo` doc (the
 *   only existing config-like location) is `isAdmin()`-write-only, so this
 *   trusted identity has nowhere Rules-legal to durably persist a real
 *   checkpoint without a Backend change (out of scope for this task — see
 *   the follow-up note below).
 *
 *   Chosen safe option instead: STATELESS, BOUNDED, DELIBERATELY
 *   OVERLAPPING reconciliation. Every run queries a FIXED wall-clock
 *   lookback window (`now() - LOOKBACK_WINDOW_MS`), independent of any
 *   local write, any prior run's progress, or any cursor surviving across
 *   runs. Every offer inside that window is re-examined every run,
 *   regardless of whether an earlier run already settled it —
 *   `applyMombongoOfferOutcome` is fully idempotent (a same-state replay
 *   is a safe no-op; a genuine terminal conflict is recorded, never
 *   overwritten), so redundant re-examination costs nothing but a wasted
 *   read. Nothing inside the window can ever be silently skipped, because
 *   nothing about *what's in scope* depends on what happened to any other
 *   offer in the same or a prior run. The cursor itself is used only
 *   within a single run's own pagination loop and is discarded at the end
 *   — "cursor expires/becomes invalid" and "reconciliation repeats after a
 *   process restart" are both trivially safe, since no cursor or
 *   checkpoint is ever carried across invocations at all.
 *
 *   Tradeoff, stated plainly: this is bounded-correct, not
 *   bounded-efficient. An offer whose backlog is deeper than
 *   `maxPages * pageSize` within one run, for longer than
 *   LOOKBACK_WINDOW_MS, can still age out unprocessed — this is a real,
 *   accepted limitation of a stateless design, not a hidden one. The
 *   proper fix is a dedicated, trusted-writer `mombongoReconciliationState`
 *   collection in AROM-Backend (a single doc, isMombongoWebhook()-only
 *   read/write, holding just `{ updatedSinceCursor: string }`) — reported
 *   as the required follow-up, not built here (AROM-Backend is out of
 *   scope for this task).
 */
export interface ReconciliationSummary {
  pagesProcessed: number;
  offersExamined: number;
  applied: number;
  alreadyApplied: number;
  conflicts: number;
  notFoundLocally: number;
  error?: string;
}

/**
 * How far back every run looks, regardless of when it last ran. Must
 * exceed the longest realistic gap between reconciliation runs (manual
 * Mobile-triggered refresh, today — no schedule exists yet) with a wide
 * safety margin; 72h is a deliberately generous starting point given
 * reconciliation volume is low. Revisit if runs are ever expected to be
 * spaced further apart than this, or once the real checkpoint collection
 * above replaces this entirely.
 */
const LOOKBACK_WINDOW_MS = 72 * 60 * 60 * 1000;

async function recordReconciliationConflict(
  offerId: string,
  status: string,
  reason: string,
): Promise<void> {
  const eventId = await hashSha256Hex(`reconcile ${offerId} ${status}`);
  const claim = await claimInboxEvent({
    eventId,
    eventType: "offer_status_changed",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    mombongoOfferId: offerId,
  });
  if (claim.kind === "process") await markInboxConflict(claim.ref, reason);
}

export async function reconcileMombongoOffers(
  options: { maxPages?: number; pageSize?: number; lookbackMs?: number } = {},
): Promise<ReconciliationSummary> {
  const maxPages = options.maxPages ?? 20;
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const lookbackMs = options.lookbackMs ?? LOOKBACK_WINDOW_MS;
  const updatedSince = new Date(Date.now() - lookbackMs).toISOString();

  const summary: ReconciliationSummary = {
    pagesProcessed: 0,
    offersExamined: 0,
    applied: 0,
    alreadyApplied: 0,
    conflicts: 0,
    notFoundLocally: 0,
  };

  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await getMombongoHarvestOffers({ updatedSince, limit: pageSize, cursor });
    if ("error" in page) {
      summary.error = page.error;
      return summary;
    }

    for (const offerDto of page.offers) {
      summary.offersExamined++;
      if (offerDto.status !== "accepted" && offerDto.status !== "declined") continue; // nothing authoritative to apply yet

      try {
        const outcome = await applyMombongoOfferOutcome({
          mombongoOfferId: offerDto.offerId,
          externalReference: offerDto.externalReference,
          status: offerDto.status,
          occurredAt: offerDto.updatedAt ?? new Date().toISOString(),
          eventId: await hashSha256Hex(
            `reconcile ${offerDto.offerId} ${offerDto.status} ${offerDto.updatedAt ?? ""}`,
          ),
          invoiceId: offerDto.invoiceId ?? undefined,
        });
        if (outcome.kind === "applied") summary.applied++;
        else if (outcome.kind === "already_applied" || outcome.kind === "stale")
          summary.alreadyApplied++;
        else if (outcome.kind === "conflict") {
          summary.conflicts++;
          await recordReconciliationConflict(offerDto.offerId, offerDto.status, outcome.reason);
        } else if (outcome.kind === "not_found") summary.notFoundLocally++;
      } catch (err) {
        // A single item's own processing error stops this run here rather
        // than skipping ahead to later items in the page — but unlike the
        // old derived-checkpoint design, this does NOT cause any offer to
        // be permanently missed: the fixed window means every offer in
        // this page (including the ones after the failure point) is
        // in scope again on the very next run, exactly as if this run had
        // never touched them.
        summary.error = err instanceof Error ? err.message : "partial_page_failure";
        return summary;
      }
    }

    summary.pagesProcessed++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return summary;
}
