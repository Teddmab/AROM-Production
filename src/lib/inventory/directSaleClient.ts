import { auth } from "@/lib/firebase/config";

/**
 * Sprint 08, Step E — browser-side caller for this app's own
 * `/api/inventory/direct-sale` trusted route. A relative URL (same
 * origin, this app IS the Worker this route runs in), mirroring
 * `orderReservationClient.ts`'s own pattern exactly. This is now the
 * ONLY way the dashboard creates a direct-sale `ventes` document — see
 * dashboard.tsx's "Nouvelle vente" EntryForm and the "commercialisation"
 * task-completion handler, both repointed here. No direct Firestore
 * write of a new sale remains reachable from either; if this route can't
 * be reached, the caller reports the failure and does not fall back to
 * one.
 */

export interface DirectSaleRequest {
  saleId: string;
  format: string;
  quantity: number;
  prixUnitaire: number;
  remise?: number;
  encaisse?: number;
  idClient?: string;
  clientNom?: string;
  canal?: string;
  numero?: string;
  commerciale: string;
}

export type DirectSaleOutcome =
  | { status: "success"; alreadyApplied: boolean }
  | { status: "invalid_sale_id" }
  | { status: "invalid_items"; reason?: string }
  | {
      status: "insufficient_stock";
      shortfalls: { format: string; requested: number; available: number }[];
    }
  | { status: "conflict"; reason?: string }
  | { status: "error"; reason: string };

export async function submitDirectSale(request: DirectSaleRequest): Promise<DirectSaleOutcome> {
  const user = auth.currentUser;
  if (!user) return { status: "error", reason: "not_signed_in" };
  const idToken = await user.getIdToken();
  try {
    const res = await fetch("/api/inventory/direct-sale", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify(request),
    });
    return (await res.json()) as DirectSaleOutcome;
  } catch {
    return { status: "error", reason: "network_error" };
  }
}

/** Plain-French translation for the dashboard's own toast copy — never a raw reason/status code shown to a person. */
export function directSaleErrorMessage(outcome: DirectSaleOutcome): string {
  switch (outcome.status) {
    case "success":
      return "";
    case "invalid_sale_id":
      return "Identifiant de vente invalide — réessayez.";
    case "invalid_items":
      return "Un des champs de la vente n'est pas valide (format, quantité ou prix).";
    case "insufficient_stock": {
      const detail = outcome.shortfalls
        .map((s) => `${s.format} : ${s.available} disponible(s) sur ${s.requested} demandé(s)`)
        .join(", ");
      return `Stock insuffisant pour cette vente (${detail}).`;
    }
    case "conflict":
      return "Cette vente existe déjà avec des informations différentes — impossible de l'enregistrer à nouveau sous le même identifiant.";
    case "error":
    default:
      return outcome.status === "error" && outcome.reason === "not_signed_in"
        ? "Vous devez être connecté pour enregistrer une vente."
        : "Une erreur est survenue. Réessayez.";
  }
}
