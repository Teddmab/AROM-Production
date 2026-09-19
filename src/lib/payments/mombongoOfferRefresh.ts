import { getMombongoHarvestOffers } from "./mombongoHarvest";
import type { ExternalHarvestOfferDto } from "./mombongoContract";
import { applyOfferEnrichmentIfNeeded, sanitizeOfferEnrichment } from "./mombongoOfferEnrichment";
import { findOfferDoc } from "./mombongoOfferOutcome";
import { isCheckpointTimestamp } from "./mombongoReconciliationCheckpoint";

/**
 * "Actualiser les offres" — a bounded, user-triggered PRESENTATION refresh of
 * the accepted Mombongo offers a field agent receives against. It exists
 * because lifecycle reconciliation (mombongoReconciliation.ts) pages only
 * offers whose own `updatedAt` moved past its checkpoint, so it can never
 * enrich an offer accepted before Mombongo shipped seller/listing context, nor
 * renew a thumbnail whose signed URL (about an hour) has lapsed.
 *
 * WHAT IT DOES: asks Mombongo for ACCEPTED offers only — no `updatedSince`, so
 * historical accepted offers are included — and, for each one that already
 * exists locally as an accepted/won offer with the same Mombongo offer id,
 * applies the shared enrichment planner (mombongoOfferEnrichment.ts): seller and
 * listing business data under the remote-`updatedAt` monotonic guard, the
 * thumbnail credential under its own expiry rule, and a missing `invoiceId`.
 *
 * WHAT IT NEVER DOES: create an offer (an offer with no local document is
 * skipped — importing is lifecycle reconciliation's job), change any status,
 * touch the reconciliation checkpoint, `lastEventId`, invoices, receptions,
 * checkout or payment state. It has no checkpoint of its own: every run
 * re-examines from the start and is idempotent, and a run that hits its cap
 * says "partial" and never claims completion.
 *
 * BOUNDS (server constants — the request body is never read, so a caller cannot
 * choose pagination, status, partner, role, project or environment):
 *   pageSize 50, at most 4 pages processed (200 offers), and a SEPARATE absolute
 *   ceiling of 6 remote requests (page fetches, including any that stall or
 *   loop). Mombongo lists oldest-changed first, so the cap covers the 200 oldest
 *   accepted offers; that is far above the pilot's accepted-offer count and
 *   above what Mobile caches (the newest 100). If accepted offers ever exceed
 *   the cap the run reports "partial" honestly — a checkpoint or a descending
 *   list would then be needed, deliberately not built.
 *
 * THROTTLE/CONCURRENCY: in-process only (this Worker isolate), like
 * reconcile-offers: equivalent concurrent refreshes share ONE run, and a new
 * run within MIN_INTERVAL_MS answers "throttled". Not distributed by design —
 * correctness never depends on it (all writes are idempotent updates of
 * existing documents), it only stops a refresh storm from becoming a Mombongo
 * storm. The pages Mombongo returns are also what carries fresh thumbnails, so
 * one run renews every image that needs it with no extra remote request.
 */
export const REFRESH_PAGE_SIZE = 50;
export const REFRESH_MAX_PAGES = 4;
export const REFRESH_MAX_REMOTE_REQUESTS = 6;
export const REFRESH_MIN_INTERVAL_MS = 20_000;

export interface OfferRefreshSummary {
  status: "complete" | "partial" | "unavailable";
  examined: number;
  refreshed: number;
  unchanged: number;
  skipped: number;
  /** True when Firestore now holds changes a client should read again. */
  shouldReread: boolean;
}

export type OfferRefreshResult =
  | OfferRefreshSummary
  | { status: "throttled"; retryAfterMs: number };

function logSafe(label: string, err: unknown) {
  // Name only: never a message, stack, URL or payload (could echo a signed URL or farmer data).
  console.error(`refreshReceivableOffers: ${label}`, err instanceof Error ? err.name : "unknown");
}

type OfferOutcome = "refreshed" | "unchanged" | "skipped";

async function refreshOne(dto: ExternalHarvestOfferDto, now: number): Promise<OfferOutcome> {
  if (
    !dto ||
    typeof dto.offerId !== "string" ||
    dto.offerId.length === 0 ||
    dto.status !== "accepted" ||
    !isCheckpointTimestamp(dto.updatedAt)
  ) {
    return "skipped";
  }
  // Nothing to write if this response carried no usable seller/listing.
  const snapshot = sanitizeOfferEnrichment(dto, now);
  if (!snapshot) return "skipped";

  const local = await findOfferDoc({
    mombongoOfferId: dto.offerId,
    externalReference: dto.externalReference ?? null,
  });
  if (!local) return "skipped"; // never create an offer from a presentation refresh

  const result = await applyOfferEnrichmentIfNeeded({
    offerDocId: local.id,
    offer: local.data,
    mombongoOfferId: dto.offerId,
    snapshot,
    invoiceId: dto.invoiceId,
    now,
  });
  switch (result.kind) {
    case "applied":
      return "refreshed";
    case "unchanged":
    case "stale":
      return "unchanged";
    default:
      return "skipped";
  }
}

/** The unthrottled core — exported for tests; production callers use runOfferRefresh. */
export async function refreshReceivableOffers(
  options: { pageSize?: number; maxPages?: number; maxRequests?: number; now?: () => number } = {},
): Promise<OfferRefreshSummary> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? REFRESH_PAGE_SIZE), 100);
  const maxPages = options.maxPages ?? REFRESH_MAX_PAGES;
  const maxRequests = options.maxRequests ?? REFRESH_MAX_REMOTE_REQUESTS;
  const clock = options.now ?? Date.now;

  const summary: OfferRefreshSummary = {
    status: "complete",
    examined: 0,
    refreshed: 0,
    unchanged: 0,
    skipped: 0,
    shouldReread: false,
  };
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let requests = 0;
  let exhausted = false;

  while (pages < maxPages && requests < maxRequests) {
    requests++;
    // Accepted offers only, NO updatedSince: historical accepted offers are included.
    const page = await getMombongoHarvestOffers({
      status: "accepted",
      limit: pageSize,
      cursor,
    }).catch((err) => {
      logSafe("remote request failed", err);
      return { error: "unreachable", httpStatus: 0 } as const;
    });
    if ("error" in page) {
      // Whatever was already written stays; say honestly how far it got.
      summary.status = summary.examined > 0 ? "partial" : "unavailable";
      summary.shouldReread = summary.refreshed > 0;
      return summary;
    }

    const now = clock();
    for (const dto of page.offers) {
      summary.examined++;
      try {
        summary[await refreshOne(dto, now)]++;
      } catch (err) {
        logSafe("offer refresh failed", err);
        summary.skipped++;
      }
    }
    pages++;

    const next = page.nextCursor ?? null;
    if (!next) {
      exhausted = true;
      break;
    }
    if (seenCursors.has(next)) break; // a remote that keeps returning the same page must not loop us
    seenCursors.add(next);
    cursor = next;
  }

  summary.status = exhausted ? "complete" : "partial";
  summary.shouldReread = summary.refreshed > 0;
  return summary;
}

// --- in-process throttle + single-flight (see header) ---
let inFlight: Promise<OfferRefreshSummary> | null = null;
let lastRunAt = 0;

/** Test-only reset of the module-level throttle state. */
export function _resetOfferRefreshStateForTests(): void {
  inFlight = null;
  lastRunAt = 0;
}

export async function runOfferRefresh(now: () => number = Date.now): Promise<OfferRefreshResult> {
  if (inFlight) return inFlight; // an equivalent refresh is already running: share it
  const t = now();
  if (lastRunAt !== 0 && t - lastRunAt < REFRESH_MIN_INTERVAL_MS) {
    return { status: "throttled", retryAfterMs: REFRESH_MIN_INTERVAL_MS - (t - lastRunAt) };
  }
  lastRunAt = t;
  const run = refreshReceivableOffers().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}
