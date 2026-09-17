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
          event?: "payment_complete" | "invoice_issued";
          externalInvoiceId?: string;
          status?: string;
          amountUsd?: number;
          paidAt?: string;
          invoiceId?: string;
          farmerId?: string;
          listingId?: string;
          quantityKg?: number;
          commodity?: string;
        };
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
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
