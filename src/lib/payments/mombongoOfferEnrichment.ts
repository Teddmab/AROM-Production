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
  /** The stored snapshot already says everything this one does. */
  | { kind: "unchanged" }
  /** A newer snapshot is already stored — an older response never regresses it. */
  | { kind: "stale" }
  | { kind: "skipped"; reason: "not_found" | "offer_id_mismatch" | "not_accepted" }
  /** The response names a different seller than the one already frozen on the offer. Never overwritten. */
  | { kind: "conflict"; reason: "seller_id_changed" };

function canonicalStatus(raw: HarvestOfferDoc["status"]): "pending" | "accepted" | "declined" {
  return raw === "won" ? "accepted" : raw;
}

/** A null/missing incoming value never erases a stored one: Mombongo degrades to less detail on a transient read failure. */
function keep<T>(incoming: T | null, stored: T | null | undefined): T | null {
  return incoming ?? stored ?? null;
}

function mergeListing(
  incoming: HarvestOfferDoc["mombongoListing"] | undefined,
  stored: HarvestOfferDoc["mombongoListing"] | undefined,
): NonNullable<HarvestOfferDoc["mombongoListing"]> | undefined {
  if (!incoming && !stored) return undefined;
  // A fresher thumbnail (later expiry) replaces the stored one; an older or absent one never does.
  const useIncomingThumb =
    !!incoming?.thumbnailUrl &&
    (!stored?.thumbnailExpiresAt ||
      (incoming.thumbnailExpiresAt ?? "") >= stored.thumbnailExpiresAt);
  const thumb = useIncomingThumb ? incoming : stored;
  return {
    commodity: keep(incoming?.commodity ?? null, stored?.commodity),
    commodityCode: keep(incoming?.commodityCode ?? null, stored?.commodityCode),
    province: keep(incoming?.province ?? null, stored?.province),
    territory: keep(incoming?.territory ?? null, stored?.territory),
    thumbnailUrl: thumb?.thumbnailUrl ?? null,
    thumbnailExpiresAt: thumb?.thumbnailUrl ? (thumb?.thumbnailExpiresAt ?? null) : null,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Writes a sanitized snapshot onto an EXISTING accepted/won offer, in one
 * transaction, touching only the three enrichment fields. Exact identity is
 * re-checked inside the transaction (`mombongoOfferId` must match); seller id
 * is frozen once set; an older `sourceAt` can never replace a newer one; a
 * null never erases a stored value. No `updatedAt`, `lastEventId`,
 * `mombongoOccurredAt`, status or invoice write happens here — a metadata
 * refresh is not a lifecycle event.
 */
export async function applyOfferEnrichment(input: {
  offerDocId: string;
  mombongoOfferId: string;
  snapshot: OfferEnrichmentSnapshot;
}): Promise<ApplyEnrichmentResult> {
  const { offerDocId, mombongoOfferId, snapshot } = input;
  const ref = doc(serverDb, "harvestOffers", offerDocId);
  return runTransaction(serverDb, async (tx): Promise<ApplyEnrichmentResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { kind: "skipped", reason: "not_found" };
    const offer = snap.data() as HarvestOfferDoc;
    if (offer.mombongoOfferId !== mombongoOfferId)
      return { kind: "skipped", reason: "offer_id_mismatch" };
    if (canonicalStatus(offer.status) !== "accepted")
      return { kind: "skipped", reason: "not_accepted" };

    const storedAt = offer.mombongoEnrichmentSourceAt ?? "";
    if (snapshot.sourceAt < storedAt) return { kind: "stale" };
    if (offer.mombongoSeller && snapshot.seller && offer.mombongoSeller.id !== snapshot.seller.id) {
      return { kind: "conflict", reason: "seller_id_changed" };
    }

    const seller = snapshot.seller
      ? {
          id: offer.mombongoSeller?.id ?? snapshot.seller.id,
          displayName: keep(snapshot.seller.displayName, offer.mombongoSeller?.displayName),
        }
      : offer.mombongoSeller;
    const listing = mergeListing(snapshot.listing, offer.mombongoListing);

    if (
      snapshot.sourceAt === storedAt &&
      sameJson(seller, offer.mombongoSeller) &&
      sameJson(listing, offer.mombongoListing)
    ) {
      return { kind: "unchanged" };
    }
    tx.update(ref, {
      ...(seller ? { mombongoSeller: seller } : {}),
      ...(listing ? { mombongoListing: listing } : {}),
      mombongoEnrichmentSourceAt: snapshot.sourceAt,
    });
    return { kind: "applied" };
  });
}
