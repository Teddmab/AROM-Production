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
export type ApplyOfferOutcomeResult =
  | { kind: "applied"; offerDocId: string }
  | { kind: "already_applied"; offerDocId: string }
  | { kind: "stale"; offerDocId: string; reason: string }
  | { kind: "conflict"; offerDocId: string; reason: string }
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

async function findOfferDocId(input: ApplyOfferOutcomeInput): Promise<string | null> {
  if (input.externalReference) {
    const direct = await getDoc(doc(serverDb, "harvestOffers", input.externalReference));
    if (direct.exists()) return direct.id;
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
  if (snap.size === 1) return snap.docs[0].id;
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
      offerDocId,
      reason: `L'offre est déjà '${before}' localement ; un nouvel événement rapporte '${input.status}'.`,
    };
  });
}
