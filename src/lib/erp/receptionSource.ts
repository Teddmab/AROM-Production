import type { Approvisionnement } from "./model";

/**
 * Readers of a reception's supplier. A Mombongo reception has NO local producer document: `idProducteur` and `village` are "" and `fournisseur` is
 * at most a display copy of the trusted seller name (`mombongoProducer.displayName`). Every screen, table and export goes through these helpers, so a
 * Mombongo reception never shows a blank supplier — and never an invented one.
 */
export const isMombongoReception = (r: Pick<Approvisionnement, "sourceType">): boolean =>
  r.sourceType === "mombongo";

export function approSupplierLabel(
  r: Pick<Approvisionnement, "fournisseur" | "sourceType" | "mombongoProducer">,
): string {
  const name = r.fournisseur?.trim() || r.mombongoProducer?.displayName?.trim();
  if (name) return name;
  return isMombongoReception(r) ? "Producteur Mombongo" : "";
}

/** The village of a manual reception, or the province/territory a Mombongo seller was enriched with ("—" when there is none). */
export function approPlaceLabel(
  r: Pick<Approvisionnement, "village" | "sourceType" | "mombongoProducer">,
): string {
  if (!isMombongoReception(r)) return r.village;
  const place = [r.mombongoProducer?.territory, r.mombongoProducer?.province]
    .filter(Boolean)
    .join(", ");
  return place || "—";
}

export const approSourceLabel = (r: Pick<Approvisionnement, "sourceType">): string =>
  isMombongoReception(r) ? "Offre Mombongo" : "Manuelle";
