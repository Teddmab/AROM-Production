import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase/config";

/**
 * The one dedicated, narrow-privilege identity every server-side inventory
 * write (Sprint 08, Step B) signs in as — never `firebase-admin` (doesn't
 * run in the Cloudflare Worker this app deploys to). Mirrors
 * mombongoSystemAuth.ts's own pattern exactly, but its own separate
 * identity — never reusing the Mombongo account for an unrelated domain,
 * same "narrow, single-purpose" principle that one was built on. Reuses
 * the existing `auth`/`db` exports from lib/firebase/config.ts directly
 * rather than a second Firebase app instance, same reasoning as
 * mombongoSystemAuth.ts.
 *
 * Provisioned once, offline, by
 * AROM-Backend/scripts/provision-inventory-service-account.mjs, which sets
 * the `inventoryService: true` custom claim `firestore.rules`'
 * `isInventoryService()` checks. This account is not `role: "admin"` — it
 * satisfies only that one narrow rule exception, nothing else.
 */
export async function signInAsInventoryService(): Promise<void> {
  const email = process.env.INVENTORY_SERVICE_EMAIL;
  const password = process.env.INVENTORY_SERVICE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "INVENTORY_SERVICE_EMAIL/INVENTORY_SERVICE_PASSWORD are not set — run provision-inventory-service-account.mjs and set the resulting credentials as Worker secrets first.",
    );
  }

  // Workers may reuse an isolate across a handful of requests — avoid a
  // redundant re-auth if this isolate is already signed in as the right
  // account, but never trust a *different* signed-in user silently.
  if (auth.currentUser?.email === email) return;

  await signInWithEmailAndPassword(auth, email, password);
}
