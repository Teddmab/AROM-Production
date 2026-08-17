import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/**
 * Two-click "arm then confirm" gesture for any single-click control that
 * mutates data with no other friction (status toggles, inline card saves) —
 * generalizes the confirm pattern already used by DeleteButton so it can
 * protect non-destructive actions too. First click arms a confirm state
 * (auto-reverts after 3s if not followed up); second click actually runs
 * the action. Doesn't replace DeleteButton (kept separate — its exact
 * aria-labels are relied on by the regression suite).
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirmer ?",
  className = "",
  confirmClassName,
  ariaLabel,
  confirmAriaLabel,
  disabled,
}: {
  onConfirm: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  /** Text shown once armed — defaults to a generic "Confirmer ?" but a specific action name reads clearer. */
  confirmLabel?: string;
  className?: string;
  /** Styling for the armed state — defaults to `className` if omitted. */
  confirmClassName?: string;
  ariaLabel?: string;
  confirmAriaLabel?: string;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (confirming) {
          setConfirming(false);
          onConfirm(e);
        } else {
          setConfirming(true);
        }
      }}
      aria-label={confirming ? (confirmAriaLabel ?? confirmLabel) : ariaLabel}
      className={confirming ? (confirmClassName ?? className) : className}
    >
      {confirming ? confirmLabel : children}
    </button>
  );
}
