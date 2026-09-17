import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase/config";

/**
 * The one dedicated, narrow-privilege identity every server-side Mombongo
 * write signs in as — never `firebase-admin` (doesn't run in the
 * Cloudflare Worker this app deploys to). Reuses the existing
 * `auth`/`db` exports from lib/firebase/config.ts directly rather than a
 * second Firebase app instance — that file already initializes
 * SSR-safely and already runs server-side in this app today.
 *
 * Provisioned once, offline, by
 * AROM-Backend/scripts/provision-mombongo-webhook-account.mjs, which sets
 * the `mombongoWebhook: true` custom claim `firestore.rules`'
 * `isMombongoWebhook()` checks. This account is not `role: "admin"` — it
 * satisfies only that one narrow rule exception, nothing else.
 */
export async function signInAsMombongoSystem(): Promise<void> {
  const email = process.env.MOMBONGO_WEBHOOK_EMAIL;
  const password = process.env.MOMBONGO_WEBHOOK_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "MOMBONGO_WEBHOOK_EMAIL/MOMBONGO_WEBHOOK_PASSWORD are not set — run provision-mombongo-webhook-account.mjs and set the resulting credentials as Worker secrets first.",
    );
  }

  // Workers may reuse an isolate across a handful of requests — avoid a
  // redundant re-auth if this isolate is already signed in as the right
  // account, but never trust a *different* signed-in user silently.
  if (auth.currentUser?.email === email) return;

  await signInWithEmailAndPassword(auth, email, password);
}
