import { auth } from "@/lib/firebase/config";

/**
 * Sprint 08, Steps C/D — browser-side caller for this app's own
 * `/api/inventory/{confirm-order,cancel-order,fulfil-order}` trusted
 * routes. A relative URL (same origin, this app IS the Worker these
 * routes run in) — unlike AROM-Mobile's `inventoryReleaseClient.ts`,
 * which calls this app cross-origin and needs an env-configured base URL.
 * The dashboard's own "Commandes boutique partenaires" card is
 * re-pointed here rather than writing `orders`/`ventes` directly — see
 * automation-engine.md's "Trusted write boundary": proving a `reserved`
 * delta and choosing a FIFO allocation are real business logic no direct
 * client write (even from an authenticated admin) should perform itself.
 */

export type OrderReservationOutcome =
  | { status: "success"; alreadyApplied: boolean }
  | { status: "not_found"; reason: string }
  | { status: "invalid_state"; reason: string; orderStatus?: string }
  | { status: "invalid_items"; reason: string; productId?: string }
  | {
      status: "insufficient_stock";
      shortfalls: { format: string; requested: number; available: number }[];
    }
  | { status: "error"; reason: string };

async function callOrderRoute(path: string, orderId: string): Promise<OrderReservationOutcome> {
  const user = auth.currentUser;
  if (!user) return { status: "error", reason: "not_signed_in" };
  const idToken = await user.getIdToken();
  try {
    const res = await fetch(`/api/inventory/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ orderId }),
    });
    return (await res.json()) as OrderReservationOutcome;
  } catch {
    return { status: "error", reason: "network_error" };
  }
}

export const confirmOrderTrusted = (orderId: string) => callOrderRoute("confirm-order", orderId);
export const cancelOrderTrusted = (orderId: string) => callOrderRoute("cancel-order", orderId);
export const fulfilOrderTrusted = (orderId: string) => callOrderRoute("fulfil-order", orderId);

/** Plain-French translation for the dashboard's own toast copy — never a raw reason/status code shown to a person. */
export function orderReservationErrorMessage(outcome: OrderReservationOutcome): string {
  switch (outcome.status) {
    case "success":
      return "";
    case "not_found":
      return "Commande introuvable.";
    case "invalid_state":
      return "Cette commande n'est plus dans l'état attendu — elle a peut-être déjà été traitée ailleurs.";
    case "invalid_items":
      return "Un article de la commande ne correspond plus au catalogue actuel.";
    case "insufficient_stock": {
      const detail = outcome.shortfalls
        .map((s) => `${s.format} : ${s.available} disponible(s) sur ${s.requested} demandé(s)`)
        .join(", ");
      return `Stock insuffisant pour confirmer cette commande (${detail}).`;
    }
    case "error":
    default:
      return "Une erreur est survenue. Réessayez.";
  }
}
