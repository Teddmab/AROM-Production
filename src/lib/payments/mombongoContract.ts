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

// --- POST /createExternalHarvestOffer — contract v2 (verified against
// mombongo-functions PR #69, merged commit 960ed54, default branch
// feature/s2-00-data-foundation). Headers gain Idempotency-Key
// (1-200 chars, no "/"); body gains externalReference. `submissionStatus`
// deliberately replaces `status` — v1's "accepted" collided "your HTTP
// request was accepted" with "the farmer accepted your offer" in one
// word. `submissionStatus: "submitted"` only ever means the former;
// business acceptance is exclusively the offer_status_changed webhook. ---

export interface CreateExternalHarvestOfferRequestV2 {
  listingId: string;
  offerQuantityKg: number;
  offerPricePerKgCdf: number;
  message?: string;
  externalReference: string;
}

export interface CreateExternalHarvestOfferResponseV2 {
  submissionStatus: "submitted";
  offerId: string;
  externalReference: string | null;
  replayed: boolean;
}

export const createExternalHarvestOfferResponseV2Fixture: CreateExternalHarvestOfferResponseV2 = {
  submissionStatus: "submitted",
  offerId: "offer_8801",
  externalReference: "arom-ext-ref-1",
  replayed: false,
};

// --- POST /getExternalHarvestOffer (reconciliation, single lookup) —
// exactly one of offerId/externalReference; cross-partner and genuine
// absence both return 404, deliberately indistinguishable. ---

export interface GetExternalHarvestOfferRequest {
  offerId?: string;
  externalReference?: string;
}

export interface ExternalHarvestOfferDto {
  offerId: string;
  externalReference: string | null;
  listingId: string | null;
  status: "pending" | "accepted" | "declined" | null;
  quantityKg: number;
  unitPriceCdf: number;
  currency: "CDF";
  createdAt: string | null;
  updatedAt: string | null;
  invoiceId: string | null;
}

export const externalHarvestOfferDtoFixture: ExternalHarvestOfferDto = {
  offerId: "offer_8801",
  externalReference: "arom-ext-ref-1",
  listingId: "listing_701",
  status: "pending",
  quantityKg: 200,
  unitPriceCdf: 780,
  currency: "CDF",
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
  invoiceId: null,
};

// --- POST /getExternalHarvestOffers (reconciliation, paginated list) ---

export interface GetExternalHarvestOffersRequest {
  status?: "pending" | "accepted" | "declined";
  updatedSince?: string;
  limit?: number;
  cursor?: string;
}

export interface GetExternalHarvestOffersResponse {
  offers: ExternalHarvestOfferDto[];
  nextCursor: string | null;
}

// --- Inbound POST /api/webhooks/mombongo — event: "offer_status_changed"
// (contract v2, schemaVersion 1). eventId is deterministic
// (sha256("offer_status_changed <offerId> <status>")) — a retry/manual
// resend reuses the identical eventId, which is what AROM dedupes on. ---

export interface MombongoOfferStatusChangedEvent {
  event: "offer_status_changed";
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  partnerId: string;
  offerId: string;
  externalReference: string | null;
  listingId: string;
  status: "accepted" | "declined";
  quantityKg: number;
  unitPriceCdf: number;
  currency: "CDF";
}

export const offerStatusChangedEventFixture: MombongoOfferStatusChangedEvent = {
  event: "offer_status_changed",
  eventId: "evt-offer-accepted-1",
  schemaVersion: 1,
  occurredAt: "2026-09-19T12:00:00.000Z",
  partnerId: "arom-partner-1",
  offerId: "offer_8801",
  externalReference: "arom-ext-ref-1",
  listingId: "listing_701",
  status: "accepted",
  quantityKg: 200,
  unitPriceCdf: 780,
  currency: "CDF",
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

// --- Inbound POST /api/webhooks/mombongo — event: "invoice_issued",
// contract v2 (schemaVersion 2). Additive over v1: eventId/schemaVersion/
// occurredAt/offerId/externalReference/unitPriceCdf/totalAmountCdf/
// currency are new; every v1 field is still present unchanged. offerId is
// null for an admin-assisted invoice (no offer exists for that origin —
// not reachable via AROM's own harvest-marketplace flow, kept for parity
// with Mombongo's own schema). ---

export interface MombongoInvoiceIssuedEventV2 {
  event: "invoice_issued";
  eventId: string;
  schemaVersion: 2;
  occurredAt: string;
  invoiceId: string;
  offerId: string | null;
  externalReference: string | null;
  farmerId: string;
  listingId: string | null;
  quantityKg: number;
  unitPriceCdf: number;
  totalAmountCdf: number;
  currency: "CDF";
  amountUsd: number;
  commodity: string;
}

export const invoiceIssuedEventV2Fixture: MombongoInvoiceIssuedEventV2 = {
  event: "invoice_issued",
  eventId: "evt-invoice-9002",
  schemaVersion: 2,
  occurredAt: "2026-09-19T12:05:00.000Z",
  invoiceId: "mombongo_inv_9002",
  offerId: "offer_8801",
  externalReference: "arom-ext-ref-1",
  farmerId: "farmer_42",
  listingId: "listing_701",
  quantityKg: 200,
  unitPriceCdf: 780,
  totalAmountCdf: 156000,
  currency: "CDF",
  amountUsd: 156,
  commodity: "ananas",
};
