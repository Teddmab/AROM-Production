import { useMemo } from "react";
import { toast } from "sonner";
import { useErp } from "@/lib/erp/store";
import {
  buildFilteredReport,
  campagnesDisponibles,
  exportExcel,
  exportPdf,
  type ExportFilter,
  type ExportSection,
} from "@/lib/erp/export";

export function ExportBar({ section }: { section: ExportSection }) {
  const { state, filter, setFilter } = useErp();
  const campagnes = useMemo(() => campagnesDisponibles(state), [state]);

  const set = (patch: Partial<ExportFilter>) => setFilter({ ...filter, ...patch });

  const handlePdf = () => {
    const report = buildFilteredReport(section, state, filter);
    const ok = exportPdf(report, filter, "/logo-nav.png");
    if (ok) toast.success("Rapport PDF prêt, utilisez « Enregistrer au format PDF ».");
    else toast.error("Fenêtre bloquée : autorisez les pop-ups pour générer le PDF.");
  };

  const handleExcel = () => {
    const report = buildFilteredReport(section, state, filter);
    exportExcel(report, filter);
    toast.success("Fichier Excel téléchargé.");
  };

  const inputCls =
    "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

  return (
    <section className="mb-6 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
            htmlFor={`camp-${section}`}
          >
            Campagne
          </label>
          <select
            id={`camp-${section}`}
            value={filter.campagne}
            onChange={(e) => set({ campagne: e.target.value })}
            className={inputCls}
          >
            <option value="">Toutes les campagnes</option>
            {campagnes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
            htmlFor={`from-${section}`}
          >
            Du
          </label>
          <input
            id={`from-${section}`}
            type="date"
            value={filter.from}
            onChange={(e) => set({ from: e.target.value })}
            className={inputCls}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
            htmlFor={`to-${section}`}
          >
            Au
          </label>
          <input
            id={`to-${section}`}
            type="date"
            value={filter.to}
            onChange={(e) => set({ to: e.target.value })}
            className={inputCls}
          />
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => set({ from: "", to: "", campagne: "" })}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-primary"
          >
            Réinitialiser
          </button>
          <button
            type="button"
            onClick={handlePdf}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            Export PDF
          </button>
          <button
            type="button"
            onClick={handleExcel}
            className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-primary shadow-sm transition hover:opacity-90"
          >
            Export Excel
          </button>
        </div>
      </div>
    </section>
  );
}
