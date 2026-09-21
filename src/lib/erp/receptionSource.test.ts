import { describe, expect, it } from "vitest";
import type { Approvisionnement } from "./model";
import { approPlaceLabel, approSourceLabel, approSupplierLabel } from "./receptionSource";

const base = { fournisseur: "", village: "", sourceType: "mombongo" as const };

describe("reception supplier readers", () => {
  it("a Mombongo reception never shows a blank supplier and never an invented one", () => {
    expect(approSupplierLabel({ ...base, fournisseur: "Marie Kabuya" })).toBe("Marie Kabuya");
    expect(
      approSupplierLabel({ ...base, mombongoProducer: { sellerId: "s", displayName: "Marie K." } }),
    ).toBe("Marie K.");
    expect(approSupplierLabel({ ...base, mombongoProducer: { sellerId: null } })).toBe(
      "Producteur Mombongo",
    );
  });
  it("a manual reception is unchanged", () => {
    expect(approSupplierLabel({ fournisseur: "Sian" })).toBe("Sian");
    expect(approSupplierLabel({ fournisseur: "" })).toBe("");
    expect(approPlaceLabel({ village: "Tshipinjinga" })).toBe("Tshipinjinga");
  });
  it("the place of a Mombongo seller comes from its enrichment, with an honest dash", () => {
    expect(
      approPlaceLabel({
        ...base,
        mombongoProducer: { sellerId: "s", province: "Kasaï", territory: "Kananga" },
      }),
    ).toBe("Kananga, Kasaï");
    expect(
      approPlaceLabel({ ...base, mombongoProducer: { sellerId: "s", province: "Kasaï" } }),
    ).toBe("Kasaï");
    expect(approPlaceLabel(base)).toBe("—");
  });
  it("labels the source", () => {
    expect(approSourceLabel({ sourceType: "mombongo" })).toBe("Offre Mombongo");
    expect(approSourceLabel({})).toBe("Manuelle");
  });
  it("Approvisionnement accepts the additive Step 6 fields", () => {
    const r: Approvisionnement = {
      id: "MBG-x",
      numero: "1",
      date: "d",
      idProducteur: "",
      fournisseur: "",
      village: "",
      produit: "Ananas",
      qteCommandeeKg: 10,
      qteRecueKg: 9,
      transport: 0,
      autresFrais: 0,
      qualite: "Conforme",
      sourceType: "mombongo",
      mombongoSource: { harvestOfferDocumentId: "o", mombongoOfferId: "x" },
      mombongoProducer: { sellerId: null },
      mombongoTerms: { acceptedQuantityKg: 10, acceptedPricePerKgCdf: 850 },
      priceObservation: { observedPricePerKgCdf: 900, reason: "r" },
      createdByUid: "u",
      createdAt: "t",
    };
    expect(r.priceObservation?.observedPricePerKgCdf).toBe(900);
  });
});
