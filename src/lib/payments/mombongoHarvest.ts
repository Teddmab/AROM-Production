import { doc, getDoc, runTransaction, updateDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { hashSha256Hex } from "./mombongoSigning";
import { signedMombongoPost } from "./mombongo";

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
  status: "pending" | "won";
  createdAt: string;
  createdByUid: string;
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
  /** A *different* proposal (different qty/price) is in flight for this same listing right now. */
  | { status: "conflict"; message: string }
  /**
   * The prior attempt on this listing is in a state where AROM cannot
   * prove whether Mombongo created an offer or not (a request timed out,
   * the Worker was interrupted, or the response was malformed) — or a
   * prior attempt was definitively rejected. Either way, no automatic
   * retry is safe; see claimOfferSubmission's own doc comment.
   */
  | { status: "unknown"; message: string }
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
}

function offerFingerprint(input: {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
}): string {
  return `${input.listingId}:${input.offerQuantityKg}:${input.offerPricePerKgCdf}`;
}

type ClaimAttempt =
  | { kind: "won" }
  | { kind: "already_completed"; harvestOfferId?: string }
  | { kind: "in_flight_same" }
  | { kind: "in_flight_conflict" }
  | { kind: "blocked"; priorStatus: "rejected" | "unknown" };

/**
 * Server-owned submission-claim state machine (2026-09 hardening): the
 * required invariant is "AROM must not intentionally call Mombongo's
 * offer-submission API more than once for one canonical listing, unless a
 * documented human recovery decision explicitly authorizes another
 * attempt." A Firestore-doc-level dedup (the previous version of this
 * function) cannot guarantee that — two concurrent requests can both pass
 * a pre-check before either writes the final `harvestOffers` doc, so both
 * call Mombongo. This closes that gap by reserving a claim, in its own
 * `mombongoOfferClaims` collection, *before* calling Mombongo at all.
 *
 * `mombongoOfferClaims` is deliberately separate from `harvestOffers`:
 * the latter's firestore.rules require a real `mombongoOfferId` (which
 * doesn't exist yet at claim time) at create, and only allow an update to
 * touch `status` — relaxing either would be a bigger, riskier rules
 * change than adding one new, narrowly-scoped collection that only this
 * trusted server identity can ever read or write (see
 * AROM-Backend/firestore.rules' own `mombongoOfferClaims` block and its
 * PR for the exact grant).
 *
 * Firestore transactions provide real cross-request atomicity here (this
 * is not a client-side check): if two requests race to create the same
 * claim doc, only one's transaction commits — the other's automatically
 * retries (Firestore's own optimistic-concurrency retry), observes the
 * winner's write, and returns a non-"won" outcome *before ever calling
 * Mombongo*. This is the actual fix for the "two simultaneous requests"
 * scenario the previous design could only partially close.
 *
 * States are intentionally monotonic and never auto-expire:
 * `in_flight -> {completed, rejected, unknown}`, and there is no
 * transition back out of `rejected`/`unknown`/`completed` — once a
 * listing has been attempted, only a documented human recovery workflow
 * (not built here — see this repo's PR description) may authorize a new
 * attempt. Time elapsed alone never proves the first request failed, so
 * nothing here ever auto-unsticks a stale `in_flight`/`unknown` claim.
 */
async function claimOfferSubmission(
  input: CreateOfferInput,
  claimRef: ReturnType<typeof doc>,
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
      };
      tx.set(claimRef, claim);
      return { kind: "won" };
    }
    const claim = snap.data() as OfferClaim;
    if (claim.status === "completed")
      return { kind: "already_completed", harvestOfferId: claim.harvestOfferId };
    if (claim.status === "in_flight") {
      return claim.fingerprint === fingerprint
        ? { kind: "in_flight_same" }
        : { kind: "in_flight_conflict" };
    }
    // "rejected" or "unknown" — both terminal and blocking, regardless of
    // whether this new attempt's fingerprint matches the prior one.
    return { kind: "blocked", priorStatus: claim.status };
  });
}

/**
 * Duplicate-offer protection (2026-09, hardened): see claimOfferSubmission
 * for the state machine this drives. The one gap that remains — and
 * cannot be closed without a partner-side contract change — is a Worker
 * process interrupted (crash, eviction) *after* Mombongo has already
 * returned success but *before* this function's own completion
 * transaction below runs at all: the claim is left `in_flight` forever
 * (correctly blocking any further automatic attempt on this listing —
 * see item below on why that's the safe failure mode), but the
 * `harvestOffers` doc is never created, and Mombongo's own API has no
 * polling/lookup endpoint (confirmed in
 * AROM-Documentation/mombongo-integration-audit.md §3) to reconcile
 * against. This is a genuine, currently irreducible gap: closing it needs
 * either an upstream idempotency/lookup capability Mombongo doesn't
 * expose today, or infrastructure guarantees (e.g. a durable outbox with
 * at-least-once retry semantics) well beyond this change's scope. It is
 * not hidden — a stuck claim requires a documented manual/ops recovery
 * step, not an automatic retry.
 */
export async function createMombongoOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
  const claimId = await hashSha256Hex(input.listingId);
  const claimRef = doc(serverDb, "mombongoOfferClaims", claimId);
  const offerRef = doc(serverDb, "harvestOffers", claimId);
  const fingerprint = offerFingerprint(input);

  const attempt = await claimOfferSubmission(input, claimRef, fingerprint);

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
    // Claim says completed but the offer doc is missing (shouldn't
    // happen — they're written in the same transaction below — but
    // failing honestly here beats fabricating a fake offer).
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
    return {
      status: "unknown",
      message:
        attempt.priorStatus === "rejected"
          ? "Une tentative précédente sur cette annonce a été rejetée — contactez le support technique avant de réessayer."
          : "L'état d'une tentative précédente sur cette annonce n'a pas pu être confirmé — contactez le support technique avant de réessayer.",
    };
  }

  // attempt.kind === "won" — this request, and only this one, may call Mombongo.
  let httpResult: { httpStatus: number; data: { status?: string; offerId?: string } };
  try {
    httpResult = await signedMombongoPost<{ status?: string; offerId?: string }>(
      "/createExternalHarvestOffer",
      {
        listingId: input.listingId,
        offerQuantityKg: input.offerQuantityKg,
        offerPricePerKgCdf: input.offerPricePerKgCdf,
        message: input.message,
      },
    );
  } catch (err) {
    // Network failure, timeout, config error, etc. — deliberately not
    // distinguished from "Mombongo may have received it": erring toward
    // the safe (blocking) outcome is always acceptable here, where
    // erring toward "safe to retry" is not.
    console.error("createMombongoOffer: signedMombongoPost threw", err);
    await markClaim(claimRef, "unknown");
    return {
      status: "unknown",
      message:
        "La confirmation de Mombongo n'a pas pu être obtenue — contactez le support technique avant de réessayer.",
    };
  }

  const { httpStatus, data } = httpResult;

  if (httpStatus === 400) {
    // Authoritative rejection with proof no offer was created.
    await markClaim(claimRef, "rejected");
    return {
      status: "rejected",
      httpStatus,
      message:
        "Mombongo a rejeté cette offre (annonce inactive, quantité trop élevée, ou prix invalide).",
    };
  }
  if (httpStatus !== 200 || data.status !== "accepted" || !data.offerId) {
    // Any other non-success (500, malformed body, etc.) does NOT prove
    // Mombongo didn't create the offer — treat as unknown, not a plain
    // retryable "error".
    await markClaim(claimRef, "unknown");
    return {
      status: "unknown",
      message:
        "La réponse de Mombongo était inattendue — contactez le support technique avant de réessayer.",
    };
  }

  // AROM's own record of the offer — Mombongo has no "won"/"declined"
  // notification (per their spec: "poll is not available yet"), so this
  // starts "pending" and only ever advances to "won", via the
  // invoiceIssued webhook matching listingId back to this doc. A
  // never-updated "pending" offer legitimately just means it wasn't
  // picked — there is no other signal to distinguish that from "still
  // being considered," which is worth surfacing honestly in the UI
  // rather than guessing a false "declined" state.
  const persistedOffer: HarvestOfferDoc = {
    id: claimId,
    listingId: input.listingId,
    mombongoOfferId: data.offerId,
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
  };

  // Both writes in ONE transaction — closes the "Mombongo succeeded but
  // the Worker died between writing harvestOffers and completing the
  // claim" window entirely (the one window this design CAN close: if
  // this transaction commits at all, both documents land together).
  await runTransaction(serverDb, async (tx) => {
    tx.set(offerRef, persistedOffer);
    tx.update(claimRef, {
      status: "completed",
      harvestOfferId: claimId,
      updatedAt: new Date().toISOString(),
    });
  });

  return {
    status: "accepted",
    offerDocId: claimId,
    mombongoOfferId: data.offerId,
    offer: persistedOffer,
    alreadyExisted: false,
  };
}

async function markClaim(
  claimRef: ReturnType<typeof doc>,
  status: "rejected" | "unknown",
): Promise<void> {
  await updateDoc(claimRef, { status, updatedAt: new Date().toISOString() });
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
      status: "already_in_progress" | "not_found" | "provider_error" | "error";
      httpStatus: number;
      message: string;
    };

export async function createMombongoHarvestCheckout(
  input: CreateHarvestCheckoutInput,
): Promise<CreateHarvestCheckoutResult> {
  const invoiceSnap = await getDoc(doc(serverDb, "harvestInvoices", input.harvestInvoiceId));
  if (!invoiceSnap.exists()) {
    return { status: "not_found", httpStatus: 404, message: "harvestInvoices doc not found." };
  }

  const { httpStatus, data: result } = await signedMombongoPost<{
    status: string;
    providerRef?: string;
    clientSecret?: string;
    depositStatus?: string;
  }>("/createExternalInvoiceCheckout", {
    invoiceId: input.harvestInvoiceId,
    method: input.method,
    phone: input.method === "mobile_money" ? input.phone : undefined,
    operator: input.method === "mobile_money" ? input.operator : undefined,
  });

  if (httpStatus === 409) {
    return {
      status: "already_in_progress",
      httpStatus,
      message: "Checkout already in progress for this invoice.",
    };
  }
  if (httpStatus === 404) return { status: "not_found", httpStatus, message: "Invoice not found." };
  if (httpStatus === 502) {
    return {
      status: "provider_error",
      httpStatus,
      message: "Mombongo's payment provider rejected the request.",
    };
  }
  if (httpStatus !== 200 || result.status !== "checkout_created" || !result.providerRef) {
    return { status: "error", httpStatus, message: `Mombongo returned ${httpStatus}` };
  }

  // Same "only the trusted server path makes this transition" invariant
  // as producerInvoices' createMombongoCheckout — already signed in as
  // the system account via getMombongoConfig() inside signedMombongoPost.
  await updateDoc(doc(serverDb, "harvestInvoices", input.harvestInvoiceId), {
    statut: "paiement_en_attente",
    mombongoCheckout: {
      method: input.method,
      providerRef: result.providerRef,
      ...(result.clientSecret ? { clientSecret: result.clientSecret } : {}),
      ...(result.depositStatus ? { depositStatus: result.depositStatus } : {}),
      testMode: true,
    },
  });

  return {
    status: "checkout_created",
    providerRef: result.providerRef,
    clientSecret: result.clientSecret,
    depositStatus: result.depositStatus,
  };
}
