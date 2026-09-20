/**
 * How a reception is treated downstream (purchases, stock, production sources, invoices). Decided by the AUTHORITATIVE
 * `receptionAssessment` the mobile app records at reception time — never inferred from the legacy `qualite` label:
 *
 *  - "confirmed"      `conforme`: an ordinary purchase — counted, usable, invoiceable (as before);
 *  - "pending_review" `accepted_with_reserve`: an auditable physical reception whose fruit value is PENDING review — not a confirmed
 *                     purchase, not usable stock, not a production source, not payable;
 *  - "refused"        `refused_on_reception`: an audit record only — fruit purchase value 0, no stock, no production source, no invoice;
 *  - "legacy"         no assessment (every reception saved before Step 3, and every web-entered one): `qualite` alone ("Conforme",
 *                     "À vérifier", "Rejeté", anything) proves nothing sufficient, so behaviour is EXACTLY what it always was.
 *
 * Kept in sync by hand with AROM-Mobile's src/features/reception/receptionTreatment.ts and AROM-Backend's firestore.rules
 * (isUsableReceptionId) — three independent implementations, no shared package.
 */
import type { Approvisionnement, ReceptionAssessment } from "./model";

export type ReceptionTreatment = "confirmed" | "pending_review" | "refused" | "legacy";

export function receptionTreatment(r: {
  receptionAssessment?: ReceptionAssessment | null;
}): ReceptionTreatment {
  switch (r.receptionAssessment?.outcome) {
    case "conforme":
      return "confirmed";
    case "accepted_with_reserve":
      return "pending_review";
    case "refused_on_reception":
      return "refused";
    default:
      // No assessment — or an unknown outcome from a newer client: never invented, never treated as a refusal or a release.
      return "legacy";
  }
}

/** Counts as a confirmed purchase, usable stock, a valid production source and an invoiceable reception (conforme and legacy: unchanged behaviour). */
export function isUsableReception(r: Pick<Approvisionnement, "receptionAssessment">): boolean {
  const t = receptionTreatment(r);
  return t === "confirmed" || t === "legacy";
}

export const RECEPTION_TREATMENT_LABEL: Record<ReceptionTreatment, string> = {
  confirmed: "Conforme",
  pending_review: "Sous réserve — à examiner",
  refused: "Refusée à la réception",
  legacy: "",
};
