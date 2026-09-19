import { getMombongoConfig } from "./mombongoConfig";
import { hashSha256Hex } from "./mombongoSigning";
import { getMombongoHarvestOffers } from "./mombongoHarvest";
import {
  applyMombongoOfferOutcome,
  findOfferDocId,
  importRemoteOffer,
} from "./mombongoOfferOutcome";
import { claimInboxEvent, markInboxConflict } from "./mombongoWebhookInbox";
import {
  advanceCheckpoint,
  isCheckpointTimestamp,
  readCheckpoint,
} from "./mombongoReconciliationCheckpoint";
import type { ExternalHarvestOfferDto } from "./mombongoContract";

/**
 * Trusted server-side reconciliation (contract v2). Reuses
 * `applyMombongoOfferOutcome` — the exact function the
 * `offer_status_changed` webhook uses — so reconciliation and webhook
 * processing share one authorization/transition surface.
 *
 * DURABLE CHECKPOINT (AROM-Backend `mombongoReconciliationState/harvest-offers`,
 * merged in Backend PR #14). The earlier designs are gone: deriving
 * `updatedSince` from local data skipped equal-`updatedAt` ties and offers with
 * no local doc, and a fixed lookback window let an old backlog age out.
 *
 * ALGORITHM
 *  1. Read the checkpoint. If `completedThrough` exists:
 *       updatedSince = completedThrough − overlap        (overlap ≥ 15 min, default 1 h)
 *     else BOOTSTRAP from the trusted config value
 *     `externalIntegrations/mombongo.reconciliationBootstrapSince`
 *     (ISO timestamp or "full-history"); absent/invalid => fail closed. No
 *     request input ever reaches this value.
 *  2. Page through getExternalHarvestOffers (cursor used only inside this run).
 *     Mombongo filters `updatedAt > updatedSince` (STRICT) and orders
 *     (updatedAt asc, offerId asc). Because updatedSince is `overlap` BEFORE
 *     the committed boundary, every record at or after the boundary — ties
 *     included — is re-fetched next run, and re-applying is idempotent.
 *  3. Each offer is applied through the shared outcome logic; a missing local
 *     offer is imported from authoritative Mombongo fields when every
 *     required field exists, otherwise it is BLOCKED (durably recorded in
 *     mombongoWebhookEvents as a conflict) and PINS the checkpoint.
 *  4. After a page is fully handled, advance `completedThrough` to the
 *     greatest remote `updatedAt` that is safe:
 *       - strictly below the earliest blocked/failed record (the pin);
 *       - on a page that is not the last, strictly below the page's final
 *         `updatedAt` — its tie group may continue on the next page, so the
 *         trailing group is never committed until a later page (or the end of
 *         the stream) proves it complete. (Overlap would revisit it anyway;
 *         this is belt and braces.)
 *     The value is always a REMOTE timestamp — never a local clock.
 *  5. Advancement is compare-and-set forward-only (advanceCheckpoint); a
 *     run whose write loses to a newer run stops as superseded.
 *
 * Concurrent runs need no lease: each run only commits a boundary it fully
 * processed, duplicate processing is idempotent, and Rules forbid moving the
 * boundary backward.
 *
 * KNOWN LIMIT: a permanently blocked record holds the boundary; every run then
 * re-scans from that point and can process at most maxPages*pageSize records
 * beyond it. Releasing such a record needs an explicit human resolution policy
 * (not built) — the checkpoint is never advanced past it on a timer.
 */
export type ReconciliationStatus = "complete" | "partial" | "not_configured" | "error";

export interface ReconciliationSummary {
  status: ReconciliationStatus;
  /** Safe machine-readable code only — never a raw error message. */
  reason?: string;
  pagesProcessed: number;
  offersExamined: number;
  imported: number;
  updated: number;
  noops: number;
  conflicts: number;
  blocked: number;
  checkpoint: { advanced: boolean; previous: string | null; current: string | null };
}

export const DEFAULT_OVERLAP_MS = 60 * 60 * 1000;
/** Backend contract minimum (docs/mombongo-contract-v2.md): never query with less overlap. */
export const MIN_OVERLAP_MS = 15 * 60 * 1000;

const FULL_HISTORY = "full-history";
const ABSOLUTE_PAGE_FACTOR = 10;

type OfferResult = { kind: "ok" } | { kind: "blocked" };

function logSafe(label: string, err: unknown) {
  // Name only: never the message or stack, which could echo request context.
  console.error(`reconcileMombongoOffers: ${label}`, err instanceof Error ? err.name : "unknown");
}

function earliest(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function validRemoteOffer(dto: ExternalHarvestOfferDto): boolean {
  return (
    !!dto &&
    typeof dto.offerId === "string" &&
    dto.offerId.length > 0 &&
    isCheckpointTimestamp(dto.updatedAt) &&
    (dto.status === "pending" || dto.status === "accepted" || dto.status === "declined")
  );
}

/** Durable, deduplicated diagnostic in the approved inbox schema (conflict state). */
async function recordDurably(
  kind: "conflict" | "blocked",
  offerId: string,
  discriminator: string,
  reason: string,
  occurredAt: string,
) {
  try {
    const eventId = await hashSha256Hex(`reconcile-${kind} ${offerId} ${discriminator}`);
    const claim = await claimInboxEvent({
      eventId,
      eventType: "offer_status_changed",
      schemaVersion: 1,
      occurredAt,
      mombongoOfferId: offerId,
    });
    if (claim.kind === "process") await markInboxConflict(claim.ref, reason.slice(0, 300));
  } catch (err) {
    logSafe("could not record diagnostic", err);
  }
}

export async function reconcileMombongoOffers(
  options: { maxPages?: number; pageSize?: number; overlapMs?: number } = {},
): Promise<ReconciliationSummary> {
  const maxPages = options.maxPages ?? 20;
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const overlapMs = Math.max(MIN_OVERLAP_MS, options.overlapMs ?? DEFAULT_OVERLAP_MS);

  const summary: ReconciliationSummary = {
    status: "complete",
    pagesProcessed: 0,
    offersExamined: 0,
    imported: 0,
    updated: 0,
    noops: 0,
    conflicts: 0,
    blocked: 0,
    checkpoint: { advanced: false, previous: null, current: null },
  };

  // Signs in as the trusted system identity and loads trusted config.
  let bootstrapSince: string | undefined;
  try {
    bootstrapSince = (await getMombongoConfig()).reconciliationBootstrapSince;
  } catch (err) {
    logSafe("integration config unavailable", err);
    return { ...summary, status: "error", reason: "integration_unavailable" };
  }

  let stored: string | undefined;
  try {
    stored = (await readCheckpoint()).completedThrough;
  } catch (err) {
    logSafe("checkpoint unreadable", err);
    return { ...summary, status: "error", reason: "checkpoint_unreadable" };
  }
  summary.checkpoint.previous = stored ?? null;
  summary.checkpoint.current = stored ?? null;

  let updatedSince: string | undefined;
  if (stored !== undefined) {
    updatedSince = new Date(Date.parse(stored) - overlapMs).toISOString();
  } else if (bootstrapSince === FULL_HISTORY) {
    updatedSince = undefined;
  } else if (isCheckpointTimestamp(bootstrapSince)) {
    updatedSince = bootstrapSince;
  } else {
    return { ...summary, status: "not_configured", reason: "bootstrap_not_configured" };
  }

  const processed: string[] = []; // remote updatedAt of every offer fully handled this run
  let pin: string | null = null; // earliest blocked/failed remote updatedAt
  let noAdvance = false; // a record with an unusable timestamp: cannot reason about ordering
  let cursor: string | undefined;
  let exhausted = false;

  const commit = async (
    isFinalPage: boolean,
    pageLastTs: string | undefined,
  ): Promise<"ok" | "stop"> => {
    if (noAdvance) return "ok";
    let candidate: string | undefined;
    for (const t of processed) {
      if (pin !== null && t >= pin) continue;
      if (!isFinalPage && pageLastTs !== undefined && t >= pageLastTs) continue;
      if (candidate === undefined || t > candidate) candidate = t;
    }
    if (candidate === undefined) return "ok";
    if (summary.checkpoint.current !== null && candidate <= summary.checkpoint.current) return "ok";
    try {
      const result = await advanceCheckpoint(candidate);
      summary.checkpoint.current = result.current;
      if (result.kind === "advanced") summary.checkpoint.advanced = true;
      if (result.kind === "superseded") {
        summary.status = "partial";
        summary.reason = "superseded_by_newer_run";
        return "stop";
      }
      return "ok";
    } catch (err) {
      logSafe("checkpoint advance failed", err);
      summary.status = "partial";
      summary.reason = "checkpoint_write_failed";
      return "stop";
    }
  };

  // Pages that only replay the overlap (everything at or before the boundary
  // this run started from) do NOT count against maxPages — otherwise a dense
  // backlog inside the overlap window would make every run re-scan the same
  // first pages and never reach new records (a livelock). A hard absolute cap
  // still bounds the run.
  const startedFrom = stored;
  let countedPages = 0;
  let totalPages = 0;
  while (countedPages < maxPages && totalPages < maxPages * ABSOLUTE_PAGE_FACTOR) {
    totalPages++;
    const page = await getMombongoHarvestOffers({ updatedSince, limit: pageSize, cursor }).catch(
      (err) => {
        logSafe("mombongo request failed", err);
        return { error: "unreachable", httpStatus: 0 };
      },
    );
    if ("error" in page) {
      summary.status = "error";
      summary.reason = "mombongo_unavailable";
      return summary;
    }

    const offers = [...page.offers].sort((a, b) =>
      `${a?.updatedAt}|${a?.offerId}` < `${b?.updatedAt}|${b?.offerId}` ? -1 : 1,
    );
    let failed = false;

    for (const dto of offers) {
      summary.offersExamined++;
      let result: OfferResult;
      try {
        result = await processOffer(dto, summary);
      } catch (err) {
        logSafe("offer processing failed", err);
        failed = true;
        if (isCheckpointTimestamp(dto?.updatedAt)) pin = earliest(pin, dto.updatedAt);
        else noAdvance = true;
        break;
      }
      if (result.kind === "ok") {
        processed.push(dto.updatedAt as string);
      } else {
        summary.blocked++;
        if (isCheckpointTimestamp(dto?.updatedAt)) pin = earliest(pin, dto.updatedAt);
        else noAdvance = true;
      }
    }

    summary.pagesProcessed++;
    const lastTs = offers.length ? offers[offers.length - 1]?.updatedAt : undefined;
    const isOverlapReplay =
      startedFrom !== undefined && isCheckpointTimestamp(lastTs) && lastTs <= startedFrom;
    if (!isOverlapReplay) countedPages++;
    const isFinalPage = !page.nextCursor;
    const committed = await commit(
      isFinalPage && !failed,
      isCheckpointTimestamp(lastTs) ? lastTs : undefined,
    );

    if (failed) {
      summary.status = "partial";
      summary.reason = "processing_failed";
      return summary;
    }
    if (committed === "stop") return summary;
    if (isFinalPage) {
      exhausted = true;
      break;
    }
    cursor = page.nextCursor as string;
  }

  if (!exhausted) {
    summary.status = "partial";
    summary.reason = "page_cap_reached";
  } else if (pin !== null || noAdvance) {
    summary.status = "partial";
    summary.reason = "blocked_records";
  }
  return summary;
}

async function processOffer(
  dto: ExternalHarvestOfferDto,
  summary: ReconciliationSummary,
): Promise<OfferResult> {
  if (!validRemoteOffer(dto)) {
    await recordDurably(
      "blocked",
      typeof dto?.offerId === "string" && dto.offerId ? dto.offerId : "unknown",
      "invalid-dto",
      "Réponse Mombongo invalide (identifiant, statut ou horodatage inutilisable).",
      new Date().toISOString(),
    );
    return { kind: "blocked" };
  }

  const key = {
    mombongoOfferId: dto.offerId,
    externalReference: dto.externalReference,
  };
  let offerDocId = await findOfferDocId({
    ...key,
    status: "accepted",
    occurredAt: dto.updatedAt as string,
    eventId: "lookup",
  });

  if (!offerDocId) {
    const imported = await importRemoteOffer({
      offerId: dto.offerId,
      externalReference: dto.externalReference,
      listingId: dto.listingId,
      quantityKg: dto.quantityKg,
      unitPriceCdf: dto.unitPriceCdf,
      currency: dto.currency,
      createdAt: dto.createdAt,
    });
    if (imported.kind === "blocked") {
      await recordDurably(
        "blocked",
        dto.offerId,
        "no-local-offer",
        imported.reason,
        dto.updatedAt as string,
      );
      return { kind: "blocked" };
    }
    if (imported.kind === "imported") summary.imported++;
    offerDocId = imported.offerDocId;
  }

  if (dto.status === "pending") {
    summary.noops++;
    return { kind: "ok" };
  }

  const outcome = await applyMombongoOfferOutcome({
    ...key,
    status: dto.status as "accepted" | "declined",
    occurredAt: dto.updatedAt as string,
    eventId: await hashSha256Hex(`reconcile ${dto.offerId} ${dto.status} ${dto.updatedAt}`),
    invoiceId: dto.invoiceId ?? undefined,
  });

  switch (outcome.kind) {
    case "applied":
      summary.updated++;
      return { kind: "ok" };
    case "already_applied":
    case "stale":
      summary.noops++;
      return { kind: "ok" };
    case "conflict":
      summary.conflicts++;
      await recordDurably(
        "conflict",
        dto.offerId,
        dto.status as string,
        outcome.reason,
        dto.updatedAt as string,
      );
      return { kind: "ok" };
    default:
      // not_found right after import/lookup: cannot be applied yet — hold the boundary.
      await recordDurably(
        "blocked",
        dto.offerId,
        "apply-not-found",
        outcome.reason,
        dto.updatedAt as string,
      );
      return { kind: "blocked" };
  }
}
