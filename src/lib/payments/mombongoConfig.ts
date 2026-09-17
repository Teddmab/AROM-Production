import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsMombongoSystem } from "./mombongoSystemAuth";

/**
 * Partner id + the two signing secrets, read from
 * `externalIntegrations/mombongo` — not Worker env vars. Only
 * `MOMBONGO_WEBHOOK_EMAIL`/`MOMBONGO_WEBHOOK_PASSWORD` (the bootstrap
 * credential needed to sign in and read this doc in the first place)
 * stay as env vars; everything partner-specific lives in Firestore so
 * adding a partner or rotating a secret is a script run
 * (`AROM-Backend/scripts/set-mombongo-integration-config.mjs`), never a
 * Cloudflare deployment. `firestore.rules` only lets the signed-in
 * system account read this doc — never a plain `isAdmin()` client read —
 * so a secret value has no path to a browser session.
 */
export interface MombongoIntegrationConfig {
  baseUrl: string;
  partnerId: string;
  inboundSigningSecret: string;
  outboundVerifySecret: string;
  active: boolean;
}

export async function getMombongoConfig(): Promise<MombongoIntegrationConfig> {
  // Deliberately not cached at module scope: a Worker isolate can be
  // reused across requests, and the entire point of storing this in
  // Firestore instead of an env var is that rotating a secret takes
  // effect immediately, not "whenever this isolate happens to recycle."
  // A Firestore read per call is cheap; staleness on a security-relevant
  // secret is not worth optimizing away.
  await signInAsMombongoSystem();
  const snap = await getDoc(doc(serverDb, "externalIntegrations", "mombongo"));
  if (!snap.exists()) {
    throw new Error(
      "externalIntegrations/mombongo doesn't exist — run set-mombongo-integration-config.mjs first.",
    );
  }

  const data = snap.data();
  if (!data.active) {
    throw new Error("externalIntegrations/mombongo is marked inactive.");
  }

  return {
    baseUrl: data.baseUrl,
    partnerId: data.partnerId,
    inboundSigningSecret: data.inboundSigningSecret,
    outboundVerifySecret: data.outboundVerifySecret,
    active: data.active,
  };
}
