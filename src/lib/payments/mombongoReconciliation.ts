import { getMombongoConfig } from "./mombongoConfig";
import { hashSha256Hex } from "./mombongoSigning";
import { getMombongoHarvestOffers } from "./mombongoHarvest";
import {
  applyMombongoOfferOutcome,
  findOfferDocId,
  importRemoteOffer,
} from "./mombongoOfferOutcome";
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
 *     required field exists, otherwise it is BLOCKED. Blocked and conflicting
 *     records are reported as redacted `issues` (see PROVENANCE below) and PIN
 *     the checkpoint.
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
 * TWO INDEPENDENT LIMITS (server constants, never request-controlled):
 *  - progress-page limit (`maxPages`, default 20): counts only pages that
 *    reach beyond the boundary the run started from — bounds how much NEW
 *    backlog one run processes. Overlap-replay pages are exempt so a dense
 *    overlap cannot livelock progress.
 *  - absolute request limit (`maxRequests`, default 100): counts EVERY remote
 *    list request, replay-only pages included; nothing can bypass it.
 *  Cursor-cycle protection: every cursor received this run is remembered; a
 *  cursor returned a second time (self-loop, A→B→A, a remote that keeps
 *  returning the same page) stops the run with `cursor_cycle`. Whenever any
 *  limit or cycle ends a run early the last page is treated as NON-final, so
 *  its trailing tie group is not committed; unprocessed records are never
 *  advanced past, and a later run resumes from the durable boundary.
 *
 * PROVENANCE OF UNRESOLVED RECORDS. Blocked/conflicting remote offers are NOT
 * written to `mombongoWebhookEvents`: that collection's closed schema only
 * admits real webhook event types (`offer_status_changed`, `invoice_issued`)
 * and has no provenance field, so any record there would falsely claim a
 * webhook was received (and would need an invented eventId). They are instead
 * returned as bounded, redacted `issues` (deterministic `issueId`) and PIN the
 * boundary. A durable home needs a dedicated trusted Backend collection — see
 * docs/mombongo-contract-v2-worker.md.
 *
 * KNOWN LIMIT: a permanently blocked record holds the boundary; every run then
 * re-scans from that point and can process at most maxPages*pageSize records
 * beyond it. Releasing such a record needs an explicit human resolution policy
 * (not built) — the checkpoint is never advanced past it on a timer.
 */
export type ReconciliationStatus = "complete" | "partial" | "not_configured" | "error";

export interface ReconciliationIssue {
  /** sha256("reconciliation-issue-v1 <kind> <offerId> <code>") — deterministic; NOT a Mombongo eventId and never stored as one. */
  issueId: string;
  kind: "blocked" | "conflict";
  /** Stable machine code, never free text. */
  code: string;
  offerId: string;
  remoteUpdatedAt: string | null;
}

export interface ReconciliationSummary {
  status: ReconciliationStatus;
  /** Safe machine-readable code only — never a raw error message. */
  reason?: string;
  pagesProcessed: number;
  /** Every remote list request this run, replay-only pages included. */
  remoteRequests: number;
  offersExamined: number;
  imported: number;
  updated: number;
  noops: number;
  conflicts: number;
  blocked: number;
  /** Distinct unresolved records this run (bounded list). */
  issues: ReconciliationIssue[];
  checkpoint: { advanced: boolean; previous: string | null; current: string | null };
}

export const DEFAULT_OVERLAP_MS = 60 * 60 * 1000;
/** Backend contract minimum (docs/mombongo-contract-v2.md): never query with less overlap. */
export const MIN_OVERLAP_MS = 15 * 60 * 1000;

const FULL_HISTORY = "full-history";
export const DEFAULT_MAX_PROGRESS_PAGES = 20;
export const DEFAULT_MAX_REMOTE_REQUESTS = 100;
const MAX_REPORTED_ISSUES = 20;

type OfferResult = { kind: "ok" } | { kind: "unresolved" };
type AddIssue = (issue: Omit<ReconciliationIssue, "issueId">) => Promise<void>;

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

export async function reconcileMombongoOffers(
  options: {
    maxPages?: number;
    maxRequests?: number;
    pageSize?: number;
    overlapMs?: number;
  } = {},
): Promise<ReconciliationSummary> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PROGRESS_PAGES;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REMOTE_REQUESTS;
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 100), 100);
  const overlapMs = Math.max(MIN_OVERLAP_MS, options.overlapMs ?? DEFAULT_OVERLAP_MS);

  const summary: ReconciliationSummary = {
    status: "complete",
    pagesProcessed: 0,
    remoteRequests: 0,
    offersExamined: 0,
    imported: 0,
    updated: 0,
    noops: 0,
    conflicts: 0,
    blocked: 0,
    issues: [],
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

  // Two independent limits (see header): countedPages = progress pages only;
  // summary.remoteRequests = every request, replay-only pages included.
  const startedFrom = stored;
  let countedPages = 0;
  let stopReason: string | undefined;
  const seenCursors = new Set<string>();
  const seenIssues = new Set<string>();

  const addIssue: AddIssue = async (issue) => {
    const issueId = await hashSha256Hex(
      `reconciliation-issue-v1 ${issue.kind} ${issue.offerId} ${issue.code}`,
    );
    if (seenIssues.has(issueId)) return;
    seenIssues.add(issueId);
    if (issue.kind === "conflict") summary.conflicts++;
    else summary.blocked++;
    if (summary.issues.length < MAX_REPORTED_ISSUES) summary.issues.push({ issueId, ...issue });
  };

  while (true) {
    if (countedPages >= maxPages) {
      stopReason = "page_cap_reached";
      break;
    }
    if (summary.remoteRequests >= maxRequests) {
      stopReason = "request_limit_reached";
      break;
    }
    summary.remoteRequests++;
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
        result = await processOffer(dto, summary, addIssue);
      } catch (err) {
        logSafe("offer processing failed", err);
        failed = true;
        if (isCheckpointTimestamp(dto?.updatedAt)) pin = earliest(pin, dto.updatedAt);
        else noAdvance = true;
        break;
      }
      if (result.kind === "ok") {
        processed.push(dto.updatedAt as string);
      } else if (isCheckpointTimestamp(dto?.updatedAt)) {
        pin = earliest(pin, dto.updatedAt);
      } else {
        noAdvance = true;
      }
    }

    summary.pagesProcessed++;
    const lastTs = offers.length ? offers[offers.length - 1]?.updatedAt : undefined;
    const isOverlapReplay =
      startedFrom !== undefined && isCheckpointTimestamp(lastTs) && lastTs <= startedFrom;
    if (!isOverlapReplay) countedPages++;
    const nextCursor = page.nextCursor ?? null;
    const isFinalPage = !nextCursor;
    const cycle = nextCursor !== null && seenCursors.has(nextCursor);
    if (nextCursor !== null) seenCursors.add(nextCursor);
    // A page that is followed by a limit/cycle stop is NOT final: its trailing
    // tie group must not be committed.
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
    if (cycle) {
      stopReason = "cursor_cycle";
      break;
    }
    cursor = nextCursor as string;
  }

  if (!exhausted) {
    summary.status = "partial";
    summary.reason = stopReason ?? "page_cap_reached";
  } else if (pin !== null || noAdvance) {
    summary.status = "partial";
    summary.reason = "blocked_records";
  }
  return summary;
}

async function processOffer(
  dto: ExternalHarvestOfferDto,
  summary: ReconciliationSummary,
  addIssue: AddIssue,
): Promise<OfferResult> {
  if (!validRemoteOffer(dto)) {
    await addIssue({
      kind: "blocked",
      code: "invalid_remote_record",
      offerId: typeof dto?.offerId === "string" && dto.offerId ? dto.offerId : "unknown",
      remoteUpdatedAt: isCheckpointTimestamp(dto?.updatedAt) ? dto.updatedAt : null,
    });
    return { kind: "unresolved" };
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
      await addIssue({
        kind: "blocked",
        code: imported.code,
        offerId: dto.offerId,
        remoteUpdatedAt: dto.updatedAt,
      });
      return { kind: "unresolved" };
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
    // Stored as harvestOffers.lastEventId. Namespaced so it can never be
    // mistaken for (or collide with) a real Mombongo eventId — reconciliation
    // discovered this change; no webhook event exists for it.
    eventId: `reconciliation-v1:${await hashSha256Hex(`${dto.offerId} ${dto.status} ${dto.updatedAt}`)}`,
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
      // No honest durable home exists in the merged Backend schema, so a
      // conflict pins the boundary (like a blocked record) instead of being
      // recorded as a fake webhook event.
      await addIssue({
        kind: "conflict",
        code: outcome.code,
        offerId: dto.offerId,
        remoteUpdatedAt: dto.updatedAt,
      });
      return { kind: "unresolved" };
    default:
      await addIssue({
        kind: "blocked",
        code: "apply_not_found",
        offerId: dto.offerId,
        remoteUpdatedAt: dto.updatedAt,
      });
      return { kind: "unresolved" };
  }
}
