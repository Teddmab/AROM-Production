import { createFileRoute } from "@tanstack/react-router";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { getMombongoConfig } from "@/lib/payments/mombongoConfig";
import { verifyHmac } from "@/lib/payments/mombongoSigning";
import { applyMombongoOfferOutcome } from "@/lib/payments/mombongoOfferOutcome";
import {
  claimInboxEvent,
  markInboxConflict,
  markInboxFailed,
  markInboxProcessed,
} from "@/lib/payments/mombongoWebhookInbox";

interface OfferStatusChangedPayload {
  eventId?: string;
  schemaVersion?: number;
  occurredAt?: string;
  offerId?: string;
  externalReference?: string | null;
  status?: string;
  quantityKg?: number;
  unitPriceCdf?: number;
  currency?: string;
}

/**
 * Contract v2 `offer_status_changed` — durable inbox first (create before
 * any harvestOffers write, per "do not acknowledge success if durable
 * recording failed"), then applies the outcome via the shared
 * applyMombongoOfferOutcome (same function reconciliation uses — no
 * separate authorization loophole between the two).
 */
async function handleOfferStatusChanged(payload: OfferStatusChangedPayload): Promise<Response> {
  const {
    eventId,
    schemaVersion,
    occurredAt,
    offerId,
    externalReference,
    status,
    quantityKg,
    unitPriceCdf,
    currency,
  } = payload;
  if (
    !eventId ||
    !occurredAt ||
    !offerId ||
    !status ||
    quantityKg == null ||
    unitPriceCdf == null
  ) {
    return Response.json({ error: "missing_fields" }, { status: 400 });
  }
  if (schemaVersion !== 1) {
    return Response.json({ error: "unsupported_schema_version" }, { status: 400 });
  }
  if (status !== "accepted" && status !== "declined") {
    return Response.json({ error: "unsupported_status" }, { status: 400 });
  }
  if (currency !== "CDF") {
    return Response.json({ error: "unsupported_currency" }, { status: 400 });
  }

  let claim: Awaited<ReturnType<typeof claimInboxEvent>>;
  try {
    claim = await claimInboxEvent({
      eventId,
      eventType: "offer_status_changed",
      schemaVersion,
      occurredAt,
      mombongoOfferId: offerId,
      ...(externalReference ? { externalReference } : {}),
    });
  } catch (err) {
    console.error("offer_status_changed: durable inbox recording failed, not acknowledging", err);
    return Response.json({ error: "durable_recording_failed" }, { status: 500 });
  }

  if (claim.kind === "already_processed")
    return Response.json({ status: "already_processed" }, { status: 200 });
  if (claim.kind === "already_conflict")
    return Response.json({ status: "acknowledged_conflict" }, { status: 200 });

  try {
    const outcome = await applyMombongoOfferOutcome({
      mombongoOfferId: offerId,
      externalReference: externalReference ?? null,
      status,
      occurredAt,
      eventId,
    });

    if (
      outcome.kind === "applied" ||
      outcome.kind === "already_applied" ||
      outcome.kind === "stale"
    ) {
      await markInboxProcessed(claim.ref, outcome.offerDocId);
      return Response.json({ status: "ok" }, { status: 200 });
    }
    if (outcome.kind === "conflict") {
      await markInboxConflict(claim.ref, outcome.reason);
      return Response.json({ status: "acknowledged_conflict" }, { status: 200 });
    }
    // not_found — tolerate arrival before the submission response is
    // stored: recoverable, not a permanent error. A later redelivery or
    // AROM's own reconciliation pass will complete this using the exact
    // same applyMombongoOfferOutcome logic.
    await markInboxFailed(claim.ref, "offer_not_found", outcome.reason);
    return Response.json({ error: "offer_not_found_yet" }, { status: 503 });
  } catch (err) {
    console.error("offer_status_changed: processing failed", err);
    await markInboxFailed(
      claim.ref,
      "processing_error",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}

interface InvoiceIssuedV2Payload {
  eventId?: string;
  schemaVersion?: number;
  occurredAt?: string;
  invoiceId?: string;
  offerId?: string | null;
  externalReference?: string | null;
  farmerId?: string;
  listingId?: string | null;
  quantityKg?: number;
  unitPriceCdf?: number;
  totalAmountCdf?: number;
  currency?: string;
  amountUsd?: number;
  commodity?: string;
}

/**
 * Contract v2 `invoice_issued` (schemaVersion 2) — additive over v1.
 * Correlates via exact mombongoOfferId (never listingId alone); an
 * offerId that matches a local offer whose OWN externalReference
 * disagrees with the payload's is a genuine correlation inconsistency —
 * recorded as a conflict, nothing written, rather than guessing which is
 * right. Never marks anything paid, never triggers checkout, never
 * mutates stock — this only ever creates the `harvestInvoices` record
 * (statut: 'a_payer') and, when correlation is exact, applies 'accepted'
 * to the linked offer via the same shared outcome function the webhook's
 * offer_status_changed path uses.
 */
async function handleInvoiceIssuedV2(payload: InvoiceIssuedV2Payload): Promise<Response> {
  const {
    eventId,
    schemaVersion,
    occurredAt,
    invoiceId,
    offerId,
    externalReference,
    farmerId,
    listingId,
    quantityKg,
    unitPriceCdf,
    totalAmountCdf,
    currency,
    amountUsd,
    commodity,
  } = payload;
  if (
    !eventId ||
    !occurredAt ||
    !invoiceId ||
    !farmerId ||
    quantityKg == null ||
    unitPriceCdf == null ||
    totalAmountCdf == null ||
    amountUsd == null ||
    !commodity
  ) {
    return Response.json({ error: "missing_fields" }, { status: 400 });
  }
  if (schemaVersion !== 2) {
    return Response.json({ error: "unsupported_schema_version" }, { status: 400 });
  }
  if (currency !== "CDF") {
    return Response.json({ error: "unsupported_currency" }, { status: 400 });
  }

  let claim: Awaited<ReturnType<typeof claimInboxEvent>>;
  try {
    claim = await claimInboxEvent({
      eventId,
      eventType: "invoice_issued",
      schemaVersion,
      occurredAt,
      invoiceId,
      ...(offerId ? { mombongoOfferId: offerId } : {}),
      ...(externalReference ? { externalReference } : {}),
    });
  } catch (err) {
    console.error("invoice_issued v2: durable inbox recording failed, not acknowledging", err);
    return Response.json({ error: "durable_recording_failed" }, { status: 500 });
  }

  if (claim.kind === "already_processed")
    return Response.json({ status: "already_processed" }, { status: 200 });
  if (claim.kind === "already_conflict")
    return Response.json({ status: "acknowledged_conflict" }, { status: 200 });

  try {
    // Second, independent idempotency invariant on top of eventId: the
    // invoiceId itself is Mombongo's own id and this doc's own Firestore
    // id — a repeat delivery under a *different* eventId (shouldn't
    // happen, since eventId is deterministic from invoiceId, but not
    // relied upon) still can't create a duplicate invoice.
    const existingInvoice = await getDoc(doc(serverDb, "harvestInvoices", invoiceId));
    if (existingInvoice.exists()) {
      await markInboxProcessed(claim.ref);
      return Response.json({ status: "already_processed" }, { status: 200 });
    }

    let matchedOfferDocId: string | null = null;
    if (offerId) {
      const offerMatches = await getDocs(
        query(
          collection(serverDb, "harvestOffers"),
          where("mombongoOfferId", "==", offerId),
          limit(2),
        ),
      );
      if (offerMatches.size === 1) {
        const matchedOffer = offerMatches.docs[0];
        const matchedExternalRef = (matchedOffer.data().externalReference as string | null) ?? null;
        if (
          externalReference != null &&
          matchedExternalRef != null &&
          matchedExternalRef !== externalReference
        ) {
          await markInboxConflict(
            claim.ref,
            `invoice ${invoiceId} references offerId ${offerId} whose externalReference (${matchedExternalRef}) does not match the payload's (${externalReference}).`,
          );
          return Response.json({ status: "acknowledged_conflict" }, { status: 200 });
        }
        matchedOfferDocId = matchedOffer.id;
      }
      // Zero or ambiguous (>=2) matches: tolerate — the invoice record
      // below is still created (Mombongo's authoritative payable fact
      // stands on its own), just without an offer-side accept applied
      // yet; reconciliation will catch up once the offer exists locally.
    }

    // Never marks paid, never triggers checkout, never touches stock —
    // exactly the same three invariants as the pre-v2 handler below.
    await setDoc(doc(serverDb, "harvestInvoices", invoiceId), {
      id: invoiceId,
      farmerId,
      listingId: listingId ?? null,
      amountUsd,
      quantityKg,
      commodity,
      statut: "a_payer",
      createdAt: new Date().toISOString(),
      eventId,
      schemaVersion,
      occurredAt,
      mombongoOfferId: offerId ?? null,
      externalReference: externalReference ?? null,
      unitPriceCdf,
      totalAmountCdf,
      currency,
    });

    if (matchedOfferDocId) {
      const outcome = await applyMombongoOfferOutcome({
        mombongoOfferId: offerId!,
        externalReference: externalReference ?? null,
        status: "accepted",
        occurredAt,
        eventId,
        invoiceId,
      });
      // A conflict here (e.g. the offer was already authoritatively
      // 'declined') doesn't undo the invoice we just created — Mombongo
      // is the source of truth for the invoice existing at all — but is
      // still worth recording for investigation rather than silently
      // dropped.
      if (outcome.kind === "conflict") {
        await markInboxConflict(claim.ref, outcome.reason);
        return Response.json({ status: "acknowledged_conflict" }, { status: 200 });
      }
    }

    await markInboxProcessed(claim.ref, matchedOfferDocId ?? undefined);
    return Response.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("invoice_issued v2: processing failed", err);
    await markInboxFailed(
      claim.ref,
      "processing_error",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}

/**
 * MOB-07 (payment_complete), extended for their 2026-09-01 partner-API
 * update (invoice_issued — Sprint DP, their side): the two things
 * genuinely inbound from Mombongo, both landing on this one URL, routed
 * by the payload's `event` field. A server *route*, not a
 * `createServerFn` — TanStack Start's own docs are explicit that server
 * functions are internal RPC, and a route's `server.handlers` is "meant
 * for HTTP endpoints that need to be called from outside your TanStack
 * Start application," which is exactly what this is.
 *
 * Fails closed on a bad/missing signature (401), matching Mombongo's own
 * documented behavior for their inbound endpoints. Idempotent by design —
 * their docs say delivery may arrive more than once (retry + manual
 * re-trigger on their side), so a repeat delivery for an
 * already-resolved invoice is a 200 no-op, not a second transition or an
 * error.
 */
export const Route = createFileRoute("/api/webhooks/mombongo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // getMombongoConfig() signs in as the dedicated system account
        // and reads externalIntegrations/mombongo — the outbound secret
        // lives there, not in a Worker env var (see mombongoConfig.ts).
        let config: Awaited<ReturnType<typeof getMombongoConfig>>;
        try {
          config = await getMombongoConfig();
        } catch (err) {
          console.error("Cannot load Mombongo integration config:", err);
          return Response.json({ error: "not_provisioned" }, { status: 500 });
        }

        const rawBody = await request.text();
        const signatureHeader = request.headers.get("x-mombongo-signature");
        const valid = await verifyHmac(config.outboundVerifySecret, rawBody, signatureHeader);
        if (!valid) {
          return Response.json({ error: "invalid_signature" }, { status: 401 });
        }

        let payload: {
          event?: "payment_complete" | "invoice_issued" | "offer_status_changed";
          externalInvoiceId?: string;
          status?: string;
          amountUsd?: number;
          paidAt?: string;
          invoiceId?: string;
          farmerId?: string;
          listingId?: string;
          quantityKg?: number;
          commodity?: string;
          // contract v2 additions
          eventId?: string;
          schemaVersion?: number;
          occurredAt?: string;
          partnerId?: string;
          offerId?: string;
          externalReference?: string | null;
          unitPriceCdf?: number;
          totalAmountCdf?: number;
          currency?: string;
        };
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        if (payload.event === "offer_status_changed") {
          return handleOfferStatusChanged(payload);
        }

        if (payload.event === "invoice_issued" && payload.eventId != null) {
          // Contract v2 (schemaVersion 2) — has eventId, unlike v1.
          return handleInvoiceIssuedV2(payload);
        }

        if (payload.event === "invoice_issued") {
          // Sprint DP: a farmer selected an AROM harvest-offer, and
          // Mombongo originated the invoice itself — the first (and
          // only) thing AROM learns about it. Idempotent via setDoc +
          // this doc's id being Mombongo's own invoiceId: a repeat
          // delivery just re-writes the same fields, not a duplicate.
          const { invoiceId, farmerId, listingId, amountUsd, quantityKg, commodity } = payload;
          if (
            !invoiceId ||
            !farmerId ||
            !listingId ||
            amountUsd == null ||
            quantityKg == null ||
            !commodity
          ) {
            return Response.json({ error: "missing_fields" }, { status: 400 });
          }

          const existing = await getDoc(doc(serverDb, "harvestInvoices", invoiceId));
          if (!existing.exists()) {
            await setDoc(doc(serverDb, "harvestInvoices", invoiceId), {
              id: invoiceId,
              farmerId,
              listingId,
              amountUsd,
              quantityKg,
              commodity,
              statut: "a_payer",
              createdAt: new Date().toISOString(),
            });

            // Best-effort: mark AROM's own offer record "won" if one
            // matches this listing. Not required for the invoice itself
            // to be payable — an admin can act on harvestInvoices alone
            // even if this match misses (e.g. the offer was submitted
            // before this feature existed, or two offers on the same
            // listing make the match ambiguous and neither is touched).
            const offerMatches = await getDocs(
              query(
                collection(serverDb, "harvestOffers"),
                where("listingId", "==", listingId),
                where("status", "==", "pending"),
                limit(2),
              ),
            );
            if (offerMatches.size === 1) {
              await updateDoc(doc(serverDb, "harvestOffers", offerMatches.docs[0].id), {
                status: "won",
              });
            }
          }

          return Response.json({ status: "ok" }, { status: 200 });
        }

        if (payload.event !== "payment_complete") {
          console.warn(`Mombongo webhook: unknown/missing event "${payload.event}"`);
          return Response.json({ status: "acknowledged_unhandled_event" }, { status: 200 });
        }

        const { externalInvoiceId, status } = payload;
        if (!externalInvoiceId || !status) {
          return Response.json({ error: "missing_fields" }, { status: 400 });
        }

        // For a partner-originated invoice (producerInvoices), externalInvoiceId
        // is AROM's *own* id — the exact value sent as externalInvoiceId to
        // createExternalInvoice, which is that doc's own Firestore id.
        // For a harvest-sale invoice (harvestInvoices), it's Mombongo's own
        // invoiceId instead, per their spec — and that's exactly the id
        // this route creates the harvestInvoices doc under, above. Try
        // producerInvoices first (the more common case today), then
        // harvestInvoices, then fall back to producerInvoices'
        // mombongoInvoiceId field (defensive; querying by that field alone
        // — as this route used to, exclusively — never matched a real
        // partner-originated invoice, since that field holds Mombongo's
        // id, not AROM's).
        let match: {
          collectionName: "producerInvoices" | "harvestInvoices";
          id: string;
          statut: string;
        } | null = null;

        const producerDirect = await getDoc(doc(serverDb, "producerInvoices", externalInvoiceId));
        if (producerDirect.exists()) {
          match = {
            collectionName: "producerInvoices",
            id: producerDirect.id,
            statut: producerDirect.data()?.statut,
          };
        }

        if (!match) {
          const harvestDirect = await getDoc(doc(serverDb, "harvestInvoices", externalInvoiceId));
          if (harvestDirect.exists()) {
            match = {
              collectionName: "harvestInvoices",
              id: harvestDirect.id,
              statut: harvestDirect.data()?.statut,
            };
          }
        }

        if (!match) {
          const producerFallback = await getDocs(
            query(
              collection(serverDb, "producerInvoices"),
              where("mombongoInvoiceId", "==", externalInvoiceId),
              limit(1),
            ),
          );
          if (!producerFallback.empty) {
            const d = producerFallback.docs[0];
            match = { collectionName: "producerInvoices", id: d.id, statut: d.data().statut };
          }
        }

        if (!match) {
          // Ack receipt rather than 404 — Mombongo shouldn't retry
          // forever over a mismatch that's an AROM-side data issue, not
          // theirs. Logged for investigation, not silently dropped.
          console.error(
            `Mombongo webhook: no invoice matches externalInvoiceId ${externalInvoiceId}`,
          );
          return Response.json({ status: "acknowledged_no_match" }, { status: 200 });
        }

        // Idempotent: already resolved, this is a repeat delivery.
        const terminalStatuses =
          match.collectionName === "producerInvoices" ? ["payee", "approuvee"] : ["payee"];
        if (terminalStatuses.includes(match.statut)) {
          return Response.json({ status: "already_processed" }, { status: 200 });
        }

        if (status !== "paid") {
          // Unknown/unexpected status — ack, don't guess a transition
          // firestore.rules doesn't allow anyway (isValidMombongoWebhookTransition
          // only knows paiement_en_attente -> payee | approuvee, for both collections).
          console.warn(`Mombongo webhook: unhandled status "${status}" for ${externalInvoiceId}`);
          return Response.json({ status: "acknowledged_unhandled_status" }, { status: 200 });
        }

        // Already signed in as the system account via getMombongoConfig() above.
        // updatedAt only for producerInvoices — harvestInvoices' rules don't
        // allow that field on this transition (hasOnly(['statut',
        // 'mombongoCheckout'])), and it isn't needed there yet (no
        // stuck-invoice indicator built for that collection).
        await updateDoc(
          doc(serverDb, match.collectionName, match.id),
          match.collectionName === "producerInvoices"
            ? { statut: "payee", updatedAt: new Date().toISOString() }
            : { statut: "payee" },
        );

        return Response.json({ status: "ok" }, { status: 200 });
      },
    },
  },
});
