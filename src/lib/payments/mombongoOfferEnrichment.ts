import { doc, runTransaction } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import type { ExternalHarvestOfferDto } from "./mombongoContract";
import type { HarvestOfferDoc } from "./mombongoHarvest";
import { isCheckpointTimestamp } from "./mombongoReconciliationCheckpoint";

/**
 * Accepted-offer enrichment (Mombongo PR #70): seller/listing context that
 * lets a field agent recognise which delivery an accepted offer is.
 *
 * Two rules shape everything here:
 *  1. Enrichment is PRESENTATION CONTEXT. It is copied field by field into
 *     two closed maps on the existing harvestOffers doc; it never touches
 *     status, invoiceId, lastEventId, mombongoOccurredAt, checkout or any
 *     payment state, never creates an offer, and is never reception evidence.
 *  2. The remote response is untrusted. Every value is re-validated and
 *     bounded here (Backend Rules re-check the same limits), unknown keys are
 *     never read, and anything that looks like an email or a phone number in
 *     a name is dropped rather than cleaned up. Missing or malformed
 *     enrichment is not an error: it is simply not stored.
 *
 * The limits below mirror AROM-Backend firestore.rules'
 * isValidMombongoSeller / isValidMombongoListing exactly.
 */
const MAX_ID = 128;
const MAX_NAME = 160;
const MAX_COMMODITY = 120;
const MAX_CODE = 64;
const MAX_PLACE = 120;
const MAX_URL = 2048;
const THUMBNAIL_HOST = "storage.googleapis.com";

export interface OfferEnrichmentSnapshot {
  /** The remote offer `updatedAt` this snapshot was read at — the monotonic stale-protection key. */
  sourceAt: string;
  seller?: NonNullable<HarvestOfferDoc["mombongoSeller"]>;
  listing?: NonNullable<HarvestOfferDoc["mombongoListing"]>;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** A free-text name field can hold an email or a phone number — those are dropped, never "cleaned". */
function safeDisplayName(value: unknown): string | null {
  const name = boundedString(value, MAX_NAME);
  if (!name) return null;
  if (name.includes("@")) return null;
  if ((name.match(/\d/g) ?? []).length >= 7) return null;
  return name;
}

function safeThumbnail(value: unknown, now: number): { url: string; expiresAt: string } | null {
  if (!value || typeof value !== "object") return null;
  const t = value as { url?: unknown; expiresAt?: unknown };
  const url = boundedString(t.url, MAX_URL);
  if (!url || !isCheckpointTimestamp(t.expiresAt)) return null;
  // Already expired at read time: worthless as a picture, so it is not stored at all.
  if (Date.parse(t.expiresAt) <= now) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== THUMBNAIL_HOST) return null;
  } catch {
    return null;
  }
  return { url, expiresAt: t.expiresAt };
}

/**
 * Builds the sanitized snapshot from a remote offer, or `null` when there is
 * nothing safe to store (not accepted, older response shape, or every part
 * invalid). Never throws.
 */
export function sanitizeOfferEnrichment(
  dto: ExternalHarvestOfferDto,
  now: number = Date.now(),
): OfferEnrichmentSnapshot | null {
  try {
    if (!dto || dto.status !== "accepted" || !isCheckpointTimestamp(dto.updatedAt)) return null;

    let seller: OfferEnrichmentSnapshot["seller"];
    const rawSeller = dto.seller;
    if (rawSeller && typeof rawSeller === "object") {
      const id = boundedString(rawSeller.id, MAX_ID);
      if (id) seller = { id, displayName: safeDisplayName(rawSeller.displayName) };
    }

    let listing: OfferEnrichmentSnapshot["listing"];
    const rawListing = dto.listing;
    if (rawListing && typeof rawListing === "object") {
      const thumbnail = safeThumbnail(rawListing.thumbnail, now);
      const candidate = {
        commodity: boundedString(rawListing.commodity, MAX_COMMODITY),
        commodityCode: boundedString(rawListing.commodityCode, MAX_CODE),
        province: boundedString(rawListing.province, MAX_PLACE),
        territory: boundedString(rawListing.territory, MAX_PLACE),
        thumbnailUrl: thumbnail?.url ?? null,
        thumbnailExpiresAt: thumbnail?.expiresAt ?? null,
      };
      if (Object.values(candidate).some((v) => v !== null)) listing = candidate;
    }

    if (!seller && !listing) return null;
    return {
      sourceAt: dto.updatedAt,
      ...(seller ? { seller } : {}),
      ...(listing ? { listing } : {}),
    };
  } catch {
    return null;
  }
}

export type ApplyEnrichmentResult =
  | { kind: "applied" }
  /** Nothing to write: the stored data already says everything this response does (and no thumbnail needs renewing). */
  | { kind: "unchanged" }
  /** The response's BUSINESS data is older than what is stored, and it carried nothing else worth writing. */
  | { kind: "stale" }
  | { kind: "skipped"; reason: "not_found" | "offer_id_mismatch" | "not_accepted" }
  /** The response names a different seller than the one already frozen on the offer. Never overwritten. */
  | { kind: "conflict"; reason: "seller_id_changed" };

/**
 * A thumbnail is a short-lived credential (about an hour), not business data:
 * it is renewed once less than this remains — never continuously rewritten
 * while it is still comfortably valid.
 */
export const THUMBNAIL_RENEW_BEFORE_MS = 30 * 60 * 1000;

const MAX_INVOICE_ID = 200;

function canonicalStatus(raw: HarvestOfferDoc["status"]): "pending" | "accepted" | "declined" {
  return raw === "won" ? "accepted" : raw;
}

/** A null/missing incoming value never erases a stored one: Mombongo degrades to less detail on a transient read failure. */
function keep<T>(incoming: T | null, stored: T | null | undefined): T | null {
  return incoming ?? stored ?? null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

type StoredListing = NonNullable<HarvestOfferDoc["mombongoListing"]>;

/** True when the stored thumbnail is missing, expired, or about to expire. */
export function thumbnailNeedsRenewal(listing: StoredListing | undefined, now: number): boolean {
  if (!listing?.thumbnailUrl || !listing.thumbnailExpiresAt) return true;
  const expires = Date.parse(listing.thumbnailExpiresAt);
  return !Number.isFinite(expires) || expires - now < THUMBNAIL_RENEW_BEFORE_MS;
}

function safeInvoiceId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_INVOICE_ID &&
    !value.includes("/")
    ? value
    : null;
}

export type EnrichmentPlan =
  | { kind: "skipped"; reason: "offer_id_mismatch" | "not_accepted" }
  | { kind: "conflict"; reason: "seller_id_changed" }
  | { kind: "stale" }
  | { kind: "unchanged" }
  | { kind: "update"; patch: Record<string, unknown> };

/**
 * Pure decision: what (if anything) should be written onto this stored offer
 * for this sanitized remote snapshot. Two INDEPENDENT lanes:
 *
 *  - BUSINESS data (seller, listing product/place) obeys the remote
 *    `updatedAt` monotonic guard: a response older than `mombongoEnrichmentSourceAt`
 *    changes none of it; an equal or newer one only fills/refreshes it, and a
 *    null never erases a stored value. The seller id is frozen.
 *  - The THUMBNAIL is a short-lived credential. It is renewed whenever the
 *    stored one is missing, expired or near expiry — even when the offer's
 *    business `updatedAt` has not moved, and even from a response whose
 *    business data is stale — but only to a LATER expiry, and never rewritten
 *    while still comfortably valid. A failed or absent renewal leaves whatever
 *    is stored untouched, so a still-valid image survives and everything else
 *    stays usable.
 *
 * A missing `invoiceId` correlation (set once, immutable afterwards under
 * Rules) may be filled from the remote offer's own `invoiceId`.
 * Status, lastEventId, mombongoOccurredAt and updatedAt are never part of a patch.
 */
export function planEnrichmentUpdate(
  offer: HarvestOfferDoc,
  input: {
    mombongoOfferId: string;
    snapshot: OfferEnrichmentSnapshot;
    invoiceId?: unknown;
    now: number;
  },
): EnrichmentPlan {
  const { snapshot, now } = input;
  if (offer.mombongoOfferId !== input.mombongoOfferId)
    return { kind: "skipped", reason: "offer_id_mismatch" };
  if (canonicalStatus(offer.status) !== "accepted")
    return { kind: "skipped", reason: "not_accepted" };
  if (offer.mombongoSeller && snapshot.seller && offer.mombongoSeller.id !== snapshot.seller.id) {
    return { kind: "conflict", reason: "seller_id_changed" };
  }

  const storedAt = offer.mombongoEnrichmentSourceAt ?? "";
  const staleBusiness = snapshot.sourceAt < storedAt;
  const storedListing = offer.mombongoListing;

  // --- business lane ---
  let seller = offer.mombongoSeller;
  let listing: StoredListing | undefined = storedListing;
  if (!staleBusiness) {
    if (snapshot.seller) {
      seller = {
        id: offer.mombongoSeller?.id ?? snapshot.seller.id,
        displayName: keep(snapshot.seller.displayName, offer.mombongoSeller?.displayName),
      };
    }
    if (snapshot.listing || storedListing) {
      listing = {
        commodity: keep(snapshot.listing?.commodity ?? null, storedListing?.commodity),
        commodityCode: keep(snapshot.listing?.commodityCode ?? null, storedListing?.commodityCode),
        province: keep(snapshot.listing?.province ?? null, storedListing?.province),
        territory: keep(snapshot.listing?.territory ?? null, storedListing?.territory),
        thumbnailUrl: storedListing?.thumbnailUrl ?? null,
        thumbnailExpiresAt: storedListing?.thumbnailUrl
          ? (storedListing.thumbnailExpiresAt ?? null)
          : null,
      };
    }
  }

  // --- thumbnail lane ---
  const incomingThumb = snapshot.listing?.thumbnailUrl ? snapshot.listing : null;
  if (listing && incomingThumb && thumbnailNeedsRenewal(listing, now)) {
    const storedExpiry = listing.thumbnailExpiresAt ?? "";
    if (!listing.thumbnailUrl || (incomingThumb.thumbnailExpiresAt ?? "") > storedExpiry) {
      listing = {
        ...listing,
        thumbnailUrl: incomingThumb.thumbnailUrl,
        thumbnailExpiresAt: incomingThumb.thumbnailExpiresAt,
      };
    }
  }

  // --- correlation ---
  const invoiceId = safeInvoiceId(input.invoiceId);
  const fillInvoice = invoiceId !== null && !offer.invoiceId;

  const sellerChanged = !sameJson(seller, offer.mombongoSeller);
  const listingChanged = !sameJson(listing, offer.mombongoListing);
  const sourceAtAdvances = !staleBusiness && snapshot.sourceAt > storedAt;
  const needsSourceAt = (sellerChanged || listingChanged) && !offer.mombongoEnrichmentSourceAt;

  if (!sellerChanged && !listingChanged && !fillInvoice && !sourceAtAdvances)
    return { kind: staleBusiness ? "stale" : "unchanged" };
  return {
    kind: "update",
    patch: {
      ...(sellerChanged && seller ? { mombongoSeller: seller } : {}),
      ...(listingChanged && listing ? { mombongoListing: listing } : {}),
      ...(sourceAtAdvances || needsSourceAt
        ? { mombongoEnrichmentSourceAt: snapshot.sourceAt }
        : {}),
      ...(fillInvoice ? { invoiceId } : {}),
    },
  };
}

function toResult(plan: Exclude<EnrichmentPlan, { kind: "update" }>): ApplyEnrichmentResult {
  return plan.kind === "skipped" || plan.kind === "conflict" ? plan : { kind: plan.kind };
}

/**
 * Writes a planned patch onto an EXISTING accepted/won offer in one
 * transaction (identity and status re-checked inside it, so a concurrent
 * change is planned against the fresh document). Touches only
 * mombongoSeller / mombongoListing / mombongoEnrichmentSourceAt and a missing
 * invoiceId — no `updatedAt`, `lastEventId`, `mombongoOccurredAt`, status,
 * checkout or payment write, and it can never create a document.
 */
export async function applyOfferEnrichment(input: {
  offerDocId: string;
  mombongoOfferId: string;
  snapshot: OfferEnrichmentSnapshot;
  invoiceId?: unknown;
  now?: number;
}): Promise<ApplyEnrichmentResult> {
  const { offerDocId, mombongoOfferId, snapshot } = input;
  const ref = doc(serverDb, "harvestOffers", offerDocId);
  return runTransaction(serverDb, async (tx): Promise<ApplyEnrichmentResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { kind: "skipped", reason: "not_found" };
    const plan = planEnrichmentUpdate(snap.data() as HarvestOfferDoc, {
      mombongoOfferId,
      snapshot,
      invoiceId: input.invoiceId,
      now: input.now ?? Date.now(),
    });
    if (plan.kind !== "update") return toResult(plan);
    tx.update(ref, plan.patch);
    return { kind: "applied" };
  });
}

/**
 * Same as applyOfferEnrichment, but when the caller already holds the offer
 * document it plans against that copy first and only opens a transaction if a
 * write is actually needed — the common "nothing to do" case costs no
 * transaction (relevant for a bounded refresh that examines many offers).
 */
export async function applyOfferEnrichmentIfNeeded(input: {
  offerDocId: string;
  offer: HarvestOfferDoc;
  mombongoOfferId: string;
  snapshot: OfferEnrichmentSnapshot;
  invoiceId?: unknown;
  now?: number;
}): Promise<ApplyEnrichmentResult> {
  const now = input.now ?? Date.now();
  const plan = planEnrichmentUpdate(input.offer, {
    mombongoOfferId: input.mombongoOfferId,
    snapshot: input.snapshot,
    invoiceId: input.invoiceId,
    now,
  });
  if (plan.kind !== "update") return toResult(plan);
  return applyOfferEnrichment({
    offerDocId: input.offerDocId,
    mombongoOfferId: input.mombongoOfferId,
    snapshot: input.snapshot,
    invoiceId: input.invoiceId,
    now,
  });
}
