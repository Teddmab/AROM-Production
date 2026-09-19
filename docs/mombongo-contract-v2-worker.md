# Mombongo contract v2 — Worker behavior, recovery and atomicity

Scope: `src/lib/payments/mombongo*.ts`, `/api/mombongo/*`, `/api/webhooks/mombongo`.
Verified against mombongo-functions `960ed54` and AROM-Backend `fcb9d56`.

## 1. Offer identity

| Value | Derivation | Sent to Mombongo? |
| --- | --- | --- |
| Claim doc id (`mombongoOfferClaims/{id}`) | `sha256(listingId)` | No — AROM-local lock only |
| `externalReference` | random UUID, generated once inside the claim-creation transaction | Yes (body) |
| `Idempotency-Key` | `arom-harvest-offer-v1:` + the same UUID | Yes (header) |
| `harvestOffers` doc id | = `externalReference` | No |

**Multiple offers per listing?** Not allowed by AROM — a deliberate product rule
(AROM-Mobile `findActiveOfferForListing` matches on `listingId` alone for any
status; `offer.tsx` redirects instead of showing the form; Mobile PR #5 states it).
Mombongo does **not** enforce it (`createHarvestOfferCore` creates a new
`harvest_offers` doc on every call, no per-partner/listing uniqueness). Because
only one side enforces it, the Mombongo-facing identity is deliberately *not*
derived from `listingId`; only the local lock is. Quantity/price/message are
never part of the key — Mombongo's own fingerprint returns 409 on same-key /
different-payload. There is no cancel/replace/amend flow in AROM or Mombongo today.
Single partner (AROM) ⇒ keys are scoped `(partnerId, key)` on Mombongo's side;
UUIDs do not collide.

## 2. Claim states (`mombongoOfferClaims`)

| State | Retry allowed? | Identifiers reused | Lookup first? | Leaves the state when | Crash recovery | Permanently stuck? |
| --- | --- | --- | --- | --- | --- | --- |
| `in_flight` (< 60 s) | No — returns `in_flight`/`conflict` | — | — | request finishes → `completed`/`rejected`/`unknown` | age passes 60 s → treated as `unknown` | No |
| `in_flight` (> 60 s, stale) | Yes, via recovery | stored `externalReference` + `Idempotency-Key` | **Yes** (`getExternalHarvestOffer`) | recovery outcome | this *is* the crash recovery (crash before the call, or after Mombongo succeeded but before persisting) | No |
| `unknown` | Yes, via recovery | stored ids | **Yes** | found → `completed`; 404 → resubmit with same key → `completed`/`rejected`/`unknown`; lookup failure → stays `unknown` | n/a | No — every later call retries recovery |
| `rejected` | No — returns `rejected` locally, even for a changed payload | — | No | never (definitive Mombongo 400/409) | n/a | Yes, **intentionally**: a definitive refusal is not retried automatically (human decision) |
| `completed` | No — returns the original offer (`alreadyExisted`) | `harvestOfferId` | No | terminal | claim + offer written in one transaction | No |

Merged Rules already permit every transition used (`in_flight→*`, `unknown→completed|rejected`); no
`unknown→in_flight` transition is needed or used.

## 3. Reconciliation algorithm (no persisted checkpoint)

The previous "derive `updatedSince` from max local `harvestOffers.updatedAt`" design was **proven unsafe** and
removed: (a) two remote offers with equal `updatedAt` — Mombongo filters `updatedAt >` strictly, so if one of a tied
pair is applied and the other isn't, the derived boundary equals both and the unprocessed twin is skipped forever;
(b) a remote offer with no local doc (`not_found`) never contributes a local timestamp, so a later, newer offer in the
same page moves the boundary past it permanently.

Current algorithm (`reconcileMombongoOffers`): every run requests
`updatedSince = now − 72h` (fixed, wall-clock), pages through `getExternalHarvestOffers` with the cursor used only
inside that one run, and applies each `accepted`/`declined` offer via `applyMombongoOfferOutcome` (idempotent: same
state = no-op, terminal conflict = recorded not overwritten, legacy `won` normalized). Nothing is carried between runs,
so restart, expired cursor, partial failure, ties and mid-run remote updates can only cause *re-examination*, never a
skip. **Not claimed:** this is *not* a checkpoint. Limits: a backlog deeper than `maxPages × pageSize` that persists
longer than 72 h can age out; the summary's `pagesProcessed === maxPages` is the signal.

**Backend follow-up (not made here):** a `mombongoReconciliationState` collection (one doc,
`isMombongoWebhook()` read/write, `{ completedThrough: <ISO>, updatedAt }`, monotonic advance only after a page is
fully applied) would allow a true checkpoint. Existing collections cannot hold it (`externalIntegrations/*` is
`isAdmin()`-write; `mombongoWebhookEvents`/`mombongoOfferClaims` have closed field allow-lists).

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

| Operation | Atomic? | Recovery for the non-atomic part |
| --- | --- | --- |
| Claim creation (identity generation + `in_flight` doc) | Yes (one transaction) | — |
| Claim creation → outbound call | **No** | stale `in_flight` (>60 s) → lookup → same-key retry |
| Outbound Mombongo call | External, not atomic with Firestore | idempotency key + reconciliation lookup |
| Response persistence (offer doc + claim `completed`) | Yes (one transaction) | Mombongo succeeded but this failed → stale claim → lookup finds the offer |
| Inbox claim | Yes (one transaction) | — |
| Inbox claim → offer update | **No** | inbox stays `received`/`failed`; redelivery resumes |
| Offer status update (read-check-write) | Yes (one transaction) | — |
| Offer update → inbox `processed` | **No** | redelivery re-applies as a no-op |
| Invoice create → offer accept (`invoice_issued`) | **No** (invoice `setDoc`, then outcome tx) | invoice existence dedupes redelivery; offer accept re-applied by reconciliation/`offer_status_changed` |
| Reconciliation page | **No** (item by item) | idempotent re-examination next run |
| Reconciliation boundary advancement | **Does not exist** (stateless window) | see §3 |

## 6. Payment boundary

`createMombongoHarvestCheckout` always returns `reception_approval_required` (403); route scoped to
`harvestInvoices` only. Facts needed to unlock it, all server-readable and none client-supplied: exact
`harvestInvoiceId` ↔ `mombongoOfferId`; a reception record (actual quantity, evidence, receiving actor/time);
a purchase-specific quality decision = conform; an explicit approval by an authorized actor (uid + time); invoice
still `a_payer`. None exist in any repository today.

## 7. Cutover compatibility

Writes only `accepted`/`declined`, never `won`. The deployed (pre-v2) Worker writes `pending→won`: keep Backend
**transitional** Rules until this Worker is live and no `won` writes occur, then deploy **final** Rules.

## 8. AROM-Mobile follow-up (read-only audit, Mobile `mombongo-offers-redesign`, PR #5 merged)

- `model.ts:56,75,79-80` status type / label map / `isKnownHarvestOfferStatus` know only `pending|won` → an `accepted`
  or `declined` doc is **silently filtered out** by `offerSelectors.ts:12` (offers vanish from "Mes offres").
- Normalize legacy `won` → `accepted` at read time; add `declined` (label, badge icon/colour in `OfferStatusBadge.tsx:15-21`).
- `offerSelectors.ts:18-29` counts and `adminSummary.ts:313-329` summary carry `won`; `MombongoOffersCard.tsx:45,69-71`
  and `SentOffersTab.tsx:14,51-53,71-72,135,156-162` hard-code two buckets/filters/copy → add accepted + declined
  buckets, filters, counts, and card layout for a third stat.
- Nothing calls `/api/mombongo/reconcile-offers`; plug into the existing `harvest-listings.tsx:77,97`
  pull-to-refresh/focus flow (`useAutoRefresh`/`refreshRolePlan`), tolerate the 429 throttle, show partial-failure /
  conflict summary (`error`, `conflicts`, `notFoundLocally`).
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
