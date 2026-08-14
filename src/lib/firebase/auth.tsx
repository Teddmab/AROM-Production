import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile,
  FacebookAuthProvider,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, setDoc, writeBatch } from "firebase/firestore";
import { auth, db } from "./config";

export type Role = "admin" | "staff" | "partner";
export type OAuthProviderName = "google" | "facebook";

function providerFor(name: OAuthProviderName) {
  return name === "google" ? new GoogleAuthProvider() : new FacebookAuthProvider();
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  menus: "all" | string[];
  active: boolean;
}

export interface Invite {
  email: string;
  role: "admin" | "staff";
  menus: "all" | string[];
  used: boolean;
}

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  /** True while the initial auth state / profile doc is being resolved. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  signUpPartner: (email: string, password: string, displayName: string) => Promise<void>;
  /**
   * For /login: just the popup sign-in, no Firestore writes. If the
   * signed-in Google/Facebook account has no users/{uid} doc, the
   * existing "no profile" handling in login.tsx (sign out + explain)
   * covers it — logging in isn't supposed to create an account.
   */
  signInWithProvider: (name: OAuthProviderName) => Promise<void>;
  /**
   * For /storefront/signup: same popup, but creates a partner profile
   * if (and only if) this account doesn't already have one — so an
   * existing user who ends up here by mistake doesn't get clobbered.
   */
  signUpPartnerWithProvider: (name: OAuthProviderName) => Promise<void>;
  /**
   * Reads an invite by ID (public get, see firestore.rules) — used by
   * /join to preview who's being invited to what before asking for a
   * password.
   */
  getInvite: (inviteId: string) => Promise<Invite | null>;
  /**
   * Creates the Auth account + own users/{uid} doc + marks the invite
   * used, atomically. The invite's email/role/menus are read fresh here
   * (not trusted from an earlier preview) and re-validated by
   * firestore.rules regardless.
   */
  redeemInvite: (inviteId: string, password: string, displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [profileResolved, setProfileResolved] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthResolved(true);
      if (!u) {
        setProfile(null);
        setProfileResolved(true);
      } else {
        // Flip this in the same tick user becomes non-null, not in the
        // effect below — otherwise there's a render in between where
        // `loading` is false but the profile for the new user hasn't been
        // fetched yet, briefly exposing the previous (often null) profile.
        setProfileResolved(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        setProfile(
          snap.exists() ? { uid: user.uid, ...(snap.data() as Omit<UserProfile, "uid">) } : null,
        );
        setProfileResolved(true);
      },
      () => {
        setProfile(null);
        setProfileResolved(true);
      },
    );
  }, [user]);

  const value: AuthContextValue = {
    user,
    profile,
    loading: !authResolved || !profileResolved,
    signIn: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    signOutUser: async () => {
      await signOut(auth);
    },
    signUpPartner: async (email, password, displayName) => {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName });
      await setDoc(doc(db, "users", cred.user.uid), {
        email,
        displayName,
        role: "partner",
        menus: [],
        active: true,
        createdAt: new Date().toISOString(),
      });
    },
    signInWithProvider: async (name) => {
      await signInWithPopup(auth, providerFor(name));
    },
    signUpPartnerWithProvider: async (name) => {
      const cred = await signInWithPopup(auth, providerFor(name));
      const existing = await getDoc(doc(db, "users", cred.user.uid));
      if (existing.exists()) return;
      if (!cred.user.email) {
        throw new Error(
          "Impossible de récupérer votre e-mail depuis ce fournisseur. Essayez un autre mode de connexion.",
        );
      }
      await setDoc(doc(db, "users", cred.user.uid), {
        email: cred.user.email,
        displayName: cred.user.displayName || cred.user.email,
        role: "partner",
        menus: [],
        active: true,
        createdAt: new Date().toISOString(),
      });
    },
    getInvite: async (inviteId) => {
      const snap = await getDoc(doc(db, "invites", inviteId));
      return snap.exists() ? (snap.data() as Invite) : null;
    },
    redeemInvite: async (inviteId, password, displayName) => {
      const inviteSnap = await getDoc(doc(db, "invites", inviteId));
      if (!inviteSnap.exists() || inviteSnap.data().used) {
        throw new Error("Cette invitation n'est plus valide.");
      }
      const invite = inviteSnap.data() as Invite;
      const cred = await createUserWithEmailAndPassword(auth, invite.email, password);
      await updateProfile(cred.user, { displayName });
      const batch = writeBatch(db);
      batch.set(doc(db, "users", cred.user.uid), {
        email: invite.email,
        displayName,
        role: invite.role,
        menus: invite.menus,
        active: true,
        inviteId,
        createdAt: new Date().toISOString(),
      });
      batch.update(doc(db, "invites", inviteId), { used: true, usedBy: cred.user.uid });
      await batch.commit();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé dans <AuthProvider>");
  return ctx;
}

export function canAccessMenu(profile: UserProfile | null, menu: string): boolean {
  if (!profile) return false;
  if (profile.role === "admin") return true;
  if (profile.role !== "staff") return false;
  return profile.menus === "all" || profile.menus.includes(menu);
}
