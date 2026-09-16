import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsInventoryService } from "@/lib/inventory/inventoryServiceAuth";
import { verifyFirebaseIdToken } from "./verifyFirebaseIdToken";

/**
 * The auth check every order-reservation `/api/inventory/*` route runs
 * before doing anything (Sprint 08, Steps C/D) — sibling to
 * `verifyInventoryServiceCaller.ts`, not a generalization of it: the two
 * check different, independently-configured authorized-actor sets
 * (production staff vs. commercial staff/admin — see
 * automation-engine.md's "Authorization" table), so keeping them as two
 * small, explicit functions reads more honestly than one function taking
 * a role-set parameter. Both share the identical token-verification /
 * sign-in-as-the-system-account shape, mirroring verifyMombongoCaller.ts.
 */
export interface VerifiedCommercialCaller {
  uid: string;
  poste?: string;
  role: string;
}

export async function verifyCommercialInventoryCaller(
  authorizationHeader: string | null,
): Promise<VerifiedCommercialCaller | null> {
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
  const isCommercialStaff = data.role === "staff" && data.poste === "Chargée de Commercialisation";
  if (!isAdmin && !isCommercialStaff) return null;

  return { uid: caller.uid, poste: data.poste, role: data.role ?? "" };
}
