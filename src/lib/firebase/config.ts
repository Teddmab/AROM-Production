import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

/**
 * Firebase web config is not a secret (it identifies the project; access
 * control lives in firestore.rules / storage.rules, see AROM-Backend). It is
 * safe to ship as a fallback so the app works even where VITE_FIREBASE_*
 * env vars aren't injected (e.g. Lovable's own build pipeline), while still
 * allowing overrides for local dev against a different project.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyBMPGIylnf_XBoSRuBmqEXmsZlj1z2j6hE",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "arom-production.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "arom-production",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "arom-production.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "66641088420",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:66641088420:web:f07bec5c323b92c7b9bb31",
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
