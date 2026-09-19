import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";

/**
 * Durable inbound-event inbox (contract v2) — uses AROM-Backend's merged
 * `mombongoWebhookEvents` schema exactly (see
 * AROM-Backend/docs/mombongo-contract-v2.md). Document id is Mombongo's
 * own deterministic `eventId`: a duplicate delivery always lands on this
 * same doc, never creates a second logical record.
 *
 * "Receive before processing acknowledgement": the webhook route calls
 * `claimInboxEvent` immediately after HMAC verification and field
 * validation, before touching `harvestOffers`/`harvestInvoices` at all —
 * if this durable create fails, the route must not acknowledge success
 * (see its own caller).
 */
export interface InboxEventInput {
  eventId: string;
  eventType: "offer_status_changed" | "invoice_issued";
  schemaVersion: number;
  occurredAt: string;
  mombongoOfferId?: string;
  externalReference?: string;
  invoiceId?: string;
}

export type InboxClaim =
  | { kind: "process"; ref: ReturnType<typeof doc> }
  | { kind: "already_processed" }
  | { kind: "already_conflict" };

export async function claimInboxEvent(input: InboxEventInput): Promise<InboxClaim> {
  const ref = doc(serverDb, "mombongoWebhookEvents", input.eventId);
  const existing = await getDoc(ref);

  if (!existing.exists()) {
    await setDoc(ref, {
      eventId: input.eventId,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion,
      occurredAt: input.occurredAt,
      receivedAt: new Date().toISOString(),
      processingState: "received",
      ...(input.mombongoOfferId ? { mombongoOfferId: input.mombongoOfferId } : {}),
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
    });
    return { kind: "process", ref };
  }

  const state = existing.data().processingState as string;
  if (state === "processed") return { kind: "already_processed" };
  if (state === "conflict") return { kind: "already_conflict" };
  // "received" or "failed": a prior attempt didn't finish — resumable,
  // per "a received-but-failed event remains recoverable." Re-attempt
  // processing rather than skip it. Both -> processed/failed/conflict are
  // legal transitions under AROM-Backend's merged Rules.
  return { kind: "process", ref };
}

export async function markInboxProcessed(
  ref: ReturnType<typeof doc>,
  offerDocumentId?: string,
): Promise<void> {
  await updateDoc(ref, {
    processingState: "processed",
    processedAt: new Date().toISOString(),
    ...(offerDocumentId ? { offerDocumentId } : {}),
  });
}

export async function markInboxFailed(
  ref: ReturnType<typeof doc>,
  errorCode: string,
  errorSummary: string,
): Promise<void> {
  await updateDoc(ref, { processingState: "failed", errorCode, errorSummary });
}

export async function markInboxConflict(
  ref: ReturnType<typeof doc>,
  conflictDetails: string,
): Promise<void> {
  await updateDoc(ref, { processingState: "conflict", conflictDetails });
}
