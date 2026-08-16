import { initializeApp, getApps, getApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectStorageEmulator, getStorage } from "firebase/storage";

/**
 * Firebase web config is not a secret (it identifies the project; access
 * control lives in firestore.rules / storage.rules, see AROM-Backend). It is
 * safe to ship as a fallback so the app works even where VITE_FIREBASE_*
 * env vars aren't injected (e.g. Lovable's own build pipeline), while still
 * allowing overrides for local dev against a different project.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyAwoaasS4P5m0Q3j3L8tXjN5Cwdu6q_UIM",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "arom-production-657f2.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "arom-production-657f2",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "arom-production-657f2.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "227952105868",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:227952105868:web:c7e76ac2a322d144bb5ea9",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// SSR-safe: persistent cache only makes sense in the browser.
export const db =
  typeof window === "undefined"
    ? initializeFirestore(firebaseApp, {})
    : initializeFirestore(firebaseApp, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });

export const auth = getAuth(firebaseApp);
export const storage = getStorage(firebaseApp);

/**
 * Local dev against the Firebase Local Emulator Suite instead of live
 * `arom-production` data — set VITE_USE_FIREBASE_EMULATOR=true (see
 * AROM-Backend's runbook). Guarded by a global flag because Vite HMR
 * re-runs this module and each emulator connector throws if called twice
 * on the same instance.
 */
declare global {
  var __aromEmulatorsConnected: boolean | undefined;
}

if (
  typeof window !== "undefined" &&
  import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true" &&
  !globalThis.__aromEmulatorsConnected
) {
  connectFirestoreEmulator(
    db,
    "127.0.0.1",
    Number(import.meta.env.VITE_FIREBASE_EMULATOR_FIRESTORE_PORT ?? 8080),
  );
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  globalThis.__aromEmulatorsConnected = true;
}
