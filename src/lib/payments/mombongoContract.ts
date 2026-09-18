/**
 * Checked-in shapes + one fixture per shape for every Mombongo boundary
 * currently implemented (mombongo.ts, mombongoHarvest.ts, and the inbound
 * webhook). This is deliberately not an OpenAPI spec — just enough that
 * route-parsing tests and mobile-facing response tests share one
 * hand-written source of truth instead of independently guessing shapes.
 *
 * These describe the integration as implemented today, verified working
 * end-to-end once (2026-08-31/09-01, see
 * AROM-Documentation/mombongo-integration-audit.md). They are NOT a
 * partner-approved spec — Mombongo's own API is currently returning
 * 500/503 (see that audit), and fields like `testMode` are AROM's own
 * assumption pending a real response to confirm against.
 */

// --- POST /createExternalInvoice ---

export interface CreateExternalInvoiceRequest {
  externalInvoiceId: string;
  amountUsd: number;
  currency: "USD";
  dueDate?: string;
  reference?: string;
}

export interface CreateExternalInvoiceResponse {
  status: "accepted" | "duplicate_ignored";
  invoiceId: string;
}

export const createExternalInvoiceRequestFixture: CreateExternalInvoiceRequest = {
  externalInvoiceId: "producerInvoice_abc123",
  amountUsd: 42.5,
  currency: "USD",
  dueDate: "2026-10-01",
  reference: "AROM-REF-001",
};

export const createExternalInvoiceResponseFixture: CreateExternalInvoiceResponse = {
  status: "accepted",
  invoiceId: "mombongo_inv_9001",
};

// --- POST /createExternalInvoiceCheckout ---

export interface CreateExternalInvoiceCheckoutRequest {
  invoiceId: string;
  method: "card" | "mobile_money";
  phone?: string;
  operator?: "mpesa" | "airtel" | "orange";
}

export interface CreateExternalInvoiceCheckoutResponse {
  status: "checkout_created";
  providerRef: string;
  clientSecret?: string;
  depositStatus?: string;
}

export const createExternalInvoiceCheckoutRequestFixture: CreateExternalInvoiceCheckoutRequest = {
  invoiceId: "mombongo_inv_9001",
  method: "mobile_money",
  phone: "+243900000000",
  operator: "airtel",
};

export const createExternalInvoiceCheckoutResponseFixture: CreateExternalInvoiceCheckoutResponse = {
  status: "checkout_created",
  providerRef: "provref_5001",
  depositStatus: "pending",
};

// --- POST /getExternalPublishedListings ---

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

export interface GetExternalPublishedListingsResponse {
  listings: HarvestListing[];
}

export const harvestListingFixture: HarvestListing = {
  id: "listing_701",
  commodity: "ananas",
  province: "Kasaï",
  territory: "Demba",
  quantityKg: 500,
  quality: "A",
  pricePerKgCdf: 800,
  sellerId: "farmer_42",
};

export const getExternalPublishedListingsResponseFixture: GetExternalPublishedListingsResponse = {
  listings: [harvestListingFixture],
};

// --- POST /createExternalHarvestOffer ---

export interface CreateExternalHarvestOfferRequest {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
  message?: string;
}

export interface CreateExternalHarvestOfferResponse {
  status: "accepted";
  offerId: string;
}

export const createExternalHarvestOfferRequestFixture: CreateExternalHarvestOfferRequest = {
  listingId: "listing_701",
  offerQuantityKg: 200,
  offerPricePerKgCdf: 780,
  message: "Offre AROM",
};

export const createExternalHarvestOfferResponseFixture: CreateExternalHarvestOfferResponse = {
  status: "accepted",
  offerId: "offer_8801",
};

// --- Inbound POST /api/webhooks/mombongo — event: "payment_complete" ---

export interface MombongoPaymentCompleteEvent {
  event: "payment_complete";
  externalInvoiceId: string;
  status: "paid";
  amountUsd?: number;
  paidAt?: string;
}

export const paymentCompleteEventFixture: MombongoPaymentCompleteEvent = {
  event: "payment_complete",
  externalInvoiceId: "producerInvoice_abc123",
  status: "paid",
  amountUsd: 42.5,
  paidAt: "2026-09-17T00:00:00.000Z",
};

// --- Inbound POST /api/webhooks/mombongo — event: "invoice_issued" ---

export interface MombongoInvoiceIssuedEvent {
  event: "invoice_issued";
  invoiceId: string;
  farmerId: string;
  listingId: string;
  amountUsd: number;
  quantityKg: number;
  commodity: string;
}

export const invoiceIssuedEventFixture: MombongoInvoiceIssuedEvent = {
  event: "invoice_issued",
  invoiceId: "mombongo_inv_9002",
  farmerId: "farmer_42",
  listingId: "listing_701",
  amountUsd: 156,
  quantityKg: 200,
  commodity: "ananas",
};
