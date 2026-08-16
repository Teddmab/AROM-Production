import { useState, type ReactNode } from "react";
import { X } from "lucide-react";

export interface DetailField {
  label: string;
  value: ReactNode;
  /** What this field is / where it was collected — the whole point of this modal. */
  description?: string;
  edit?: {
    key: string;
    type: "text" | "number" | "date" | "select";
    options?: readonly string[];
    /** Raw editable value, as a string (numbers included) — mirrors EntryForm's convention. */
    value: string;
  };
}

/**
 * Click-a-row detail overlay, reused across every dashboard table. Follows
 * the same hand-rolled bottom-sheet convention already established by
 * storefront/OrderDetailSheet.tsx and ProductDetailSheet.tsx (fixed
 * backdrop + stopPropagation panel + X close) rather than the unused
 * shadcn Dialog/Sheet primitives — one overlay convention app-wide.
 *
 * `onSave`/`onDelete` are omitted entirely for rows with no single backing
 * record (computed aggregates) — the modal then shows explanation only.
 */
export function RecordDetailModal({
  title,
  subtitle,
  fields,
  onClose,
  onSave,
  onDelete,
}: {
  title: string;
  subtitle?: string;
  fields: DetailField[];
  onClose: () => void;
  onSave?: (patch: Record<string, string | number>) => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.filter((f) => f.edit).map((f) => [f.edit!.key, f.edit!.value])),
  );

  const handleSave = () => {
    if (!onSave) return;
    const patch: Record<string, string | number> = {};
    for (const f of fields) {
      if (!f.edit) continue;
      const raw = values[f.edit.key];
      patch[f.edit.key] = f.edit.type === "number" ? Number(raw) || 0 : raw;
    }
    onSave(patch);
    setEditing(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-3xl bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div>
            <h2 className="font-display text-[19px] font-bold text-primary">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-5">
          {fields.map((f) => (
            <div key={f.label} className="border-b border-border/50 pb-3 last:border-none">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {f.label}
              </p>
              {f.description && (
                <p className="mt-0.5 text-[12px] text-muted-foreground/80">{f.description}</p>
              )}
              {editing && f.edit ? (
                f.edit.type === "select" ? (
                  <select
                    value={values[f.edit.key]}
                    onChange={(e) => setValues((v) => ({ ...v, [f.edit!.key]: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
                  >
                    {f.edit.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.edit.type}
                    step="any"
                    value={values[f.edit.key]}
                    onChange={(e) => setValues((v) => ({ ...v, [f.edit!.key]: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
                  />
                )
              ) : (
                <p className="mt-1 text-sm font-medium text-foreground">{f.value}</p>
              )}
            </div>
          ))}
        </div>

        {(onSave || onDelete) && (
          <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-4">
            <div>
              {onDelete &&
                (confirmingDelete ? (
                  <button
                    onClick={onDelete}
                    className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground"
                  >
                    Confirmer la suppression ?
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmingDelete(true)}
                    className="text-xs font-semibold text-destructive hover:underline"
                  >
                    Supprimer
                  </button>
                ))}
            </div>
            {onSave &&
              (editing ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={handleSave}
                    className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
                  >
                    Enregistrer
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-primary"
                >
                  Modifier
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
