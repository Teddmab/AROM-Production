import { describe, expect, it } from "vitest";
import type { Approvisionnement } from "@/lib/erp/model";
import { receptionModalFields } from "./receptionModalFields";
import type { DetailField } from "./RecordDetailModal";

const fields = (): DetailField[] => [
  {
    label: "N° réception",
    value: "001_2026",
    edit: { key: "numero", type: "text", value: "001_2026" },
  },
  { label: "ID producteur", value: "", edit: { key: "idProducteur", type: "text", value: "" } },
  { label: "Fournisseur", value: "", edit: { key: "fournisseur", type: "text", value: "" } },
  { label: "Village", value: "", edit: { key: "village", type: "text", value: "" } },
  { label: "Prix / kg", value: "850", edit: { key: "prixKg", type: "number", value: "850" } },
];

const mombongo: Approvisionnement = {
  id: "MBG-x",
  numero: "001_2026",
  date: "2026-09-21",
  idProducteur: "",
  fournisseur: "",
  village: "",
  produit: "Ananas",
  qteCommandeeKg: 10,
  qteRecueKg: 9.5,
  prixKg: 850,
  transport: 0,
  autresFrais: 0,
  qualite: "Conforme",
  sourceType: "mombongo",
  mombongoSource: {
    harvestOfferDocumentId: "o",
    mombongoOfferId: "mb_offer-9",
    externalReference: "DDZ",
    invoiceId: "inv-1",
  },
  mombongoProducer: { sellerId: null },
  mombongoTerms: { acceptedQuantityKg: 10, acceptedPricePerKgCdf: 850 },
  priceObservation: { observedPricePerKgCdf: 900, reason: "Marché" },
};

describe("receptionModalFields", () => {
  it("a manual reception keeps every field editable, exactly as before", () => {
    const list = fields();
    expect(receptionModalFields({ ...mombongo, sourceType: undefined }, list)).toBe(list);
  });

  it("a Mombongo reception is explanation only — no field is editable (the Rules would refuse the edit)", () => {
    const out = receptionModalFields(mombongo, fields());
    expect(out.some((f) => f.edit)).toBe(false);
  });

  it("says plainly that there is no local producer, never a blank supplier or place", () => {
    const out = Object.fromEntries(
      receptionModalFields(mombongo, fields()).map((f) => [f.label, f.value]),
    );
    expect(out["ID producteur"]).toBe("Aucun (offre Mombongo)");
    expect(out["Fournisseur"]).toBe("Producteur Mombongo");
    expect(out["Village"]).toBe("—");
  });

  it("shows the source, the agreed price and the on-site price as an OBSERVATION", () => {
    const out = receptionModalFields(mombongo, fields());
    const by = Object.fromEntries(out.map((f) => [f.label, f]));
    expect(by["Source"].value).toBe("Offre Mombongo");
    expect(by["Référence offre"].value).toBe("DDZ");
    expect(String(by["Prix convenu (offre)"].value)).toContain("/ kg");
    expect(String(by["Prix constaté sur place"].description)).toMatch(
      /ne modifie ni l'offre, ni la facture/,
    );
  });
});
