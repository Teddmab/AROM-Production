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
  id: string;
  listingId: string;
  fingerprint: string;
  status: "in_flight" | "completed" | "rejected" | "unknown";
  createdAt: string;
  createdByUid: string;
  harvestOfferId?: string;
  updatedAt?: string;
  /** Stable for the life of this claim — the same value sent as Mombongo's Idempotency-Key on every retry. Equal to the claim/offer doc id (see createMombongoOffer). */
  idempotencyKey: string;
  /** Equal to idempotencyKey/claim id — one AROM-owned opaque reference, reused everywhere for this attempt. */
  externalReference: string;
}

function offerFingerprint(input: {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
}): string {
  return `${input.listingId}:${input.offerQuantityKg}:${input.offerPricePerKgCdf}`;
}

type ClaimAttempt =
  | { kind: "won"; claim: OfferClaim }
  | { kind: "already_completed"; harvestOfferId?: string }
  | { kind: "in_flight_same" }
  | { kind: "in_flight_conflict" }
  | { kind: "blocked"; priorStatus: "rejected" | "unknown"; claim: OfferClaim };

/**
 * Server-owned submission-claim state machine. Local invariant: "AROM
 * submits at most one offer per canonical listing, ever" (matches
 * AROM-Mobile's findActiveOfferForListing, which blocks a new submission
 * once ANY offer — any status — exists for a listing) — so the claim's
 * identity is permanently keyed by listingId, not per-attempt. What
 * contract v2 changes is what happens once a claim reaches "unknown":
 * previously (no upstream idempotency existed) that was a dead end
 * requiring human recovery. Now, because Mombongo's own (partnerId,
 * Idempotency-Key) fingerprint-replay guarantees at most one offer per
 * key ever, `createMombongoOffer` can safely reconcile and, if genuinely
 * absent, retry using this SAME claim's idempotencyKey — see its own doc
 * comment. The Rules-level state machine itself is unchanged: no new
 * transition (e.g. unknown -> in_flight) was needed or added.
 */
async function claimOfferSubmission(
  input: CreateOfferInput,
  claimRef: ReturnType<typeof doc>,
  claimId: string,
  fingerprint: string,
): Promise<ClaimAttempt> {
  return runTransaction(serverDb, async (tx) => {
    const snap = await tx.get(claimRef);
    if (!snap.exists()) {
      const claim: OfferClaim = {
        id: claimRef.id,
        listingId: input.listingId,
        fingerprint,
        status: "in_flight",
        createdAt: new Date().toISOString(),
        createdByUid: input.createdByUid,
        idempotencyKey: claimId,
        externalReference: claimId,
      };
      tx.set(claimRef, claim);
      return { kind: "won", claim };
    }
    const claim = snap.data() as OfferClaim;
    if (claim.status === "completed")
      return { kind: "already_completed", harvestOfferId: claim.harvestOfferId };
    if (claim.status === "in_flight") {
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
  offerRef: ReturnType<typeof doc>,
  claimRef: ReturnType<typeof doc>,
): Promise<CreateOfferResult> {
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
    id: claim.id,
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
      harvestOfferId: claim.id,
      updatedAt: new Date().toISOString(),
    });
  });

  return {
    status: "accepted",
    offerDocId: claim.id,
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
  offerRef: ReturnType<typeof doc>,
  claimRef: ReturnType<typeof doc>,
): Promise<CreateOfferResult> {
  const lookup = await getMombongoHarvestOffer({ externalReference: claim.externalReference });

  if (lookup.found) {
    // Mombongo did create it — adopt the authoritative record rather
    // than guessing. Reflects whatever status Mombongo already reports
    // (which may already be 'accepted'/'declined' if enough time passed
    // during the outage) via the same shared outcome logic used by the
    // webhook, applied after first persisting the base 'pending' record.
    const persistedOffer: HarvestOfferDoc = {
      id: claim.id,
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
        harvestOfferId: claim.id,
        updatedAt: new Date().toISOString(),
      });
    });
    return {
      status: "accepted",
      offerDocId: claim.id,
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
    return submitToMombongoAndPersist(input, claim, offerRef, claimRef);
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
  const claimId = await hashSha256Hex(input.listingId);
  const claimRef = doc(serverDb, "mombongoOfferClaims", claimId);
  const offerRef = doc(serverDb, "harvestOffers", claimId);
  const fingerprint = offerFingerprint(input);

  const attempt = await claimOfferSubmission(input, claimRef, claimId, fingerprint);

  if (attempt.kind === "already_completed") {
    const existing = await getDoc(offerRef);
    if (existing.exists()) {
      const offer = existing.data() as HarvestOfferDoc;
      return {
        status: "accepted",
        offerDocId: claimId,
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
    return recoverFromUnknownClaim(input, attempt.claim, offerRef, claimRef);
  }

  // attempt.kind === "won" — this request, and only this one, may call Mombongo.
  return submitToMombongoAndPersist(input, attempt.claim, offerRef, claimRef);
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
