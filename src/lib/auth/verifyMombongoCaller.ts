import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsMombongoSystem } from "@/lib/payments/mombongoSystemAuth";
import { verifyFirebaseIdToken } from "./verifyFirebaseIdToken";

/**
 * The auth check every `/api/mombongo/*` route (called by AROM-Mobile,
 * an app outside this one — see MOB-07's "Where this lives") runs before
 * doing anything: verify the caller's Firebase ID token is real, then
 * confirm `users/{uid}.role === "admin"` — reusing the same
 * signed-in-as-the-dedicated-system-account pattern already used to
 * write `producerInvoices`/read `externalIntegrations`, extended to a
 * targeted `users/{uid}` read (firestore.rules' `isMombongoWebhook()`
 * covers this now too).
 *
 * Uses `serverDb` (firestore/lite), not `db` from `./config` — the full
 * SDK's default WebChannel transport hangs indefinitely in the
 * Cloudflare Workers runtime instead of erroring (see serverDb.ts's own
 * doc comment; found via a real hung request in webhooks/mombongo.ts).
 * This file had the same bug until now — every one of its two callers
 * (create-invoice.ts, create-checkout.ts) never actually exercised it,
 * since every request tested so far lacked a real bearer token and
 * short-circuited on the `verifyFirebaseIdToken` check above, never
 * reaching this `getDoc` call.
 */
export async function verifyMombongoCaller(
  authorizationHeader: string | null,
): Promise<{ uid: string } | null> {
  const idToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;
  const caller = await verifyFirebaseIdToken(idToken);
  if (!caller) return null;

  await signInAsMombongoSystem();
  const userSnap = await getDoc(doc(serverDb, "users", caller.uid));
  if (!userSnap.exists() || userSnap.data().role !== "admin" || userSnap.data().active !== true)
    return null;

  return { uid: caller.uid };
}
