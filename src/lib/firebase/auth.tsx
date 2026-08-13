import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { auth, db } from "./config";

export type Role = "admin" | "staff" | "partner";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  menus: "all" | string[];
  active: boolean;
}

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  /** True while the initial auth state / profile doc is being resolved. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  signUpPartner: (email: string, password: string, displayName: string) => Promise<void>;
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
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    setProfileResolved(false);
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
