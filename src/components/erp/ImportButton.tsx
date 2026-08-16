import { useMemo, useRef, useState } from "react";
import { doc, setDoc, writeBatch } from "firebase/firestore";
import { toast } from "sonner";
import { X, Upload } from "lucide-react";
import { db } from "@/lib/firebase/config";
import { useErp, newId } from "@/lib/erp/store";
import { useAuth } from "@/lib/firebase/auth";
import {
  IMPORT_TARGETS,
  parseImportFile,
  type ImportTargetKey,
  type ParsedImport,
} from "@/lib/erp/import";

const BATCH_SIZE = 400;

/**
 * CSV/Excel bulk import (sprint 27). Column layouts match the real
 * "AROM_ERP_Professionnel.xlsm" workbook — see lib/erp/import.ts. Every
 * import writes one `importLogs` doc (collection, filename, counts, who)
 * so there's always a record of what came in from a file versus manual
 * entry — surfaced in Paramètres ERP's "Journal des imports".
 */
export function ImportButton({ target }: { target: ImportTargetKey }) {
  const { state } = useErp();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [decisions, setDecisions] = useState<Record<number, "add" | "skip">>({});
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetDef = IMPORT_TARGETS[target];

  const existingKeys = useMemo(() => {
    const rows = state[target] as unknown as Record<string, unknown>[];
    return new Set(rows.map((r) => targetDef.dupKeys.map((k) => String(r[k] ?? "")).join("|")));
  }, [state, target, targetDef.dupKeys]);

  const reset = () => {
    setParsed(null);
    setDecisions({});
    setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    setFileName(file.name);
    try {
      const result = await parseImportFile(file, target);
      if (result.rows.length === 0) {
        toast.error("Aucune ligne de données trouvée dans ce fichier.");
        setBusy(false);
        return;
      }
      setParsed(result);
      const initial: Record<number, "add" | "skip"> = {};
      result.rows.forEach((r, i) => {
        initial[i] = r.dupKeyValue && existingKeys.has(r.dupKeyValue) ? "skip" : "add";
      });
      setDecisions(initial);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Lecture du fichier impossible : ${err.message}`
          : "Lecture du fichier impossible.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!parsed || !profile) return;
    setBusy(true);
    try {
      const toImport = parsed.rows.filter((_, i) => decisions[i] === "add");
      for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        toImport.slice(i, i + BATCH_SIZE).forEach((row) => {
          const id = newId(targetDef.idPrefix);
          batch.set(doc(db, target, id), { id, ...row.record });
        });
        await batch.commit();
      }
      const duplicatesFound = parsed.rows.filter(
        (r) => r.dupKeyValue && existingKeys.has(r.dupKeyValue),
      ).length;
      await setDoc(doc(db, "importLogs", newId("IMP")), {
        collection: target,
        collectionLabel: targetDef.label,
        fileName,
        totalRows: parsed.rows.length,
        added: toImport.length,
        skipped: parsed.rows.length - toImport.length,
        duplicatesFound,
        importedBy: profile.uid,
        importedByName: profile.displayName || profile.email,
        importedAt: new Date().toISOString(),
      });
      toast.success(
        `${toImport.length} ligne${toImport.length > 1 ? "s" : ""} importée${toImport.length > 1 ? "s" : ""}${
          parsed.rows.length - toImport.length > 0
            ? `, ${parsed.rows.length - toImport.length} ignorée${parsed.rows.length - toImport.length > 1 ? "s" : ""}`
            : ""
        }.`,
      );
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(
        err instanceof Error ? `Import impossible : ${err.message}` : "Import impossible.",
      );
    } finally {
      setBusy(false);
    }
  };

  const addCount = Object.values(decisions).filter((d) => d === "add").length;

  const close = () => {
    setOpen(false);
    reset();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-primary transition hover:bg-primary/5"
      >
        Importer un fichier
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onClick={() => !busy && close()}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
              <div>
                <h2 className="font-display text-[19px] font-bold text-primary">
                  Importer — {targetDef.label}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Fichier .csv, .xlsx ou .xlsm — colonnes reconnues automatiquement (même mise en
                  page que le classeur AROM_ERP_Professionnel).
                </p>
              </div>
              <button
                onClick={close}
                aria-label="Fermer"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              {!parsed ? (
                <label className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border py-12 text-center transition hover:border-primary/40">
                  <Upload className="h-8 w-8 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium text-foreground">
                    {busy ? "Lecture en cours…" : "Choisir un fichier"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Colonnes attendues : {targetDef.fields.map((f) => f.header).join(", ")}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xlsm"
                    disabled={busy}
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  />
                </label>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-primary/5 px-2.5 py-1 font-semibold text-primary">
                      {parsed.rows.length} ligne{parsed.rows.length > 1 ? "s" : ""} détectée
                      {parsed.rows.length > 1 ? "s" : ""}
                    </span>
                    <span className="rounded-full bg-secondary px-2.5 py-1">
                      {parsed.matchedFields.length}/{targetDef.fields.length} colonnes reconnues
                    </span>
                    {parsed.unmatchedHeaders.length > 0 && (
                      <span className="rounded-full bg-warning/15 px-2.5 py-1 text-foreground">
                        Ignorées : {parsed.unmatchedHeaders.join(", ")}
                      </span>
                    )}
                  </div>

                  {parsed.matchedFields.length === 0 ? (
                    <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
                      Aucune colonne reconnue pour « {targetDef.label} ». Vérifiez que le fichier
                      utilise les mêmes en-têtes que le classeur AROM_ERP_Professionnel.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-border">
                      <div className="max-h-[45vh] overflow-y-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="sticky top-0 bg-secondary text-[10px] uppercase tracking-wider text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2">#</th>
                              {targetDef.dupKeys.map((k) => (
                                <th key={k} className="px-3 py-2">
                                  {targetDef.fields.find((f) => f.key === k)?.header ?? k}
                                </th>
                              ))}
                              <th className="px-3 py-2">Statut</th>
                              <th className="px-3 py-2">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parsed.rows.map((row, i) => {
                              const isDup =
                                row.dupKeyValue !== "" && existingKeys.has(row.dupKeyValue);
                              return (
                                <tr key={i} className="border-t border-border/60">
                                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                                  {targetDef.dupKeys.map((k) => (
                                    <td key={k} className="px-3 py-2">
                                      {row.values[k] || "—"}
                                    </td>
                                  ))}
                                  <td className="px-3 py-2">
                                    {isDup ? (
                                      <span className="rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-foreground">
                                        Doublon
                                      </span>
                                    ) : (
                                      <span className="rounded-full bg-success/15 px-2 py-0.5 font-semibold text-success">
                                        Nouveau
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    {isDup ? (
                                      <select
                                        value={decisions[i]}
                                        onChange={(e) =>
                                          setDecisions((d) => ({
                                            ...d,
                                            [i]: e.target.value as "add" | "skip",
                                          }))
                                        }
                                        className="rounded-lg border border-border bg-card px-2 py-1 text-xs"
                                      >
                                        <option value="skip">Ignorer</option>
                                        <option value="add">Ajouter quand même</option>
                                      </select>
                                    ) : (
                                      <span className="text-muted-foreground">Sera ajoutée</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {parsed && parsed.matchedFields.length > 0 && (
              <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-4">
                <button
                  onClick={reset}
                  className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground"
                >
                  Choisir un autre fichier
                </button>
                <button
                  onClick={confirmImport}
                  disabled={busy || addCount === 0}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busy
                    ? "Import en cours…"
                    : `Importer ${addCount} ligne${addCount > 1 ? "s" : ""}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
