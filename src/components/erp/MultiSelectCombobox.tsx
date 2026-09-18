import { useState } from "react";
import { Check } from "lucide-react";

/**
 * Searchable tag-picker used for every required multi-record link
 * (réceptions sources, lots destination, etc.) — a plain checkbox list
 * doesn't scale once a campaign has more than a handful of réceptions/lots.
 * Shared between the manual entry forms (dashboard.tsx) and the CSV/Excel
 * import preview (ImportButton.tsx), which both need to let an operator
 * pick which existing record(s) a new/imported row relates to.
 */
export function MultiSelectCombobox({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const selected = value
    .map((id) => options.find((o) => o.value === id))
    .filter((o): o is { value: string; label: string } => Boolean(o));

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <div
      className="relative mt-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((o) => (
            <span
              key={o.value}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              {o.label}
              <button
                type="button"
                onClick={() => toggle(o.value)}
                aria-label={`Retirer ${o.label}`}
                className="text-primary/70 hover:text-primary"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        placeholder={options.length ? "Rechercher…" : "Aucun élément disponible"}
        disabled={options.length === 0}
        className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground disabled:opacity-50"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
          {filtered.map((o) => {
            const checked = value.includes(o.value);
            return (
              <button
                type="button"
                key={o.value}
                onClick={() => {
                  toggle(o.value);
                  // Closes after each pick rather than staying open for rapid
                  // multi-select: an always-open dropdown can visually cover
                  // other fields/buttons below it (it's `position: absolute`,
                  // so it breaks out of the form's grid layout). Re-focusing
                  // the search input reopens it for another pick.
                  setOpen(false);
                  setQuery("");
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                  checked ? "bg-primary/10 text-primary" : "text-foreground hover:bg-secondary"
                }`}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-border">
                  {checked && <Check className="h-3 w-3" aria-hidden />}
                </span>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
