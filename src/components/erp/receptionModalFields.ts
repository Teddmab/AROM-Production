import { fcFormat, type Approvisionnement } from "@/lib/erp/model";
import {
  approPlaceLabel,
  approSourceLabel,
  approSupplierLabel,
  isMombongoReception,
} from "@/lib/erp/receptionSource";
import type { DetailField } from "./RecordDetailModal";

/**
 * The reception detail modal's fields. A manual reception is unchanged (editable, as before). A MOMBONGO reception is create-once — the Backend Rules
 * refuse every edit but the evidence link — so its fields are explanation only, its missing local producer is said plainly, and its source, agreed
 * price and any on-site price OBSERVATION are shown (an observation: it changes no offer, invoice or payment).
 */
export function receptionModalFields(r: Approvisionnement, fields: DetailField[]): DetailField[] {
  if (!isMombongoReception(r)) return fields;
  const source = r.mombongoSource;
  const readOnly = fields.map(({ edit: _edit, ...field }): DetailField => {
    if (field.label === "ID producteur") {
      return {
        ...field,
        value: "Aucun (offre Mombongo)",
        description:
          "Une réception liée à une offre Mombongo n'a pas de producteur local : le vendeur est celui de l'offre.",
      };
    }
    if (field.label === "Fournisseur") {
      return {
        ...field,
        value: approSupplierLabel(r),
        description:
          "Vendeur de l'offre Mombongo (nom fourni par Mombongo ; « Producteur Mombongo » quand aucun nom n'est disponible).",
      };
    }
    if (field.label === "Village") {
      return {
        ...field,
        value: approPlaceLabel(r),
        description:
          "Province / territoire fournis par Mombongo pour cette offre, quand ils existent.",
      };
    }
    return field;
  });
  const extra: DetailField[] = [
    {
      label: "Source",
      value: approSourceLabel(r),
      description:
        "Réception créée depuis une offre acceptée. Elle n'est créée qu'une fois et ne peut plus être modifiée.",
    },
    ...(source
      ? [
          {
            label: "Référence offre",
            value: source.externalReference ?? source.mombongoOfferId,
            description: `Offre Mombongo ${source.mombongoOfferId}${source.invoiceId ? ` — facture ${source.invoiceId}` : ""}.`,
          },
        ]
      : []),
    ...(r.mombongoTerms
      ? [
          {
            label: "Prix convenu (offre)",
            value: `${fcFormat(r.mombongoTerms.acceptedPricePerKgCdf)} / kg`,
            description:
              "Prix de l'offre acceptée. Il ne change pas, quelle que soit l'observation faite sur place.",
          },
        ]
      : []),
    ...(r.priceObservation
      ? [
          {
            label: "Prix constaté sur place",
            value: `${fcFormat(r.priceObservation.observedPricePerKgCdf)} / kg`,
            description: `Observation de l'agent : « ${r.priceObservation.reason} ». À examiner : elle ne modifie ni l'offre, ni la facture, ni un montant à payer.`,
          },
        ]
      : []),
  ];
  return [...readOnly.slice(0, 1), ...extra, ...readOnly.slice(1)];
}
