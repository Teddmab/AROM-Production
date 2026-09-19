import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsMombongoSystem } from "@/lib/payments/mombongoSystemAuth";
import { verifyFirebaseIdToken } from "./verifyFirebaseIdToken";

/**
 * Who may ask AROM-Production to refresh receivable Mombongo offers:
 *   - an ACTIVE account with `role: "admin"`, or
 *   - an ACTIVE staff account whose poste is exactly "Agent de collecte".
 * Nobody else: not Directeur de Production, not Chargée de Commercialisation,
 * not "Personnalisé" or poste-less staff, not partners, not inactive accounts,
 * not an unauthenticated caller.
 *
 * The decision is made ONLY from the verified Firebase ID token and that
 * uid's own `users/{uid}` profile (read as the trusted system identity, which
 * Rules let read `users`). Nothing from the request body or query is ever
 * consulted, so a caller cannot choose a role, partner, project or environment.
 *
 * `401` = no valid identity; `403` = a real, signed-in account that is simply
 * not allowed (kept distinct so a client never mistakes "not permitted" for
 * "sign in again"). Mirrors AROM-Backend's Rules: the collector read of
 * `harvestOffers` is granted to exactly this same poste, and to admin.
 */
export type OfferRefreshAuthorization =
  | { ok: true; uid: string; role: "admin" | "agent_de_collecte" }
  | { ok: false; status: 401 | 403 };

export async function authorizeOfferRefreshCaller(
  authorizationHeader: string | null,
): Promise<OfferRefreshAuthorization> {
  const idToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  const caller = await verifyFirebaseIdToken(idToken);
  if (!caller) return { ok: false, status: 401 };

  await signInAsMombongoSystem();
  const snap = await getDoc(doc(serverDb, "users", caller.uid));
  if (!snap.exists()) return { ok: false, status: 403 };
  const profile = snap.data();
  if (profile.active !== true) return { ok: false, status: 403 };
  if (profile.role === "admin") return { ok: true, uid: caller.uid, role: "admin" };
  if (profile.role === "staff" && profile.poste === "Agent de collecte") {
    return { ok: true, uid: caller.uid, role: "agent_de_collecte" };
  }
  return { ok: false, status: 403 };
}
