import { doc, getDoc, updateDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { convertFcToUsd, getUsdToCdfRate } from "./exchangeRate";
import { getMombongoConfig } from "./mombongoConfig";
import { signHmac } from "./mombongoSigning";

/**
 * Real calls to Mombongo's deployed "AROM Invoice Payment API" (Sprint
 * AI, their side) — confirmed live on europe-west1/mombongo-dev (see
 * AROM-Backend/scripts/check-mombongo-deployment.mjs) and confirmed
 * working end-to-end with a real signed request, 2026-08-31. Unlike
 * pawapay.ts, these are NOT stubs: the endpoints are real, so there's
 * nothing to fake.
 *
 * Plain functions, not `createServerFn`s — same correction as the
 * webhook route (see routes/api/webhooks/mombongo.ts's doc comment):
 * `createServerFn` is internal RPC for this app's own frontend.
 * AROM-Mobile, a *different* app, is the real caller — it reaches these
 * through routes/api/mombongo/{create-invoice,create-checkout}.ts, which
 * verify the calling admin's Firebase ID token (verifyMombongoCaller.ts)
 * before calling the functions below.
 *
 * Partner id + secrets come from `externalIntegrations/mombongo` in
 * Firestore (see mombongoConfig.ts), not Worker env vars — rotating a
 * secret or onboarding a second partner later never needs a deployment.
 */

/** Exported for mombongoHarvest.ts (Sprint DP: listings/offers) — same signing seam, same secret, same base URL. */
export async function signedMombongoPost<T>(
  path: string,
  body: unknown,
): Promise<{ httpStatus: number; data: T }> {
  const config = await getMombongoConfig();

  const rawBody = JSON.stringify(body);
  const signature = await signHmac(config.inboundSigningSecret, rawBody);

  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-partner-id": config.partnerId,
      "x-partner-signature": signature,
    },
    body: rawBody,
  });

  const data = (await res.json().catch(() => ({}))) as T;
  return { httpStatus: res.status, data };
}

export interface CreateInvoiceInput {
  /** producerInvoices doc id — the amount is read from this doc server-side, never trusted from the caller (a client-supplied payment amount is not a security boundary worth having). */
  producerInvoiceId: string;
  reference?: string;
  dueDate?: string;
}

export type CreateInvoiceResult =
  | { status: "accepted" | "duplicate_ignored"; mombongoInvoiceId: string }
  | { status: "not_found" | "unsupported_currency" | "error"; httpStatus: number; message: string };

export async function createMombongoInvoice(
  input: CreateInvoiceInput,
): Promise<CreateInvoiceResult> {
  const invoiceSnap = await getDoc(doc(serverDb, "producerInvoices", input.producerInvoiceId));
  if (!invoiceSnap.exists()) {
    return { status: "not_found", httpStatus: 404, message: "producerInvoices doc not found." };
  }
  const invoice = invoiceSnap.data();

  // Their contract (§3) expects USD only. FC and CDF are the same
  // currency (Congolese Franc) — AROM's own field just uses the French
  // abbreviation. Rate comes from config/exchangeRate (exchangeRate.ts),
  // seeded from Mombongo's own config/exchange_rate.usdToCdf so both
  // systems price the same transaction consistently — see that file's
  // doc comment. Any other currency is genuinely unsupported; fail
  // closed rather than guess.
  let amountUsd: number;
  if (invoice.devise === "USD") {
    amountUsd = invoice.montantTotal;
  } else if (invoice.devise === "FC" || invoice.devise === "CDF") {
    const rate = await getUsdToCdfRate();
    amountUsd = convertFcToUsd(invoice.montantTotal, rate);
  } else {
    return {
      status: "unsupported_currency",
      httpStatus: 501,
      message: `No conversion configured for currency "${invoice.devise}".`,
    };
  }

  const { httpStatus, data: result } = await signedMombongoPost<{
    status: string;
    invoiceId: string;
  }>("/createExternalInvoice", {
    externalInvoiceId: input.producerInvoiceId,
    amountUsd,
    currency: "USD",
    dueDate: input.dueDate ?? invoice.dateEcheance,
    reference: input.reference,
  });

  if (
    httpStatus !== 200 ||
    (result.status !== "accepted" && result.status !== "duplicate_ignored")
  ) {
    return { status: "error", httpStatus, message: `Mombongo returned ${httpStatus}` };
  }
  return { status: result.status, mombongoInvoiceId: result.invoiceId };
}

export interface CreateCheckoutInput {
  /** producerInvoices doc id — the checkout write below targets this doc, distinct from mombongoInvoiceId below (Mombongo's own id, returned by createMombongoInvoice). */
  producerInvoiceId: string;
  mombongoInvoiceId: string;
  method: "card" | "mobile_money";
  phone?: string;
  operator?: "mpesa" | "airtel" | "orange";
}

export type CreateCheckoutResult =
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

export async function createMombongoCheckout(
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const { httpStatus, data: result } = await signedMombongoPost<{
    status: string;
    providerRef?: string;
    clientSecret?: string;
    depositStatus?: string;
  }>("/createExternalInvoiceCheckout", {
    invoiceId: input.mombongoInvoiceId,
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

  // The approuvee -> paiement_en_attente transition is exclusively gated
  // on isMombongoWebhook() in firestore.rules (see MOB-07) — the calling
  // admin's own isAdmin() write cannot make it, so this trusted server
  // path makes it on their behalf, only after Mombongo has actually
  // confirmed a checkout session exists. Already signed in as the system
  // account via getMombongoConfig() -> signedMombongoPost() above.
  await updateDoc(doc(serverDb, "producerInvoices", input.producerInvoiceId), {
    statut: "paiement_en_attente",
    mombongoInvoiceId: input.mombongoInvoiceId,
    // MOB-10: the stuck-invoice indicator (producer-invoice/[id]/index.tsx)
    // needs a real "since when" to measure against — this was silently
    // never written before, so every checkout looked equally fresh no
    // matter how long it had actually been pending.
    updatedAt: new Date().toISOString(),
    mombongoCheckout: {
      method: input.method,
      providerRef: result.providerRef,
      ...(result.clientSecret ? { clientSecret: result.clientSecret } : {}),
      ...(result.depositStatus ? { depositStatus: result.depositStatus } : {}),
      // Their contract doesn't echo `testMode` in the checkout response
      // itself (only documents it as an invoice/checkout-level flag
      // inherited from the partner record) — hardcoded true is correct
      // for now since every partner starts in test mode until flipped,
      // but revisit once a real response is seen and confirm whether
      // it's actually present on this payload.
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
