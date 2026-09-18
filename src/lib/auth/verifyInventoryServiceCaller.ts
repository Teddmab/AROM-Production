import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsInventoryService } from "@/lib/inventory/inventoryServiceAuth";
import { verifyFirebaseIdToken } from "./verifyFirebaseIdToken";

/**
 * The auth check every `/api/inventory/*` route runs before doing
 * anything: verify the caller's Firebase ID token is real, then confirm
 * `users/{uid}.active === true` and that the account is either an admin or
 * a recognized Production-authorized poste (Directeur de Production) —
 * mirrors verifyMombongoCaller.ts's own pattern exactly, reusing the
 * same signed-in-as-the-dedicated-system-account approach, extended to
 * this route's own recognized-actor set rather than admin-only.
 *
 * Uses `serverDb` (firestore/lite), not `db` from `./config` — same
 * Cloudflare Workers transport reasoning as verifyMombongoCaller.ts.
 */
export interface VerifiedInventoryCaller {
  uid: string;
  poste?: string;
  role: string;
}

export async function verifyInventoryServiceCaller(
  authorizationHeader: string | null,
): Promise<VerifiedInventoryCaller | null> {
  const idToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  const caller = await verifyFirebaseIdToken(idToken);
  if (!caller) return null;

  await signInAsInventoryService();
  const userSnap = await getDoc(doc(serverDb, "users", caller.uid));
  if (!userSnap.exists()) return null;

  const data = userSnap.data() as { role?: string; poste?: string; active?: boolean };
  if (data.active !== true) return null;

  const isAdmin = data.role === "admin";
  const isProductionStaff = data.role === "staff" && data.poste === "Directeur de Production";
  if (!isAdmin && !isProductionStaff) return null;

  return { uid: caller.uid, poste: data.poste, role: data.role ?? "" };
}
