import { doc, getDoc, runTransaction, setDoc, updateDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
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
  | { status: "rejected" | "error"; httpStatus: number; message: string };

/**
 * Duplicate-offer protection (2026-09): the invariant is "at most one AROM
 * offer per Mombongo listing." The document id is deterministic — the
 * listingId itself — instead of the old random `offer_<ts>_<rand>` scheme,
 * so a retried/duplicate request finds the existing record instead of
 * creating a second one. Pre-existing docs created under the old random-id
 * scheme are untouched; this only governs new submissions going forward.
 *
 * What this closes: a client retry after a timeout where the first
 * request actually succeeded, and a double-tap/second-device request that
 * lands after the first one's Firestore write — both find the existing
 * doc below and return it verbatim (`alreadyExisted: true`), with NO
 * second call to Mombongo's API.
 *
 * What this does NOT close: two requests for the same listing arriving
 * near-simultaneously can both pass the pre-check below before either has
 * written, so both may still call Mombongo's API before the transaction at
 * the bottom resolves which one's Firestore write wins. Closing that fully
 * means reserving the doc (with a real `mombongoOfferId`, which we don't
 * have yet) before calling Mombongo — but AROM-Backend's firestore.rules
 * requires `mombongoOfferId` to already be a string at create time, and
 * only allows an update to touch the `status` key, so there is no way to
 * "claim then fill in" without relaxing those rules — out of scope for
 * this change. The Firestore-side outcome is still fully protected (see
 * the transaction below: at most one document is ever persisted for a
 * given listingId), only a duplicate *external* Mombongo submission in
 * that narrow window is not.
 */
export async function createMombongoOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
  const offerDocId = safeHarvestOfferDocId(input.listingId);
  const ref = offerDocId ? doc(serverDb, "harvestOffers", offerDocId) : null;

  if (ref) {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      const offer = existing.data() as HarvestOfferDoc;
      return {
        status: "accepted",
        offerDocId: offerDocId!,
        mombongoOfferId: offer.mombongoOfferId,
        offer,
        alreadyExisted: true,
      };
    }
  }

  const { httpStatus, data } = await signedMombongoPost<{ status?: string; offerId?: string }>(
    "/createExternalHarvestOffer",
    {
      listingId: input.listingId,
      offerQuantityKg: input.offerQuantityKg,
      offerPricePerKgCdf: input.offerPricePerKgCdf,
      message: input.message,
    },
  );

  if (httpStatus === 400) {
    return {
      status: "rejected",
      httpStatus,
      message:
        "Mombongo a rejeté cette offre (annonce inactive, quantité trop élevée, ou prix invalide).",
    };
  }
  if (httpStatus !== 200 || data.status !== "accepted" || !data.offerId) {
    return { status: "error", httpStatus, message: `Mombongo returned ${httpStatus}` };
  }

  // AROM's own record of the offer — Mombongo has no "won"/"declined"
  // notification (per their spec: "poll is not available yet"), so this
  // starts "pending" and only ever advances to "won", via the
  // invoiceIssued webhook matching listingId back to this doc. A
  // never-updated "pending" offer legitimately just means it wasn't
  // picked — there is no other signal to distinguish that from "still
  // being considered," which is worth surfacing honestly in the UI
  // rather than guessing a false "declined" state.
  // signInAsMombongoSystem() already happened inside signedMombongoPost's
  // getMombongoConfig() call above — this write reuses that session.
  const persistedOffer: HarvestOfferDoc = {
    id: offerDocId ?? `offer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

  if (!ref) {
    // listingId wasn't safe to use as a doc id (see safeHarvestOfferDocId)
    // — fall back to the old random-id write, no dedup guarantee for this
    // one submission rather than crashing doc().
    await setDoc(doc(serverDb, "harvestOffers", persistedOffer.id), persistedOffer);
    return {
      status: "accepted",
      offerDocId: persistedOffer.id,
      mombongoOfferId: data.offerId,
      offer: persistedOffer,
      alreadyExisted: false,
    };
  }

  // Closes the "two concurrent requests both saw 'not exists' above" race
  // at the Firestore layer: whichever transaction commits second re-reads
  // inside the transaction, finds the doc the first one just created, and
  // returns THAT canonical record instead of overwriting it — so at most
  // one Firestore document ever exists per listingId, even though (see
  // this function's own doc comment) both requests may already have
  // called Mombongo's API by this point.
  const finalOffer = await runTransaction(serverDb, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return snap.data() as HarvestOfferDoc;
    tx.set(ref, persistedOffer);
    return persistedOffer;
  });

  return {
    status: "accepted",
    offerDocId: offerDocId!,
    mombongoOfferId: finalOffer.mombongoOfferId,
    offer: finalOffer,
    alreadyExisted: finalOffer.createdAt !== persistedOffer.createdAt,
  };
}

/**
 * Firestore document ids are a single path segment — a listingId
 * containing "/" (or empty) can't be used as one. Mombongo's listingIds
 * have always been simple opaque strings in practice, but this guards the
 * assumption rather than letting doc() throw for an unexpected one.
 */
function safeHarvestOfferDocId(listingId: string): string | null {
  if (!listingId || listingId.includes("/")) return null;
  return listingId;
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
