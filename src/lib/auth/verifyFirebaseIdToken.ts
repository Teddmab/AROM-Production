/**
 * Verifies a Firebase ID token from an external caller (AROM-Mobile,
 * calling AROM-Production's /api/mombongo/* routes) without the Admin
 * SDK — it doesn't run in the Cloudflare Worker this app deploys to
 * (same reasoning as mombongoSystemAuth.ts). Uses Google's own
 * `accounts:lookup` REST endpoint instead — the same operation the
 * Admin SDK's `verifyIdToken` would ultimately delegate to for a
 * network-based check, callable directly via plain `fetch`. The API key
 * required isn't a secret — it's the same public `apiKey` already shipped
 * in `firebaseConfig` (identifies the project; doesn't grant access on
 * its own, see config.ts's own comment on this).
 */

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY ??
  import.meta.env?.VITE_FIREBASE_API_KEY ??
  "AIzaSyAwoaasS4P5m0Q3j3L8tXjN5Cwdu6q_UIM";

export interface VerifiedCaller {
  uid: string;
  email: string | null;
}

export async function verifyFirebaseIdToken(
  idToken: string | null,
): Promise<VerifiedCaller | null> {
  if (!idToken) return null;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as {
    users?: { localId: string; email?: string }[];
  } | null;
  const user = data?.users?.[0];
  if (!user) return null;

  return { uid: user.localId, email: user.email ?? null };
}
