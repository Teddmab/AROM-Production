# Mombongo contract v2 — Worker behavior, recovery and atomicity

Scope: `src/lib/payments/mombongo*.ts`, `/api/mombongo/*`, `/api/webhooks/mombongo`.
Verified against mombongo-functions `960ed54` and AROM-Backend `751b3bc` (includes PR #12/#13/#14).

## 1. Offer identity

| Value                                     | Derivation                                                        | Sent to Mombongo?         |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| Claim doc id (`mombongoOfferClaims/{id}`) | `sha256(listingId)`                                               | No — AROM-local lock only |
| `externalReference`                       | random UUID, generated once inside the claim-creation transaction | Yes (body)                |
| `Idempotency-Key`                         | `arom-harvest-offer-v1:` + the same UUID                          | Yes (header)              |
| `harvestOffers` doc id                    | = `externalReference`                                             | No                        |

**Multiple offers per listing?** Not allowed by AROM — a deliberate product rule
(AROM-Mobile `findActiveOfferForListing` matches on `listingId` alone for any
status; `offer.tsx` redirects instead of showing the form; Mobile PR #5 states it).
Mombongo does **not** enforce it (`createHarvestOfferCore` creates a new
`harvest_offers` doc on every call, no per-partner/listing uniqueness). Because
only one side enforces it, the Mombongo-facing identity is deliberately _not_
derived from `listingId`; only the local lock is. Quantity/price/message are
never part of the key — Mombongo's own fingerprint returns 409 on same-key /
different-payload. There is no cancel/replace/amend flow in AROM or Mombongo today.
Single partner (AROM) ⇒ keys are scoped `(partnerId, key)` on Mombongo's side;
UUIDs do not collide.

## 2. Claim states (`mombongoOfferClaims`)

| State                       | Retry allowed?                                              | Identifiers reused                             | Lookup first?                       | Leaves the state when                                                                                                  | Crash recovery                                                                                          | Permanently stuck?                                                                         |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `in_flight` (< 60 s)        | No — returns `in_flight`/`conflict`                         | —                                              | —                                   | request finishes → `completed`/`rejected`/`unknown`                                                                    | age passes 60 s → treated as `unknown`                                                                  | No                                                                                         |
| `in_flight` (> 60 s, stale) | Yes, via recovery                                           | stored `externalReference` + `Idempotency-Key` | **Yes** (`getExternalHarvestOffer`) | recovery outcome                                                                                                       | this _is_ the crash recovery (crash before the call, or after Mombongo succeeded but before persisting) | No                                                                                         |
| `unknown`                   | Yes, via recovery                                           | stored ids                                     | **Yes**                             | found → `completed`; 404 → resubmit with same key → `completed`/`rejected`/`unknown`; lookup failure → stays `unknown` | n/a                                                                                                     | No — every later call retries recovery                                                     |
| `rejected`                  | No — returns `rejected` locally, even for a changed payload | —                                              | No                                  | never (definitive Mombongo 400/409)                                                                                    | n/a                                                                                                     | Yes, **intentionally**: a definitive refusal is not retried automatically (human decision) |
| `completed`                 | No — returns the original offer (`alreadyExisted`)          | `harvestOfferId`                               | No                                  | terminal                                                                                                               | claim + offer written in one transaction                                                                | No                                                                                         |

Merged Rules already permit every transition used (`in_flight→*`, `unknown→completed|rejected`); no
`unknown→in_flight` transition is needed or used.

## 3. Reconciliation — durable checkpoint

Backend dependency: `mombongoReconciliationState/harvest-offers` (AROM-Backend PR #14, merged `751b3bc`).
Closed schema `{streamId, completedThrough?, updatedAt}`; `isMombongoWebhook()` only; ISO UTC (ms) strings; monotonic.
**The Worker must not run against an environment where these Rules are not deployed** (writes would be denied and
reconciliation would report `checkpoint_write_failed`). Deploy Backend Rules first (transitional policy), then the Worker.

Earlier designs were removed: a checkpoint _derived_ from local `updatedAt` skipped equal-timestamp ties and offers with
no local doc; a fixed 72 h lookback let an old backlog age out. Neither is used.

**Bootstrap (no boundary yet).** Value comes only from trusted config
`externalIntegrations/mombongo.reconciliationBootstrapSince` (admin-set Firestore field, never a request input):
an ISO timestamp, or `"full-history"` (no lower bound — provably covers every partner offer). Absent/invalid ⇒
**fail closed** (`not_configured`, HTTP 503, no Mombongo request). No value is guessed: production data was not (and
must not be) inspected here, so no automatic lower bound can be proven. Recommended: `"full-history"` — offer volume is
low and progress is checkpointed page by page. Any ISO value must be ≤ the earliest AROM offer ever submitted.

**Query.** `updatedSince = completedThrough − overlap`, overlap default 1 h, never below the 15-minute Backend minimum.
Mombongo filters `updatedAt > updatedSince` (strict) ordered `(updatedAt, offerId)`; because the query starts an overlap
_before_ the boundary, records equal to or after the boundary — ties, late-visible writes within the overlap — are
always re-fetched. Re-applying is idempotent. Pages that only replay the overlap do not count against the per-run page
cap (otherwise a dense backlog inside the overlap would livelock every run at the same first pages).

**Advancement and ties.** After a page is fully handled, `completedThrough` = greatest **remote** `updatedAt` that is
(a) strictly below the earliest blocked/failed record, and (b) on a non-final page, strictly below that page's final
`updatedAt` — the trailing tie group may continue on the next page, so it is never committed until a later page or the
end of the stream proves it complete. Overlap would revisit it anyway; this is belt and braces. Never a local clock.
An empty result commits nothing (no fabricated boundary, no state doc).

**Compare-and-set.** One transaction: read stored boundary; if stored ≥ proposed write nothing (equal = no-op,
greater = superseded); else create/update. If the Rules reject the write, re-read: stored ≥ proposed ⇒ superseded, stop
safely; otherwise the failure is reported (`checkpoint_write_failed`). Never retried with an older value.

**Concurrent runs.** No lease. Each run only commits a boundary it fully processed, duplicate processing is
idempotent, Rules forbid moving the boundary backward. A slower run either finds its proposal ≤ stored (no write) or is
denied and stops as superseded.

**Limits (two independent, server-side constants; never request- or Mobile-controlled).**

1. _Progress-page limit_ — `maxPages`, default 20. Counts only pages that reach beyond the boundary the run started
   from; bounds how much **new** backlog one run processes. Overlap-replay pages are exempt so a dense overlap cannot
   livelock progress.
2. _Absolute request limit_ — `maxRequests`, default 100. Counts **every** remote list request, replay-only pages
   included, and cannot be bypassed. Reaching it ends the run as `partial` / `request_limit_reached`.

**Cursor-cycle protection.** Every cursor received this run is remembered; a cursor returned a second time (self-loop,
A→B→A, a remote returning the same page) stops the run as `partial` / `cursor_cycle` without another request. A remote
that keeps returning fresh cursors with the same page is stopped by the absolute limit. Whenever a limit or cycle ends a
run, the last page is treated as **non-final** (its trailing tie group is not committed) and nothing past unprocessed
work is advanced; a later run resumes from the durable boundary. Reasons: `page_cap_reached`, `request_limit_reached`,
`cursor_cycle`, `blocked_records`, `processing_failed`, `checkpoint_write_failed`, `superseded_by_newer_run`.

**Remote offer with no local doc.** Ownership is provable (the list endpoint takes `partnerId` from the verified header,
never the body). If `offerId`, `listingId`, `createdAt`, positive `quantityKg`/`unitPriceCdf` and `currency: CDF` are
all present it is imported: doc id = `externalReference` (else `mombongo-<offerId>`), created **pending** (Rules
force `pending` at create), `createdAt` = Mombongo's, `importedFrom: "reconciliation"`, and the remote
accepted/declined is then applied as a separate step (an interruption leaves a pending offer; the next run applies it).
Nothing is fabricated. Anything missing ⇒ **blocked**.

**Unresolved records (blocked or conflicting) — provenance.** They are **not** written to `mombongoWebhookEvents`.
That collection's closed schema admits only real webhook types (`eventType ∈ {offer_status_changed, invoice_issued}`,
`schemaVersion` pinned per type) and has no provenance field, so a reconciliation-discovered problem stored there would
claim a webhook was received and need an invented `eventId`. Instead each record becomes a redacted **issue** in the
route response — `{issueId, kind: blocked|conflict, code, offerId, remoteUpdatedAt}` — with
`issueId = sha256("reconciliation-issue-v1 <kind> <offerId> <code>")` (domain-separated; cannot equal Mombongo's
`sha256("<eventType> <offerId> <status>")`; the same record found again, in the same run or a later one, has the same id;
the list is bounded to 20 while `blocked`/`conflicts` counts stay exact). Codes are stable machine strings
(`missing_listing_id`, `missing_created_at`, `invalid_quantity`, `invalid_price`, `unexpected_currency`,
`unsafe_local_id`, `local_id_offer_mismatch`, `invalid_remote_record`, `apply_not_found`, `offer_id_mismatch`,
`terminal_status_conflict`). Both kinds **pin** the boundary below the record — there is no timer-based release.
Reconciliation-applied changes store `lastEventId = "reconciliation-v1:<sha256>"`, never a value that looks like a
Mombongo eventId. **Backend requirement for durable storage** (not built; Backend is out of scope): a dedicated
trusted-writer collection, e.g. `mombongoReconciliationIssues/{issueId}` with a closed schema
`{issueId, kind, code, offerId, remoteUpdatedAt?, firstSeenAt, lastSeenAt, state: open|resolved}`,
`isMombongoWebhook()` read/write, delete denied, `state` open→resolved only. Until it exists, a permanently unresolved
record holds the boundary and each run re-scans from it (bounded by the limits above); releasing it needs an explicit
resolution policy.

**System-import actor.** Imported offers carry `createdByUid: "system:mombongo-reconciliation"` (Rules require a string
at create) plus `importedFrom: "reconciliation"` for unambiguous audit output; no user actor is invented. It cannot be
mistaken for a human: client-sign-in uids are server-generated alphanumerics (no `:`), the create-offer route takes
`createdByUid` only from the verified token (a body value is ignored) and rejects a caller whose uid is the reserved
marker. It cannot be impersonated by a client: merged Rules allow `harvestOffers` create/update **only** to
`isMombongoWebhook()` — ADMIN and mobile clients cannot write the collection at all, so no Backend blocker. Visibility:
ADMIN reads the whole collection per the Rules; Mobile's "Mes offres" filters `createdByUid === uid` client-side, so
imports stay hidden from user-scoped views until the planned Mobile change (this is a UX filter, not security).

**Failure recovery.** Item throws ⇒ boundary pinned below it, run stops (`processing_failed`), earlier items stay
applied and earlier pages stay committed. Mombongo error/invalid cursor ⇒ `mombongo_unavailable`; committed progress
stays. Restart ⇒ nothing in-process is needed; the next run resumes from the durable boundary. Backlog larger than one
run drains across runs.

**Route response** (`POST /api/mombongo/reconcile-offers`, no request input is read): `status`
(`complete`|`partial`|`not_configured`|`error`), optional safe `reason` code, `pagesProcessed`, `offersExamined`,
`remoteRequests`, `imported`, `updated`, `noops`, `conflicts`, `blocked`, `issues[]`, `checkpoint {advanced, previous, current}`. HTTP 200
complete/partial, 429 throttled, 502 error, 503 not_configured. Never credentials, signatures, raw errors.

## 4. Webhook inbox

`claimInboxEvent` is a single Firestore transaction (read + conditional create). States: new → `received`;
`processed` → return success, no reprocessing; `conflict` → acknowledged, inspectable, never reported as applied;
`received`/`failed` → **resume** processing. Processing failure → `failed` (+ HTTP 5xx so Mombongo retries).
`offer_not_found_yet` → `failed` + 503; the same event resolves on redelivery once the offer exists, and reconciliation
applies it independently. Crash after the offer update but before `markInboxProcessed` → inbox stays
`received`/`failed`; redelivery re-runs `applyMombongoOfferOutcome`, which is a no-op for the already-applied state.
Two concurrent deliveries: one inbox record (transaction); both may proceed to process, and the offer is protected by
`applyMombongoOfferOutcome`'s own transactional same-state idempotency.

## 5. Atomic vs non-atomic

| Operation                                              | Atomic?                                                                     | Recovery for the non-atomic part                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claim creation (identity generation + `in_flight` doc) | Yes (one transaction)                                                       | —                                                                                                      |
| Claim creation → outbound call                         | **No**                                                                      | stale `in_flight` (>60 s) → lookup → same-key retry                                                    |
| Outbound Mombongo call                                 | External, not atomic with Firestore                                         | idempotency key + reconciliation lookup                                                                |
| Response persistence (offer doc + claim `completed`)   | Yes (one transaction)                                                       | Mombongo succeeded but this failed → stale claim → lookup finds the offer                              |
| Inbox claim                                            | Yes (one transaction)                                                       | —                                                                                                      |
| Inbox claim → offer update                             | **No**                                                                      | inbox stays `received`/`failed`; redelivery resumes                                                    |
| Offer status update (read-check-write)                 | Yes (one transaction)                                                       | —                                                                                                      |
| Offer update → inbox `processed`                       | **No**                                                                      | redelivery re-applies as a no-op                                                                       |
| Invoice create → offer accept (`invoice_issued`)       | **No** (invoice `setDoc`, then outcome tx)                                  | invoice existence dedupes redelivery; offer accept re-applied by reconciliation/`offer_status_changed` |
| Reconciliation page                                    | **No** (item by item; import = create-pending then apply)                   | idempotent re-examination via overlap; interrupted import leaves a pending offer                       |
| Reconciliation boundary advancement                    | Yes (one compare-and-set transaction) — but not atomic with page processing | boundary only advances after the page is handled; a crash before it just replays the page              |

## 5b. Accepted-offer enrichment (Mombongo PR #70)

Verified against mombongo-functions merge commit `5ff75b72ed973b4a00a5a4a5b49dfb956e8abaf1` (default branch
`feature/s2-00-data-foundation`). `getExternalHarvestOffer(s)` add `seller` / `listing` for **accepted** offers
only (`null`/`null` for pending/declined; `seller: {id, displayName: null}` + `listing: null` when the listing
cannot be read or matched; thumbnail = ~1 h signed URL). Both are optional in `ExternalHarvestOfferDto` so an
older Mombongo build keeps working.

`mombongoOfferEnrichment.ts` is the only consumer: it sanitizes field by field (no spreads, no unknown keys, no
email/phone-like names, https `storage.googleapis.com` thumbnails only, an already-expired thumbnail is not
stored) and `applyOfferEnrichment` writes `mombongoSeller` / `mombongoListing` / `mombongoEnrichmentSourceAt`
in one transaction on an EXISTING accepted/won offer — never creating an offer, never touching status,
`invoiceId`, `lastEventId`, `mombongoOccurredAt`, `updatedAt`, checkout or payment. The seller id is frozen,
an older `sourceAt` cannot replace a newer snapshot, and a null never erases a stored value (Mombongo degrades
to less detail on a transient failure). Reconciliation calls it after the outcome step for both `applied` and
the same-state `already_applied` path, and treats any enrichment problem as non-fatal (no issue, no pin).

**Refresh operation (`POST /api/mombongo/refresh-receivable-offers`).** Lifecycle reconciliation pages by the
offer's own `updatedAt`, so it can never enrich an offer accepted before enrichment shipped nor renew a lapsed
thumbnail. A separate, user-triggered, bounded presentation refresh does: it lists **accepted** offers only with
**no** `updatedSince` (historical included), and applies the same planner (`planEnrichmentUpdate`) to offers that
already exist locally as accepted/won. Two independent lanes: business data (seller/listing product/place) obeys
the remote-`updatedAt` monotonic guard; the thumbnail is a short-lived credential renewed when missing, expired or
under 30 min from expiry (never rewritten while comfortably valid), even when `updatedAt` has not moved. A failed
renewal leaves a still-valid image and all other metadata untouched. It also fills a missing `invoiceId`. It never
creates an offer, changes a status, or touches the reconciliation checkpoint, invoices, receptions, checkout or
payment.

- **Authorization:** verified ID token + that uid's own profile only — active `admin`, or active staff with poste
  exactly `Agent de collecte`. 401 unauthenticated, 403 anyone else (Directeur de Production, Chargée de
  Commercialisation, Personnalisé/poste-less staff, partners, inactive). The body/query are never read.
- **Bounds (server constants):** 50 offers/page, at most 4 pages (200 offers), separate absolute ceiling of 6 remote
  requests, cursor-cycle stop. A run that hits a cap reports `partial`, never `complete`. Mombongo lists oldest-changed
  first, so the cap covers the 200 oldest accepted offers — far above the pilot volume and Mobile's cache (newest
  100); if accepted offers ever exceed it a checkpoint or a descending list is needed (not built, no second durable
  checkpoint until volume demands it).
- **Throttle:** in-process (per Worker isolate) — equivalent concurrent refreshes share one run; another within 20 s
  answers 429 `throttled`. Best-effort by design: correctness never depends on it (idempotent updates of existing
  documents only). No cron, queue or scheduler.
- **Response:** `{status: complete|partial|unavailable, examined, refreshed, unchanged, skipped, shouldReread}`, or
  `{status: throttled, retryAfterMs}` — never credentials, signatures, payloads, names or thumbnail URLs; never an
  instruction to clear a cache. 200/429/502.

## 6. Payment boundary

`createMombongoHarvestCheckout` always returns `reception_approval_required` (403); route scoped to
`harvestInvoices` only. Facts needed to unlock it, all server-readable and none client-supplied: exact
`harvestInvoiceId` ↔ `mombongoOfferId`; a reception record (actual quantity, evidence, receiving actor/time);
a purchase-specific quality decision = conform; an explicit approval by an authorized actor (uid + time); invoice
still `a_payer`. None exist in any repository today.

## 7. Cutover compatibility

Writes only `accepted`/`declined`, never `won`; requires the Backend `mombongoReconciliationState` Rules (PR #14) to be deployed before the reconcile route is used. The deployed (pre-v2) Worker writes `pending→won`: keep Backend
**transitional** Rules until this Worker is live and no `won` writes occur, then deploy **final** Rules.

## 8. AROM-Mobile follow-up (read-only audit, Mobile `mombongo-offers-redesign`, PR #5 merged)

- `model.ts:56,75,79-80` status type / label map / `isKnownHarvestOfferStatus` know only `pending|won` → an `accepted`
  or `declined` doc is **silently filtered out** by `offerSelectors.ts:12` (offers vanish from "Mes offres").
- Normalize legacy `won` → `accepted` at read time; add `declined` (label, badge icon/colour in `OfferStatusBadge.tsx:15-21`).
- `offerSelectors.ts:18-29` counts and `adminSummary.ts:313-329` summary carry `won`; `MombongoOffersCard.tsx:45,69-71`
  and `SentOffersTab.tsx:14,51-53,71-72,135,156-162` hard-code two buckets/filters/copy → add accepted + declined
  buckets, filters, counts, and card layout for a third stat.
- Nothing calls `/api/mombongo/reconcile-offers`; plug into the existing `harvest-listings.tsx:77,97`
  pull-to-refresh/focus flow (`useAutoRefresh`/`refreshRolePlan`), tolerate the 429 throttle, and render the new summary
  (`status`, `reason`, `imported`, `updated`, `conflicts`, `blocked`, `issues`, `checkpoint`). Reconciliation-imported offers carry
  `createdByUid: "system:mombongo-reconciliation"`, so Mobile's `createdByUid === uid` filter hides them — Mobile must
  decide how to show AROM-owned imported offers.
- `harvestOffers` sync category (`syncPlan.ts:140`, `adminCache.ts:27`) is fine offline, but cached docs may carry
  `won`/`accepted`/`declined` and new fields (`externalReference`, `invoiceId`) — parsing must not reject them.
- Offer→invoice link is by `listingId` only (`SentOffersTab.tsx:117-119`, `harvest-offer/[id].tsx:60`) — must switch to
  exact `offer.invoiceId` (or `harvestInvoices.mombongoOfferId`) now that both exist.
- `harvest-invoice/[id]/index.tsx:112-113` shows "Payer la facture" → `/harvest-invoice/[id]/pay`; checkout is now always
  403 → replace with "En attente de réception et d'approbation" copy, disable the pay action.
- `mombongoHarvestGateway.ts:99,107` maps only 400→rejected; new 409 results (`in_flight`, `conflict`, `unknown`,
  `reference_mismatch`) fall into the generic error — add explicit copy ("ne renvoyez pas / vérification en cours").
- Returned `offer.id` is now a random UUID, not derived from `listingId` (Mobile treats it as opaque; verify
  routing/keys only).
