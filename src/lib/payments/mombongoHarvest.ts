import { doc, getDoc, runTransaction, updateDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { hashSha256Hex } from "./mombongoSigning";
import { signedMombongoPost } from "./mombongo";
import type { ExternalHarvestOfferDto } from "./mombongoContract";

/**
 * Mombongo's 2026-09-01 partner-API update (Sprint DP, their side): AROM
 * as a *buyer* on their farmer marketplace, not just a payment-collecting
 * partner. A farmer publishes a harvest listing; AROM browses it here and
 * submits an offer; if the farmer picks it, Mombongo originates the
 * invoice itself and tells AROM via the `invoiceIssued` webhook (see
 * routes/api/webhooks/mombongo.ts) — from there it's paid the normal way
 * (createExternalInvoiceCheckout, unmodified, see mombongo.ts).
 *
 * Separate collections from `producerInvoices` deliberately: a
 * harvest-sale invoice has no AROM-side réception to reconcile against,
 * is already in USD (no FC conversion), and is a different business
 * relationship (buying directly on Mombongo's marketplace vs approving
 * an invoice a producer submitted through AROM's own intake pipeline).
 * Forcing it into producerInvoices' schema/rules would fit neither.
 */

export interface HarvestListing {
  id: string;
  commodity: string;
  province: string;
  territory: string;
  quantityKg: number;
  quality: "A" | "B" | "C";
  pricePerKgCdf: number;
  sellerId: string;
}

export async function getMombongoListings(filters: {
  commodity?: string;
  province?: string;
  limit?: number;
}): Promise<{ listings: HarvestListing[] } | { error: string; httpStatus: number }> {
  const { httpStatus, data } = await signedMombongoPost<{ listings: HarvestListing[] }>(
    "/getExternalPublishedListings",
    {
      commodity: filters.commodity,
      province: filters.province,
      limit: filters.limit,
    },
  );
  if (httpStatus !== 200) {
    return { error: `Mombongo returned ${httpStatus}`, httpStatus };
  }
  return { listings: data.listings ?? [] };
}

export interface CreateOfferInput {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
  message?: string;
  createdByUid: string;
  /**
   * Display-only fields AROM already knows at submission time (from the
   * listing the admin was browsing) — `harvestOffers` itself never carried
   * a product/location field before this, so "Mes offres" had nothing to
   * show but an opaque listingId. Not forwarded to Mombongo's own
   * createExternalHarvestOffer call below — Mombongo already knows its own
   * listing's product from listingId; these exist purely for AROM's own
   * record.
   */
  commodity?: string;
  province?: string;
  territory?: string;
  quality?: "A" | "B" | "C";
}

export interface HarvestOfferDoc {
  id: string;
  listingId: string;
  mombongoOfferId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
  message: string | null;
  commodity: string | null;
  province: string | null;
  territory: string | null;
  quality: "A" | "B" | "C" | null;
  /** 'won' is legacy-only — never written by v2 code, still readable/normalizable. See AROM-Backend/docs/mombongo-contract-v2.md. */
  status: "pending" | "accepted" | "declined" | "won";
  createdAt: string;
  createdByUid: string;
  /** AROM-owned, stable, generated before the outbound call — also this doc's own id and the Idempotency-Key sent to Mombongo. Absent on pre-v2 legacy docs. */
  externalReference?: string | null;
  invoiceId?: string;
  mombongoOccurredAt?: string;
  lastEventId?: string;
  /**
   * Sanitized snapshot of Mombongo's accepted-offer enrichment (see
   * mombongoOfferEnrichment.ts). Provenance is kept explicit: `mombongo*`
   * names say where the values came from, and `mombongoEnrichmentSourceAt`
   * is the remote offer `updatedAt` they were read at. Only ever present on
   * an accepted/won offer; never affects status, invoice or payment state.
   */
  mombongoSeller?: { id: string; displayName: string | null };
  mombongoListing?: {
    commodity: string | null;
    commodityCode: string | null;
    province: string | null;
    territory: string | null;
    /** Signed URL with a short life — presentation context, never reception evidence. Always paired with its expiry. */
    thumbnailUrl: string | null;
    thumbnailExpiresAt: string | null;
  };
  mombongoEnrichmentSourceAt?: string;
}

export type CreateOfferResult =
  | {
      status: "accepted";
      offerDocId: string;
      mombongoOfferId: string;
      offer: HarvestOfferDoc;
      alreadyExisted: boolean;
    }
  | { status: "rejected"; httpStatus: number; message: string }
  /** Same fingerprint (listing+qty+price) is already being submitted by another in-flight request — do not resubmit, this is not a failure. */
  | { status: "in_flight"; message: string }
  /** A *different* proposal is in flight for this listing, or Mombongo itself reported an Idempotency-Key/fingerprint conflict (409). */
  | { status: "conflict"; message: string }
  /**
   * AROM cannot currently prove whether Mombongo created an offer for
   * this attempt (timeout, malformed response, 401/429/5xx, or a prior
   * attempt already in this state) — or a prior attempt was definitively
   * rejected. No automatic retry from the caller is safe; see
   * claimOfferSubmission's doc comment. A *subsequent* call to this same
   * function DOES attempt safe recovery via reconciliation — see below.
   */
  | { status: "unknown"; message: string }
  /** V2 returned an externalReference different from the one AROM sent — fails closed rather than linking the wrong offer. */
  | { status: "reference_mismatch"; message: string }
  | { status: "error"; httpStatus: number; message: string };

interface OfferClaim {
  /** = sha256(listingId) — AROM's own LOCAL one-attempt-per-listing lock, matching AROM-Mobile's findActiveOfferForListing/PR #5 policy (verified, not assumed — see this module's own investigation note below). Never sent to Mombongo. */
  id: string;
  listingId: string;
  fingerprint: string;
  status: "in_flight" | "completed" | "rejected" | "unknown";
  createdAt: string;
  createdByUid: string;
  harvestOfferId?: string;
  updatedAt?: string;
  /** IDEMPOTENCY_KEY_PREFIX + attemptId — the exact value sent as Mombongo's Idempotency-Key header on every retry of this attempt. Never derived from listingId alone (see generateOfferAttemptIdentity's doc comment). */
  idempotencyKey: string;
  /** = attemptId — AROM's own opaque, randomly-generated reference for this specific submission attempt. Also this attempt's harvestOffers doc id once completed. */
  externalReference: string;
}

function offerFingerprint(input: {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
}): string {
  return `${input.listingId}:${input.offerQuantityKg}:${input.offerPricePerKgCdf}`;
}

const IDEMPOTENCY_KEY_PREFIX = "arom-harvest-offer-v1:";

/**
 * A Cloudflare Worker request cannot legitimately stay "in_flight" this
 * long — this is not a race-window tuning knob, it's a floor well above
 * any plausible real request duration (Workers' own hard CPU/wall-clock
 * limits are far shorter), used only to distinguish "still genuinely
 * being processed by a live request right now" from "the request that
 * created this claim is definitely gone." See claimOfferSubmission's own
 * use of this for exactly which crash windows it closes.
 */
const IN_FLIGHT_STALE_THRESHOLD_MS = 60_000;

/**
 * Generates the Mombongo-facing identity for a genuinely new submission
 * attempt — deliberately NOT a function of listingId, quantity, price, or
 * message. Mombongo's own idempotency is scoped to (partnerId,
 * Idempotency-Key), with a content *fingerprint* check that already
 * distinguishes "same key, same payload" (safe replay) from "same key,
 * different payload" (409) — see createExternalHarvestOfferIdempotency.ts
 * in mombongo-functions. Deriving AROM's own key from mutable fields
 * (quantity/price/message) would therefore be actively harmful: a
 * deliberately revised offer would collide with the old key and either
 * 409 or silently replay the stale content, and Mombongo already does
 * this exact detection for us — duplicating it into the key itself is
 * both redundant and unsafe.
 *
 * Investigated (2026-09-19, AROM-Mobile read-only + mombongo-functions
 * source, not assumed): AROM currently submits **at most one offer per
 * listing, ever** — a deliberate, already-documented product decision
 * (AROM-Mobile's findActiveOfferForListing matches on listingId alone
 * regardless of status, offer.tsx redirects to the existing offer instead
 * of showing the form, and Mobile PR #5's own description states this
 * explicitly). Mombongo's own createHarvestOfferCore places NO
 * corresponding restriction — it creates a fresh harvest_offers doc on
 * every call with no per-(partner,listing) uniqueness check at all, so
 * this is entirely AROM's self-imposed policy, not a guarantee either
 * system enforces structurally. Coupling the Mombongo-facing identity to
 * listingId would therefore be fragile: if that mobile-side policy is
 * ever relaxed (a cancel/re-offer feature), reusing the same key for a
 * genuinely new attempt would either silently replay the old offer or
 * 409 against it. Generating a fresh random identity per attempt, kept
 * separate from the LOCAL one-per-listing lock (mombongoOfferClaims'
 * doc id, which legitimately stays keyed by listingId — see OfferClaim's
 * own doc comment), makes the identity scheme correct independent of
 * whether that policy ever changes.
 */
export function generateOfferAttemptIdentity(): {
  externalReference: string;
  idempotencyKey: string;
} {
  const attemptId = crypto.randomUUID();
  return { externalReference: attemptId, idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX}${attemptId}` };
}

type ClaimAttempt =
  | { kind: "won"; claim: OfferClaim }
  | { kind: "already_completed"; harvestOfferId?: string }
  | { kind: "in_flight_same" }
  | { kind: "in_flight_conflict" }
  | { kind: "blocked"; priorStatus: "rejected" | "unknown"; claim: OfferClaim };

/**
 * Server-owned submission-claim state machine. The claim doc's own id
 * (`mombongoOfferClaims/{sha256(listingId)}`) enforces AROM's local
 * one-attempt-per-listing policy atomically (see generateOfferAttemptIdentity's
 * doc comment for why this is a verified, deliberate rule, not an
 * assumption) — but the *content* AROM sends to Mombongo (externalReference,
 * Idempotency-Key) is a fresh random identity generated once when the
 * claim is first created, decoupled from listingId. What contract v2
 * changes is what happens once a claim reaches "unknown": previously (no
 * upstream idempotency existed) that was a dead end requiring human
 * recovery. Now, because Mombongo's own (partnerId, Idempotency-Key)
 * fingerprint-replay guarantees at most one offer per key ever,
 * `createMombongoOffer` can safely reconcile and, if genuinely absent,
 * retry using this SAME claim's idempotencyKey — see its own doc comment.
 * The Rules-level state machine itself is unchanged: no new transition
 * (e.g. unknown -> in_flight) was needed or added.
 */
async function claimOfferSubmission(
  input: CreateOfferInput,
  claimRef: ReturnType<typeof doc>,
  fingerprint: string,
): Promise<ClaimAttempt> {
  return runTransaction(serverDb, async (tx) => {
    const snap = await tx.get(claimRef);
    if (!snap.exists()) {
      const { externalReference, idempotencyKey } = generateOfferAttemptIdentity();
      const claim: OfferClaim = {
        id: claimRef.id,
        listingId: input.listingId,
        fingerprint,
        status: "in_flight",
        createdAt: new Date().toISOString(),
        createdByUid: input.createdByUid,
        idempotencyKey,
        externalReference,
      };
      tx.set(claimRef, claim);
      return { kind: "won", claim };
    }
    const claim = snap.data() as OfferClaim;
    if (claim.status === "completed")
      return { kind: "already_completed", harvestOfferId: claim.harvestOfferId };
    if (claim.status === "in_flight") {
      const ageMs = Date.now() - new Date(claim.createdAt).getTime();
      if (ageMs > IN_FLIGHT_STALE_THRESHOLD_MS) {
        // Genuinely stuck, not a legitimate concurrent race: a Worker
        // request cannot run this long, so whatever created this claim
        // either crashed before ever calling Mombongo, or crashed after
        // Mombongo succeeded but before the completion transaction ran.
        // Either way, AROM cannot tell which from local state alone —
        // route through the exact same reconciliation-based recovery as
        // an "unknown" claim (Mombongo's own fingerprint-conflict check
        // is still the backstop if a retry ever carries different
        // content than whatever Mombongo may already have on file).
        console.warn(
          `mombongoOfferClaims/${claim.id}: stale in_flight claim (${ageMs}ms old) — routing through unknown-claim recovery`,
        );
        return { kind: "blocked", priorStatus: "unknown", claim };
      }
      return claim.fingerprint === fingerprint
        ? { kind: "in_flight_same" }
        : { kind: "in_flight_conflict" };
    }
    return { kind: "blocked", priorStatus: claim.status, claim };
  });
}

async function markClaim(
  claimRef: ReturnType<typeof doc>,
  status: "rejected" | "unknown",
): Promise<void> {
  await updateDoc(claimRef, { status, updatedAt: new Date().toISOString() });
}

/**
 * Calls Mombongo's createExternalHarvestOffer with the claim's stable
 * idempotencyKey/externalReference, persists the result, and marks the
 * claim's terminal state — shared by both a fresh submission and a
 * post-reconciliation retry (same key either way; see
 * claimOfferSubmission's doc comment for why a retry with the same key is
 * now safe under contract v2).
 */
async function submitToMombongoAndPersist(
  input: CreateOfferInput,
  claim: OfferClaim,
  claimRef: ReturnType<typeof doc>,
): Promise<CreateOfferResult> {
  const offerRef = doc(serverDb, "harvestOffers", claim.externalReference);
  let httpResult: {
    httpStatus: number;
    data: {
      status?: string;
      submissionStatus?: string;
      offerId?: string;
      externalReference?: string | null;
      replayed?: boolean;
    };
  };
  try {
    httpResult = await signedMombongoPost(
      "/createExternalHarvestOffer",
      {
        listingId: input.listingId,
        offerQuantityKg: input.offerQuantityKg,
        offerPricePerKgCdf: input.offerPricePerKgCdf,
        message: input.message,
        externalReference: claim.externalReference,
      },
      { "Idempotency-Key": claim.idempotencyKey },
    );
  } catch (err) {
    console.error("createMombongoOffer: signedMombongoPost threw", err);
    await markClaim(claimRef, "unknown");
    return {
      status: "unknown",
      message:
        "La confirmation de Mombongo n'a pas pu être obtenue — une nouvelle tentative sera possible automatiquement.",
    };
  }

  const { httpStatus, data } = httpResult;

  if (httpStatus === 400) {
    await markClaim(claimRef, "rejected");
    return {
      status: "rejected",
      httpStatus,
      message:
        "Mombongo a rejeté cette offre (annonce inactive, quantité trop élevée, ou prix invalide).",
    };
  }
  if (httpStatus === 401) {
    await markClaim(claimRef, "unknown");
    return {
      status: "error",
      httpStatus,
      message:
        "Échec d'authentification auprès de Mombongo — vérifiez la configuration du partenaire.",
    };
  }
  if (httpStatus === 409) {
    // Idempotency-Key reused for a request with a different fingerprint,
    // per Mombongo's own contract — should never happen given AROM always
    // sends identical content for a given key, but is a definitive,
    // non-retryable outcome if it does.
    await markClaim(claimRef, "rejected");
    return {
      status: "conflict",
      message: "Mombongo a signalé un conflit de clé d'idempotence pour cette offre.",
    };
  }
  if (httpStatus === 429) {
    await markClaim(claimRef, "unknown");
    return {
      status: "unknown",
      message:
        "Mombongo a temporairement limité la requête — une nouvelle tentative sera possible automatiquement.",
    };
  }

  const legacyOk = data.status === "accepted" && !!data.offerId;
  const v2Ok = data.submissionStatus === "submitted" && !!data.offerId;
  if (httpStatus !== 200 || (!legacyOk && !v2Ok)) {
    await markClaim(claimRef, "unknown");
    return {
      status: "unknown",
      message:
        "La réponse de Mombongo était inattendue — une nouvelle tentative sera possible automatiquement.",
    };
  }

  // V2 only: validate the returned externalReference matches what AROM
  // sent, rather than ever linking under an unverified id. Legacy
  // responses carry no externalReference at all — nothing to validate.
  if (
    v2Ok &&
    data.externalReference != null &&
    data.externalReference !== claim.externalReference
  ) {
    await markClaim(claimRef, "unknown");
    return {
      status: "reference_mismatch",
      message:
        "Mombongo a renvoyé une référence différente de celle envoyée — contactez le support technique.",
    };
  }

  const alreadyExisted = v2Ok ? data.replayed === true : false;

  // Mombongo's "accepted"/"submitted" means only "this HTTP request was
  // processed" — never business acceptance. This starts "pending" and
  // only ever advances via applyMombongoOfferOutcome (the
  // offer_status_changed webhook, or reconciliation).
  const persistedOffer: HarvestOfferDoc = {
    id: claim.externalReference,
    listingId: input.listingId,
    mombongoOfferId: data.offerId!,
    offerQuantityKg: input.offerQuantityKg,
    offerPricePerKgCdf: input.offerPricePerKgCdf,
    message: input.message ?? null,
    commodity: input.commodity ?? null,
    province: input.province ?? null,
    territory: input.territory ?? null,
    quality: input.quality ?? null,
    status: "pending",
    createdAt: new Date().toISOString(),
    createdByUid: input.createdByUid,
    externalReference: claim.externalReference,
  };

  // One transaction: closes the "Mombongo succeeded but the Worker died
  // before completing the claim" window entirely for THIS attempt (if
  // this transaction commits at all, both documents land together).
  await runTransaction(serverDb, async (tx) => {
    tx.set(offerRef, persistedOffer);
    tx.update(claimRef, {
      status: "completed",
      harvestOfferId: claim.externalReference,
      updatedAt: new Date().toISOString(),
    });
  });

  return {
    status: "accepted",
    offerDocId: claim.externalReference,
    mombongoOfferId: data.offerId!,
    offer: persistedOffer,
    alreadyExisted,
  };
}

/**
 * Ambiguous-timeout recovery (contract v2): queries Mombongo's
 * getExternalHarvestOffer by the claim's own externalReference rather
 * than blindly resubmitting. 404 intentionally does not distinguish
 * "never created" from "belongs to another partner" (Mombongo's own
 * documented isolation behavior) — either way, the only safe next step is
 * a retry with the SAME idempotency key, never a fresh one, never
 * deleting the local claim/pending state.
 */
async function recoverFromUnknownClaim(
  input: CreateOfferInput,
  claim: OfferClaim,
  claimRef: ReturnType<typeof doc>,
): Promise<CreateOfferResult> {
  const offerRef = doc(serverDb, "harvestOffers", claim.externalReference);
  const lookup = await getMombongoHarvestOffer({ externalReference: claim.externalReference });

  if (lookup.found) {
    // Mombongo did create it — adopt the authoritative record rather
    // than guessing. Reflects whatever status Mombongo already reports
    // (which may already be 'accepted'/'declined' if enough time passed
    // during the outage) via the same shared outcome logic used by the
    // webhook, applied after first persisting the base 'pending' record.
    const persistedOffer: HarvestOfferDoc = {
      id: claim.externalReference,
      listingId: input.listingId,
      mombongoOfferId: lookup.offer.offerId,
      offerQuantityKg: input.offerQuantityKg,
      offerPricePerKgCdf: input.offerPricePerKgCdf,
      message: input.message ?? null,
      commodity: input.commodity ?? null,
      province: input.province ?? null,
      territory: input.territory ?? null,
      quality: input.quality ?? null,
      status: "pending",
      createdAt: new Date().toISOString(),
      createdByUid: input.createdByUid,
      externalReference: claim.externalReference,
    };
    await runTransaction(serverDb, async (tx) => {
      const existing = await tx.get(offerRef);
      if (!existing.exists()) tx.set(offerRef, persistedOffer);
      tx.update(claimRef, {
        status: "completed",
        harvestOfferId: claim.externalReference,
        updatedAt: new Date().toISOString(),
      });
    });
    return {
      status: "accepted",
      offerDocId: claim.externalReference,
      mombongoOfferId: lookup.offer.offerId,
      offer: persistedOffer,
      alreadyExisted: true,
    };
  }

  if (lookup.notFound) {
    // Confirmed absent (or isolated — indistinguishable, treated the
    // same): safe to retry with the identical key. Mombongo's own
    // fingerprint-replay guarantee means this either creates the offer
    // fresh or, if it turns out Mombongo actually had it after all,
    // returns it via `replayed: true` — never a duplicate.
    return submitToMombongoAndPersist(input, claim, claimRef);
  }

  // Reconciliation itself failed (network error, 401/429/5xx from
  // getExternalHarvestOffer) — cannot prove absence OR presence. Never
  // delete/downgrade the local claim; leave it exactly as it was for a
  // later, equally-safe retry of this same recovery path.
  return {
    status: "unknown",
    message:
      "La vérification auprès de Mombongo a échoué — une nouvelle tentative sera possible automatiquement.",
  };
}

export async function createMombongoOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
  // claimId is AROM's own LOCAL one-attempt-per-listing lock key — never
  // sent to Mombongo. The Mombongo-facing identity (externalReference,
  // Idempotency-Key) is generated fresh inside claimOfferSubmission, only
  // when a claim doesn't already exist — see generateOfferAttemptIdentity's
  // doc comment for why these must not be the same value.
  const claimId = await hashSha256Hex(input.listingId);
  const claimRef = doc(serverDb, "mombongoOfferClaims", claimId);
  const fingerprint = offerFingerprint(input);

  const attempt = await claimOfferSubmission(input, claimRef, fingerprint);

  if (attempt.kind === "already_completed") {
    if (!attempt.harvestOfferId) {
      return {
        status: "unknown",
        message:
          "L'état de cette offre est incohérent localement — contactez le support technique.",
      };
    }
    const existing = await getDoc(doc(serverDb, "harvestOffers", attempt.harvestOfferId));
    if (existing.exists()) {
      const offer = existing.data() as HarvestOfferDoc;
      return {
        status: "accepted",
        offerDocId: attempt.harvestOfferId,
        mombongoOfferId: offer.mombongoOfferId,
        offer,
        alreadyExisted: true,
      };
    }
    return {
      status: "unknown",
      message: "L'état de cette offre est incohérent localement — contactez le support technique.",
    };
  }
  if (attempt.kind === "in_flight_same") {
    return {
      status: "in_flight",
      message: "Cette offre est déjà en cours d'envoi — ne renvoyez pas.",
    };
  }
  if (attempt.kind === "in_flight_conflict") {
    return {
      status: "conflict",
      message: "Une autre offre est déjà en cours d'envoi pour cette même annonce.",
    };
  }
  if (attempt.kind === "blocked") {
    if (attempt.priorStatus === "rejected") {
      return {
        status: "rejected",
        httpStatus: 400,
        message: "Une tentative précédente sur cette annonce a été rejetée par Mombongo.",
      };
    }
    // priorStatus === "unknown" — attempt safe recovery before giving up.
    return recoverFromUnknownClaim(input, attempt.claim, claimRef);
  }

  // attempt.kind === "won" — this request, and only this one, may call Mombongo.
  return submitToMombongoAndPersist(input, attempt.claim, claimRef);
}

/**
 * Reconciliation single lookup (contract v2). Exactly one of
 * offerId/externalReference — this integration always looks up by
 * externalReference (AROM always has one; Mombongo's own offerId is only
 * known after a successful submission, at which point reconciliation
 * usually isn't needed).
 */
export async function getMombongoHarvestOffer(
  query: { offerId: string } | { externalReference: string },
): Promise<
  | { found: true; offer: ExternalHarvestOfferDto }
  | { found: false; notFound: true }
  | { found: false; notFound: false; httpStatus: number }
> {
  const { httpStatus, data } = await signedMombongoPost<ExternalHarvestOfferDto>(
    "/getExternalHarvestOffer",
    query,
  );
  if (httpStatus === 200) return { found: true, offer: data };
  if (httpStatus === 404) return { found: false, notFound: true };
  return { found: false, notFound: false, httpStatus };
}

/**
 * Reconciliation paginated list (contract v2) — thin wrapper; the actual
 * reconciliation job/checkpoint logic lives in mombongoReconciliation.ts.
 */
export async function getMombongoHarvestOffers(filters: {
  status?: "pending" | "accepted" | "declined";
  updatedSince?: string;
  limit?: number;
  cursor?: string;
}): Promise<
  | { offers: ExternalHarvestOfferDto[]; nextCursor: string | null }
  | { error: string; httpStatus: number }
> {
  const { httpStatus, data } = await signedMombongoPost<{
    offers: ExternalHarvestOfferDto[];
    nextCursor: string | null;
  }>("/getExternalHarvestOffers", filters);
  if (httpStatus !== 200) return { error: `Mombongo returned ${httpStatus}`, httpStatus };
  return { offers: data.offers ?? [], nextCursor: data.nextCursor ?? null };
}

export interface CreateHarvestCheckoutInput {
  harvestInvoiceId: string;
  method: "card" | "mobile_money";
  phone?: string;
  operator?: "mpesa" | "airtel" | "orange";
}

export type CreateHarvestCheckoutResult =
  | {
      status: "checkout_created";
      providerRef: string;
      clientSecret?: string;
      depositStatus?: string;
    }
  | {
      status:
        | "already_in_progress"
        | "not_found"
        | "provider_error"
        | "error"
        | "reception_approval_required";
      httpStatus: number;
      message: string;
    };

/**
 * Payment boundary (contract v2, Section H): AROM-Backend's own
 * investigation confirmed no existing AROM data model — in this repo, in
 * AROM-Backend, or in AROM-Mobile — proves physical receipt of a Mombongo
 * purchase, actual received quantity, purchase-specific quality approval,
 * or an authorized actor's approval to pay. `harvestInvoices` has no such
 * field, and none is invented here. This route is exclusively for
 * `harvestInvoices` (a collection that exists ONLY for Mombongo
 * marketplace purchases — never producerInvoices, never any other
 * invoice type, so gating it here cannot affect any unrelated payment
 * path), so it fails closed unconditionally until that future
 * reception/approval contract exists — no client-supplied field (a
 * boolean, a flag, anything) can ever bypass this, because none is read
 * at all. See AROM-Backend/docs/mombongo-contract-v2.md's own
 * "Reception / payment-approval — unresolved" section for the minimal
 * schema this needs once designed.
 */
export async function createMombongoHarvestCheckout(
  _input: CreateHarvestCheckoutInput,
): Promise<CreateHarvestCheckoutResult> {
  return {
    status: "reception_approval_required",
    httpStatus: 403,
    message:
      "Le paiement de cette facture Mombongo nécessite une réception physique confirmée et une approbation qualité, qui ne sont pas encore prises en charge par AROM. Contactez l'équipe technique.",
  };
}
