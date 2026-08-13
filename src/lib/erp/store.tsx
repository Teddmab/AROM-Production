import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SEED, type ErpState } from "./model";
import { computeErp, type ErpComputed } from "./engine";

const STORAGE_KEY = "arom-erp-v1";

type Collections = "producteurs" | "approvisionnements" | "productions" | "stockMP" | "clients" | "ventes" | "marketing" | "charges";

interface ErpContextValue {
  state: ErpState;
  computed: ErpComputed;
  addRow: <K extends Collections>(key: K, row: ErpState[K][number]) => void;
  removeRow: (key: Collections, id: string) => void;
  updateParametres: (patch: Partial<ErpState["parametres"]>) => void;
  reset: () => void;
}

const ErpContext = createContext<ErpContextValue | null>(null);

export function ErpProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ErpState>(SEED);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState({ ...SEED, ...(JSON.parse(raw) as ErpState) });
    } catch {
      /* stockage indisponible */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* stockage indisponible */
    }
  }, [state]);

  const value = useMemo<ErpContextValue>(
    () => ({
      state,
      computed: computeErp(state),
      addRow: (key, row) => setState((s) => ({ ...s, [key]: [...(s[key] as unknown[]), row] }) as ErpState),
      removeRow: (key, id) =>
        setState((s) => ({ ...s, [key]: (s[key] as { id: string }[]).filter((r) => r.id !== id) }) as ErpState),
      updateParametres: (patch) => setState((s) => ({ ...s, parametres: { ...s.parametres, ...patch } })),
      reset: () => setState(SEED),
    }),
    [state],
  );

  return <ErpContext.Provider value={value}>{children}</ErpContext.Provider>;
}

export function useErp() {
  const ctx = useContext(ErpContext);
  if (!ctx) throw new Error("useErp doit être utilisé dans <ErpProvider>");
  return ctx;
}

export const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
