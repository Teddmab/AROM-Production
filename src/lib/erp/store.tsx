import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "@/lib/firebase/config";
import { SEED, type ErpState } from "./model";
import { computeErp, type ErpComputed } from "./engine";

type Collections =
  | "producteurs"
  | "approvisionnements"
  | "productions"
  | "stockMP"
  | "clients"
  | "ventes"
  | "marketing"
  | "charges";

const COLLECTIONS: Collections[] = [
  "producteurs",
  "approvisionnements",
  "productions",
  "stockMP",
  "clients",
  "ventes",
  "marketing",
  "charges",
];

interface ErpContextValue {
  state: ErpState;
  computed: ErpComputed;
  ready: boolean;
  addRow: <K extends Collections>(key: K, row: ErpState[K][number]) => void;
  removeRow: (key: Collections, id: string) => void;
  updateParametres: (patch: Partial<ErpState["parametres"]>) => void;
  reset: () => void;
}

const ErpContext = createContext<ErpContextValue | null>(null);

export function ErpProvider({ children }: { children: ReactNode }) {
  // Seed defaults keep the UI meaningful the instant before Firestore's
  // first snapshot arrives; every field is overwritten as soon as the
  // corresponding listener fires.
  const [state, setState] = useState<ErpState>(SEED);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubs = COLLECTIONS.map((key) =>
      onSnapshot(
        collection(db, key),
        (snap) => {
          const rows = snap.docs.map((d) => d.data());
          setState((s) => ({ ...s, [key]: rows }) as ErpState);
        },
        (err) => toast.error(`Synchronisation "${key}" impossible : ${err.message}`),
      ),
    );

    const unsubParametres = onSnapshot(
      doc(db, "config", "parametres"),
      (snap) => {
        if (snap.exists()) {
          setState((s) => ({ ...s, parametres: { ...s.parametres, ...snap.data() } }) as ErpState);
        }
        setReady(true);
      },
      (err) => {
        toast.error(`Synchronisation "parametres" impossible : ${err.message}`);
        setReady(true);
      },
    );

    return () => {
      unsubs.forEach((u) => u());
      unsubParametres();
    };
  }, []);

  const value = useMemo<ErpContextValue>(
    () => ({
      state,
      computed: computeErp(state),
      ready,
      addRow: (key, row) => {
        setDoc(doc(db, key, (row as { id: string }).id), row).catch((err) =>
          toast.error(`Enregistrement impossible : ${err.message}`),
        );
      },
      removeRow: (key, id) => {
        deleteDoc(doc(db, key, id)).catch((err) =>
          toast.error(`Suppression impossible : ${err.message}`),
        );
      },
      updateParametres: (patch) => {
        updateDoc(doc(db, "config", "parametres"), patch).catch((err) =>
          toast.error(`Mise à jour impossible : ${err.message}`),
        );
      },
      reset: () => {
        toast.info(
          "Les données sont désormais partagées via Firebase. Utilisez les scripts d'administration (AROM-Backend) pour réinitialiser une campagne.",
        );
      },
    }),
    [state, ready],
  );

  return <ErpContext.Provider value={value}>{children}</ErpContext.Provider>;
}

export function useErp() {
  const ctx = useContext(ErpContext);
  if (!ctx) throw new Error("useErp doit être utilisé dans <ErpProvider>");
  return ctx;
}

export const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
