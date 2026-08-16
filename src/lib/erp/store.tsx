import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { toast } from "sonner";
import { db } from "@/lib/firebase/config";
import { SEED, type ErpState } from "./model";
import { computeErp, type ErpComputed } from "./engine";
import { filterErpState, type ExportFilter } from "./export";

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

// Cached in Firestore at config/exchangeRate so every session shares one
// fetch instead of each dashboard tab hitting the API on load.
const EXCHANGE_RATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ErpContextValue {
  state: ErpState;
  computed: ErpComputed;
  ready: boolean;
  filter: ExportFilter;
  setFilter: (filter: ExportFilter) => void;
  addRow: <K extends Collections>(key: K, row: ErpState[K][number]) => void;
  removeRow: (key: Collections, id: string) => void;
  updateParametres: (patch: Partial<ErpState["parametres"]>) => void;
  reset: () => void;
  // FC per 1 USD, from the cached rate — null until the first fetch/read
  // resolves, so summary figures can omit the USD line rather than show 0.
  fcPerUsd: number | null;
}

const ErpContext = createContext<ErpContextValue | null>(null);

export function ErpProvider({ children }: { children: ReactNode }) {
  // Seed defaults keep the UI meaningful the instant before Firestore's
  // first snapshot arrives; every field is overwritten as soon as the
  // corresponding listener fires.
  const [state, setState] = useState<ErpState>(SEED);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<ExportFilter>({ from: "", to: "", campagne: "" });
  const [fcPerUsd, setFcPerUsd] = useState<number | null>(null);

  useEffect(() => {
    let refreshing = false;
    const unsubExchangeRate = onSnapshot(
      doc(db, "config", "exchangeRate"),
      (snap) => {
        const data = snap.exists()
          ? (snap.data() as { fcPerUsd?: number; fetchedAt?: string })
          : null;
        if (data?.fcPerUsd) setFcPerUsd(data.fcPerUsd);

        const isStale =
          !data?.fetchedAt || Date.now() - Date.parse(data.fetchedAt) > EXCHANGE_RATE_MAX_AGE_MS;
        if (!isStale || refreshing) return;
        refreshing = true;
        fetch("https://open.er-api.com/v6/latest/USD")
          .then((r) => r.json())
          .then((json: { result?: string; rates?: { CDF?: number } }) => {
            if (json.result !== "success" || !json.rates?.CDF) return;
            // Write is admin-only under firestore.rules' generic `config/{doc}`
            // rule (matches every other config doc) — a staff session's write
            // is silently rejected here, and the cached rate just goes another
            // day before an admin session refreshes it. Not worth a rules
            // carve-out for a background, non-sensitive refresh.
            return setDoc(doc(db, "config", "exchangeRate"), {
              fcPerUsd: json.rates.CDF,
              fetchedAt: new Date().toISOString(),
            });
          })
          .catch((err) => console.warn("Taux de change : rafraîchissement impossible", err))
          .finally(() => {
            refreshing = false;
          });
      },
      (err) => console.warn(`Synchronisation "exchangeRate" impossible : ${err.message}`),
    );

    return unsubExchangeRate;
  }, []);

  useEffect(() => {
    const unsubs = COLLECTIONS.map((key) =>
      onSnapshot(
        // stockMP's running balance ("Stock cumulé") is order-sensitive —
        // sort chronologically at the query level rather than trusting
        // Firestore's default (insertion/doc-id) order.
        key === "stockMP" ? query(collection(db, key), orderBy("date")) : collection(db, key),
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
      // Filtered by the shared Campagne/Du/Au filter (ExportBar) so every
      // section renders through the same lens the export already used.
      computed: computeErp(filterErpState(state, filter)),
      ready,
      filter,
      setFilter,
      fcPerUsd,
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
    [state, ready, filter, fcPerUsd],
  );

  return <ErpContext.Provider value={value}>{children}</ErpContext.Provider>;
}

export function useErp() {
  const ctx = useContext(ErpContext);
  if (!ctx) throw new Error("useErp doit être utilisé dans <ErpProvider>");
  return ctx;
}

export const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
