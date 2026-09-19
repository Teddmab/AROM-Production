import { collection, getDocs, limit as fsLimit, orderBy, query } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
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
 * Checkpoint: rather than a separately-persisted cursor (AROM-Backend's
 * `externalIntegrations/mombongo` doc is isMombongoWebhook()-*read*-only;
 * write is isAdmin()-only, so this trusted identity cannot durably store
 * a checkpoint there without a Backend Rules change, which is out of
 * scope here), the checkpoint is derived fresh each run: the highest
 * `updatedAt` currently present across `harvestOffers` — a field only
 * ever written by a trusted outcome-applying transition (webhook or this
 * job). This is self-maintaining and correctly conservative: a page whose
 * items fail partway through only durably advances what actually
 * committed (each item's own `updatedAt`), so a resumed run's derived
 * checkpoint reflects exactly what succeeded, never more — "partial-page
 * failure does not advance the checkpoint" falls out of this by
 * construction rather than needing a separate stored value at all.
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

async function computeCheckpoint(): Promise<string | undefined> {
  const snap = await getDocs(
    query(collection(serverDb, "harvestOffers"), orderBy("updatedAt", "desc"), fsLimit(1)),
  );
  if (snap.empty) return undefined;
  return (snap.docs[0].data().updatedAt as string) ?? undefined;
}

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
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<ReconciliationSummary> {
  const maxPages = options.maxPages ?? 20;
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const updatedSince = await computeCheckpoint();

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
        // Partial-page failure: stop here rather than skip ahead — every
        // item processed before this one is already durably committed
        // (its own transaction succeeded independently), so the derived
        // checkpoint for the *next* run naturally reflects exactly that
        // much progress, safely repeatable.
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
