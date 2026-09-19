import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  where,
} from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import type { HarvestOfferDoc } from "./mombongoHarvest";
import { RECONCILIATION_ACTOR } from "./mombongoActors";
export { RECONCILIATION_ACTOR };

/**
 * Shared authoritative-outcome application for a Mombongo harvest offer —
 * the one place that actually writes `status: "accepted" | "declined"`
 * onto a `harvestOffers` doc, whether the fact arrived via the
 * `offer_status_changed` webhook or a reconciliation pass. Both callers
 * must behave identically here (contract v2, Section D task: "Webhook and
 * reconciliation must not have different authorization loopholes" —
 * verified true: both sign in as the same isMombongoWebhook() identity
 * via mombongoSystemAuth, enforced by AROM-Backend's firestore.rules, not
 * just by this function's own discipline).
 *
 * Correlation is exact: prefer the doc whose id equals `externalReference`
 * (createMombongoOffer always writes the offer doc under that exact id —
 * see mombongoHarvest.ts), falling back to a `mombongoOfferId` query only
 * when no externalReference is available or that direct lookup misses
 * (e.g. a pre-v2 offer, or the offer doc hasn't been persisted yet —
 * "tolerate event delivery before the submission response is stored").
 * Never correlates by `listingId` alone.
 */
export type ConflictCode = "offer_id_mismatch" | "terminal_status_conflict";

export type ApplyOfferOutcomeResult =
  | { kind: "applied"; offerDocId: string }
  | { kind: "already_applied"; offerDocId: string }
  | { kind: "stale"; offerDocId: string; reason: string }
  | { kind: "conflict"; offerDocId: string; reason: string; code: ConflictCode }
  | { kind: "not_found"; reason: string };

export interface ApplyOfferOutcomeInput {
  mombongoOfferId: string;
  externalReference: string | null;
  status: "accepted" | "declined";
  occurredAt: string;
  eventId: string;
  invoiceId?: string;
}

/** 'won' is canonically 'accepted' for every comparison below — never written as a fresh value, only read-normalized or explicitly normalized on touch. */
function canonicalStatus(raw: HarvestOfferDoc["status"]): "pending" | "accepted" | "declined" {
  return raw === "won" ? "accepted" : raw;
}

export async function findOfferDocId(input: ApplyOfferOutcomeInput): Promise<string | null> {
  return (await findOfferDoc(input))?.id ?? null;
}

/**
 * The exact-correlation lookup findOfferDocId has always done, but returning
 * the document too, so a caller that only needs to read it does not pay a
 * second read. Same rules: by externalReference (the doc's own id) first,
 * else by Mombongo offer id, and an ambiguous match is "not found".
 */
export async function findOfferDoc(
  input: Pick<ApplyOfferOutcomeInput, "mombongoOfferId" | "externalReference">,
): Promise<{ id: string; data: HarvestOfferDoc } | null> {
  if (input.externalReference) {
    const direct = await getDoc(doc(serverDb, "harvestOffers", input.externalReference));
    if (direct.exists()) return { id: direct.id, data: direct.data() as HarvestOfferDoc };
  }
  // Fallback: pre-v2 offers (created before externalReference existed) or
  // a mismatched/absent externalReference — correlate by Mombongo's own
  // offerId instead. Capped at 2: an ambiguous match (more than one local
  // offer sharing the same mombongoOfferId, which should never happen
  // given createMombongoOffer's own one-doc-per-listing invariant, but is
  // not provably impossible for pre-v2 data) is treated as "not found"
  // rather than guessing which one to update.
  const q = query(
    collection(serverDb, "harvestOffers"),
    where("mombongoOfferId", "==", input.mombongoOfferId),
    limit(2),
  );
  const snap = await getDocs(q);
  if (snap.size === 1) return { id: snap.docs[0].id, data: snap.docs[0].data() as HarvestOfferDoc };
  return null;
}

export async function applyMombongoOfferOutcome(
  input: ApplyOfferOutcomeInput,
): Promise<ApplyOfferOutcomeResult> {
  const offerDocId = await findOfferDocId(input);
  if (!offerDocId) {
    return {
      kind: "not_found",
      reason:
        "Aucune offre locale ne correspond à cette référence Mombongo — l'événement sera rejoué plus tard si l'offre apparaît.",
    };
  }
  const offerRef = doc(serverDb, "harvestOffers", offerDocId);

  return runTransaction(serverDb, async (tx): Promise<ApplyOfferOutcomeResult> => {
    const snap = await tx.get(offerRef);
    if (!snap.exists()) {
      return {
        kind: "not_found",
        reason: "L'offre a été supprimée entre la corrélation et l'application.",
      };
    }
    const offer = snap.data() as HarvestOfferDoc;
    // Exact correlation must hold in both directions: a doc found by
    // externalReference that carries a DIFFERENT Mombongo offer id is a
    // correlation inconsistency, never something to overwrite.
    if (offer.mombongoOfferId && offer.mombongoOfferId !== input.mombongoOfferId) {
      return {
        kind: "conflict",
        code: "offer_id_mismatch",
        offerDocId,
        reason: `L'offre locale ${offerDocId} référence l'offre Mombongo ${offer.mombongoOfferId}, pas ${input.mombongoOfferId}.`,
      };
    }
    const before = canonicalStatus(offer.status);
    const storedOccurredAt = offer.mombongoOccurredAt ?? "";

    if (before === input.status) {
      // Same-state: idempotent replay or a legitimately-later metadata
      // refresh. Skip entirely if the incoming event is not newer than
      // what's already stored — both to avoid a no-op write and because
      // Rules would reject a backward mombongoOccurredAt anyway.
      if (input.occurredAt <= storedOccurredAt && storedOccurredAt !== "") {
        return { kind: "already_applied", offerDocId };
      }
      tx.update(offerRef, {
        // Explicit normalization: touching a legacy 'won' record always
        // writes the canonical 'accepted' value, never re-writes 'won'.
        status: input.status,
        mombongoOccurredAt: input.occurredAt,
        lastEventId: input.eventId,
        updatedAt: new Date().toISOString(),
        ...(input.invoiceId && !offer.invoiceId ? { invoiceId: input.invoiceId } : {}),
      });
      return { kind: "applied", offerDocId };
    }

    if (before === "pending") {
      tx.update(offerRef, {
        status: input.status,
        mombongoOccurredAt: input.occurredAt,
        lastEventId: input.eventId,
        updatedAt: new Date().toISOString(),
        ...(input.invoiceId && !offer.invoiceId ? { invoiceId: input.invoiceId } : {}),
      });
      return { kind: "applied", offerDocId };
    }

    // before is a terminal status ('accepted' or 'declined') different
    // from the incoming one — a genuine conflicting terminal outcome.
    // Never overwritten here; the caller records this in
    // mombongoWebhookEvents (processingState: 'conflict') for
    // investigation, per AROM-Backend's own transition matrix ("record a
    // reconciliation conflict for investigation" — accepted<->declined
    // has no legal Rules transition, so an attempted write would be
    // rejected anyway; this check exists to classify *why* rather than
    // relying on a raw Firestore permission-denied).
    if (input.occurredAt < storedOccurredAt) {
      return {
        kind: "stale",
        offerDocId,
        reason: `Événement plus ancien (${input.occurredAt}) qu'un état déjà enregistré (${storedOccurredAt}) — ignoré.`,
      };
    }
    return {
      kind: "conflict",
      code: "terminal_status_conflict",
      offerDocId,
      reason: `L'offre est déjà '${before}' localement ; un nouvel événement rapporte '${input.status}'.`,
    };
  });
}

export interface RemoteOfferForImport {
  offerId: string;
  externalReference: string | null;
  listingId: string | null;
  quantityKg: number;
  unitPriceCdf: number;
  currency: string;
  createdAt: string | null;
}

export type ImportBlockCode =
  | "missing_offer_id"
  | "missing_listing_id"
  | "missing_created_at"
  | "unexpected_currency"
  | "invalid_quantity"
  | "invalid_price"
  | "unsafe_local_id"
  | "local_id_offer_mismatch";

export type ImportRemoteOfferResult =
  | { kind: "imported"; offerDocId: string }
  | { kind: "exists"; offerDocId: string }
  | { kind: "blocked"; code: ImportBlockCode };

/**
 * Reconstructs a missing local `harvestOffers` doc from authoritative
 * Mombongo fields — only when every required field is really present.
 * Ownership is provable: the DTO comes from getExternalHarvestOffers, whose
 * partnerId is taken from the verified x-partner-id header, never the body,
 * so every returned offer is this partner's. Nothing is fabricated: no
 * listing, quantity, price or createdAt is invented (missing => blocked),
 * and no user actor is assumed (see RECONCILIATION_ACTOR).
 *
 * Merged Rules force `status: 'pending'` at create, so the doc is created
 * pending; a remote accepted/declined is applied as a second, separate
 * step by the caller (applyMombongoOfferOutcome). If that second step is
 * interrupted the offer simply exists as pending and the next run applies
 * it. Doc id = externalReference when present (AROM's own identity, same
 * scheme as createMombongoOffer), else `mombongo-<offerId>`.
 */
export async function importRemoteOffer(
  dto: RemoteOfferForImport,
): Promise<ImportRemoteOfferResult> {
  if (!dto.offerId) return { kind: "blocked", code: "missing_offer_id" };
  if (!dto.listingId) return { kind: "blocked", code: "missing_listing_id" };
  if (!dto.createdAt) return { kind: "blocked", code: "missing_created_at" };
  if (dto.currency !== "CDF") return { kind: "blocked", code: "unexpected_currency" };
  if (!Number.isFinite(dto.quantityKg) || dto.quantityKg <= 0)
    return { kind: "blocked", code: "invalid_quantity" };
  if (!Number.isFinite(dto.unitPriceCdf) || dto.unitPriceCdf <= 0)
    return { kind: "blocked", code: "invalid_price" };
  const docId = dto.externalReference || `mombongo-${dto.offerId}`;
  if (docId.includes("/")) return { kind: "blocked", code: "unsafe_local_id" };

  const ref = doc(serverDb, "harvestOffers", docId);
  return runTransaction(serverDb, async (tx): Promise<ImportRemoteOfferResult> => {
    const existing = await tx.get(ref);
    if (existing.exists()) {
      const local = existing.data() as HarvestOfferDoc;
      return local.mombongoOfferId === dto.offerId
        ? { kind: "exists", offerDocId: docId }
        : { kind: "blocked", code: "local_id_offer_mismatch" };
    }
    const offer: HarvestOfferDoc & { importedFrom: string; importedAt: string } = {
      id: docId,
      listingId: dto.listingId!,
      mombongoOfferId: dto.offerId,
      offerQuantityKg: dto.quantityKg,
      offerPricePerKgCdf: dto.unitPriceCdf,
      message: null,
      commodity: null,
      province: null,
      territory: null,
      quality: null,
      status: "pending",
      createdAt: dto.createdAt!,
      createdByUid: RECONCILIATION_ACTOR,
      ...(dto.externalReference ? { externalReference: dto.externalReference } : {}),
      importedFrom: "reconciliation",
      importedAt: new Date().toISOString(),
    };
    tx.set(ref, offer);
    return { kind: "imported", offerDocId: docId };
  });
}
