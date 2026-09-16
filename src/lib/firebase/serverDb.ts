import { getFirestore } from "firebase/firestore/lite";
import { firebaseApp } from "./config";

/**
 * Firestore for server-only code (Cloudflare Workers), not `db` from
 * `./config`. The regular `firebase/firestore` SDK's default transport
 * streams its response body over WebChannel, which hangs forever in the
 * Workers runtime instead of erroring or falling back — found via a real
 * request that hung until Cloudflare killed it (the Mombongo webhook
 * route's first post-sign-in `getDoc`). Forcing long-polling doesn't fix
 * it either: that path needs `XMLHttpRequest`, which Workers doesn't have.
 *
 * `firebase/firestore/lite` sidesteps all of it — one-shot REST calls over
 * plain `fetch`, no streaming, no persistence, no `onSnapshot` (not needed
 * here; every server caller does a single get/query/update and returns).
 * It registers under a different component name (`firestore/lite`) than
 * the full SDK, so this coexists safely on the same `firebaseApp` the
 * browser bundle also uses via `./config`.
 */
export const serverDb = getFirestore(firebaseApp);
