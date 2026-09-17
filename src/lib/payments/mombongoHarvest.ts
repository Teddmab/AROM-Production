import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore/lite";
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
}

export type CreateOfferResult =
  | { status: "accepted"; offerDocId: string; mombongoOfferId: string }
  | { status: "rejected" | "error"; httpStatus: number; message: string };

export async function createMombongoOffer(input: CreateOfferInput): Promise<CreateOfferResult> {
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
  const offerDocId = `offer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(doc(serverDb, "harvestOffers", offerDocId), {
    id: offerDocId,
    listingId: input.listingId,
    mombongoOfferId: data.offerId,
    offerQuantityKg: input.offerQuantityKg,
    offerPricePerKgCdf: input.offerPricePerKgCdf,
    message: input.message ?? null,
    status: "pending",
    createdAt: new Date().toISOString(),
    createdByUid: input.createdByUid,
  });

  return { status: "accepted", offerDocId, mombongoOfferId: data.offerId };
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
