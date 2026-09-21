import { describe, expect, it } from "vitest";
import { calcAppro, computeErp } from "./engine";
import {
  SEED,
  type Approvisionnement,
  type ErpState,
  type Qualite,
  type ReceptionAssessment,
} from "./model";
import {
  MAX_RECEPTION_SOURCES,
  isUsableReception,
  receptionTreatment,
  toggleSelection,
} from "./receptionTreatment";
import { buildReport } from "./export";

/**
 * Downstream treatment of receptions by their AUTHORITATIVE receptionAssessment (2026-09): conforme = ordinary purchase; reserve = pending,
 * not a confirmed purchase, not usable; refusal = audit only, fruit value 0. Legacy-only records (no assessment) keep their historical
 * behaviour whatever their `qualite` says — nothing is inferred from a legacy label.
 */
const CONFORME: ReceptionAssessment = { outcome: "conforme", reasons: [], remark: "" };
const RESERVE: ReceptionAssessment = {
  outcome: "accepted_with_reserve",
  reasons: ["damaged_fruit"],
  remark: "Fruits écrasés",
};
const REFUSAL: ReceptionAssessment = {
  outcome: "refused_on_reception",
  reasons: ["wrong_product"],
  remark: "Autre produit",
};

function appro(over: Partial<Approvisionnement> = {}): Approvisionnement {
  return {
    id: "APP-1",
    numero: "001",
    date: "2026-09-20",
    idProducteur: "PRD-1",
    fournisseur: "Sian",
    village: "V",
    produit: "Ananas",
    qteCommandeeKg: 100,
    qteRecueKg: 100,
    prixKg: 800,
    transport: 500,
    autresFrais: 200,
    qualite: "Conforme" as Qualite,
    ...over,
  };
}
const withAppro = (...rows: Approvisionnement[]): ErpState => ({
  ...SEED,
  approvisionnements: rows,
  productions: [],
  ventes: [],
  stockMP: [],
  qualityControls: [],
});

describe("receptionTreatment — from the authoritative assessment only", () => {
  it("maps each outcome, and leaves everything without an assessment as legacy", () => {
    expect(receptionTreatment({ receptionAssessment: CONFORME })).toBe("confirmed");
    expect(receptionTreatment({ receptionAssessment: RESERVE })).toBe("pending_review");
    expect(receptionTreatment({ receptionAssessment: REFUSAL })).toBe("refused");
    expect(receptionTreatment({})).toBe("legacy");
    expect(receptionTreatment({ receptionAssessment: null })).toBe("legacy");
    // An outcome this client does not know is never invented into a release or a refusal.
    expect(
      receptionTreatment({
        receptionAssessment: { outcome: "approved", reasons: [], remark: "" } as never,
      }),
    ).toBe("legacy");
  });

  it("NO assessment is fabricated from a legacy quality label — Conforme, À vérifier, Rejeté and unknown all stay legacy", () => {
    for (const qualite of ["Conforme", "À vérifier", "Rejeté", "Valeur inconnue"] as const) {
      expect(receptionTreatment(appro({ qualite: qualite as Qualite }))).toBe("legacy");
      expect(calcAppro(appro({ qualite: qualite as Qualite })).receptionAssessment).toBeUndefined();
    }
  });

  it("only confirmed and legacy receptions are usable (stock / production source / invoice)", () => {
    expect(isUsableReception(appro({ receptionAssessment: CONFORME }))).toBe(true);
    expect(isUsableReception(appro())).toBe(true);
    expect(isUsableReception(appro({ qualite: "Rejeté" }))).toBe(true); // legacy: historical behaviour, not reinterpreted
    expect(isUsableReception(appro({ receptionAssessment: RESERVE }))).toBe(false);
    expect(isUsableReception(appro({ receptionAssessment: REFUSAL }))).toBe(false);
  });
});

describe("calcAppro", () => {
  it("authoritative Conforme: unchanged — value, total and costs as before", () => {
    const c = calcAppro(appro({ receptionAssessment: CONFORME }));
    expect(c).toMatchObject({
      traitement: "confirmed",
      valeurAchat: 80000,
      valeurEnAttente: 0,
      fraisObserves: 700,
      coutTotal: 80700,
    });
  });
  it("legacy (any label): the historical formula, exactly", () => {
    for (const qualite of ["Conforme", "À vérifier", "Rejeté"] as const) {
      expect(calcAppro(appro({ qualite }))).toMatchObject({
        traitement: "legacy",
        valeurAchat: 80000,
        valeurEnAttente: 0,
        coutTotal: 80700,
      });
    }
  });
  it("reserve: the fruit value is PENDING (not a purchase), nothing is confirmed or payable, costs stay separate", () => {
    const c = calcAppro(appro({ receptionAssessment: RESERVE, qualite: "À vérifier" }));
    expect(c).toMatchObject({
      traitement: "pending_review",
      valeurAchat: 0,
      valeurEnAttente: 80000,
      fraisObserves: 700,
      coutTotal: 0,
    });
  });
  it("refusal: fruit purchase value is 0, no pending value, no total that suggests money is owed; costs stay separate", () => {
    const c = calcAppro(appro({ receptionAssessment: REFUSAL, qualite: "Rejeté" }));
    expect(c).toMatchObject({
      traitement: "refused",
      valeurAchat: 0,
      valeurEnAttente: 0,
      fraisObserves: 700,
      coutTotal: 0,
    });
  });
});

describe("computeErp — purchases, stock-relevant kilograms and costs are CONFIRMED receptions only", () => {
  const rows = [
    appro({ id: "C", receptionAssessment: CONFORME }),
    appro({ id: "L", qualite: "Rejeté" }), // legacy
    appro({
      id: "R",
      receptionAssessment: RESERVE,
      qualite: "À vérifier",
      qteRecueKg: 40,
      transport: 100,
      autresFrais: 50,
    }),
    appro({
      id: "X",
      receptionAssessment: REFUSAL,
      qualite: "Rejeté",
      qteRecueKg: 30,
      transport: 20,
      autresFrais: 10,
    }),
  ];
  const c = computeErp(withAppro(...rows));

  it("kg and purchase cost exclude the reserved and the refused reception", () => {
    expect(c.kgAchetes).toBe(200); // C + L only
    expect(c.coutAchats).toBe(160000);
    expect(c.coutTransport).toBe(1400); // C + L costs; the reserve's and the refusal's are NOT operating costs yet
  });

  it("reserve and refusal stay visible, counted as records, and their costs are reported separately", () => {
    expect(c.receptions).toEqual({
      total: 4,
      confirmees: 2,
      sousReserve: 1,
      refusees: 1,
      kgSousReserve: 40,
      kgRefusees: 30,
      valeurEnAttente: 32000,
      fraisObservesHorsAchats: 180,
    });
    expect(c.appro.map((r) => r.id)).toEqual(["C", "L", "R", "X"]);
  });

  it("neither the reserve's nor the refusal's fruit value reaches any total", () => {
    const onlyBad = computeErp(withAppro(rows[2], rows[3]));
    expect(onlyBad.kgAchetes).toBe(0);
    expect(onlyBad.coutAchats).toBe(0);
    expect(onlyBad.coutTransport).toBe(0);
    expect(onlyBad.totalCouts).toBe(computeErp(withAppro()).totalCouts); // identical to having no receptions at all
    expect(onlyBad.receptions.total).toBe(2);
  });

  it("a legacy-only dataset behaves exactly as before", () => {
    const legacy = computeErp(
      withAppro(
        appro({ id: "A" }),
        appro({ id: "B", qualite: "Rejeté" }),
        appro({ id: "D", qualite: "À vérifier" }),
      ),
    );
    expect(legacy.kgAchetes).toBe(300);
    expect(legacy.coutAchats).toBe(240000);
    expect(legacy.coutTransport).toBe(2100);
    expect(legacy.receptions).toMatchObject({
      total: 3,
      confirmees: 3,
      sousReserve: 0,
      refusees: 0,
    });
  });
});

describe("export — keeps the audit trail and never presents refused fruit as purchased", () => {
  const state = withAppro(
    appro({ id: "C", numero: "C1", receptionAssessment: CONFORME }),
    appro({
      id: "R",
      numero: "R1",
      receptionAssessment: RESERVE,
      qualite: "À vérifier",
      autresFraisMotif: "Sacs",
    }),
    appro({ id: "X", numero: "X1", receptionAssessment: REFUSAL, qualite: "Rejeté" }),
    appro({ id: "L", numero: "L1" }),
  );
  const blocks = buildReport("appro", state, computeErp(state)).blocks;
  const table = blocks.find((b) => b.title === "Achats fournisseurs")!;
  const col = (name: string) => table.headers.indexOf(name);
  const row = (numero: string) => table.rows.find((r) => r[0] === numero)!;

  it("has assessment, reasons, remark, other-cost reason, pending value and observed costs columns", () => {
    for (const h of [
      "Traitement",
      "Motifs du constat",
      "Remarque du constat",
      "Motif autres frais",
      "Valeur en attente (réserve)",
      "Frais constatés",
    ])
      expect(col(h)).toBeGreaterThan(-1);
    expect(row("R1")[col("Motifs du constat")]).toBe("damaged_fruit");
    expect(row("R1")[col("Remarque du constat")]).toBe("Fruits écrasés");
    expect(row("R1")[col("Motif autres frais")]).toBe("Sacs");
  });

  it("reserve: pending value in its own column, purchase value and total 0; refusal: 0 everywhere for the fruit", () => {
    expect(row("R1")[col("Valeur achat")]).toBe(0);
    expect(row("R1")[col("Coût total")]).toBe(0);
    expect(row("R1")[col("Valeur en attente (réserve)")]).toBe(80000);
    expect(row("X1")[col("Valeur achat")]).toBe(0);
    expect(row("X1")[col("Coût total")]).toBe(0);
    expect(row("X1")[col("Valeur en attente (réserve)")]).toBe(0);
    expect(row("X1")[col("Traitement")]).toMatch(/non achetée/);
  });

  it("observed costs stay visible and separate for every reception; conforme and legacy keep their purchase value", () => {
    expect(row("R1")[col("Frais constatés")]).toBe(700);
    expect(row("X1")[col("Frais constatés")]).toBe(700);
    expect(row("C1")[col("Valeur achat")]).toBe(80000);
    expect(row("L1")[col("Valeur achat")]).toBe(80000);
    expect(row("L1")[col("Traitement")]).toMatch(/Historique/);
  });
});

describe("refused reception without a unit price (2026-09 decision)", () => {
  const refused = () => {
    const { prixKg: _omit, ...rest } = appro({ receptionAssessment: REFUSAL, qualite: "Rejeté" });
    return rest as Approvisionnement;
  };

  it("calcAppro tolerates an absent price ONLY for an authoritative refusal: value 0, no NaN, costs kept separate, not flagged", () => {
    const c = calcAppro(refused());
    expect(c.prixKg).toBeUndefined();
    expect(c).toMatchObject({
      traitement: "refused",
      valeurAchat: 0,
      valeurEnAttente: 0,
      coutTotal: 0,
      fraisObserves: 700,
      prixManquant: false,
    });
    expect(Number.isNaN(c.valeurAchat) || Number.isNaN(c.coutTotal)).toBe(false);
  });

  it("any other reception without a price is FLAGGED as incomplete data, never silently priced: conforme, reserve, legacy", () => {
    for (const r of [
      appro({ receptionAssessment: CONFORME }),
      appro({ receptionAssessment: RESERVE }),
      appro(),
      appro({ qualite: "Rejeté" }),
    ]) {
      const { prixKg: _omit, ...rest } = r;
      expect(calcAppro(rest as Approvisionnement).prixManquant).toBe(true);
    }
    expect(calcAppro(appro()).prixManquant).toBe(false);
  });

  it("a price that is present on a refusal (older client) is still ignored for value: a refusal never has a fruit purchase value", () => {
    expect(calcAppro(appro({ receptionAssessment: REFUSAL, prixKg: 800 }))).toMatchObject({
      valeurAchat: 0,
      valeurEnAttente: 0,
      coutTotal: 0,
    });
  });

  it("aggregates and exports handle the absent price: totals exclude it, the price cell is blank (not 0), observed costs stay visible", () => {
    const state = withAppro(appro({ id: "C", numero: "C1", receptionAssessment: CONFORME }), {
      ...refused(),
      id: "X",
      numero: "X1",
    });
    const c = computeErp(state);
    expect(c.kgAchetes).toBe(100);
    expect(c.coutAchats).toBe(80000);
    expect(c.receptions).toMatchObject({
      refusees: 1,
      kgRefusees: 100,
      fraisObservesHorsAchats: 700,
    });
    const table = buildReport("appro", state, c).blocks.find(
      (b) => b.title === "Achats fournisseurs",
    )!;
    const row = table.rows.find((r) => r[0] === "X1")!;
    expect(row[table.headers.indexOf("Prix/kg")]).toBe("");
    expect(row[table.headers.indexOf("Valeur achat")]).toBe(0);
    expect(row[table.headers.indexOf("Frais constatés")]).toBe(700);
    expect(table.rows.find((r) => r[0] === "C1")![table.headers.indexOf("Prix/kg")]).toBe(800);
  });
});

describe("observed costs of reserve / refusal are pending: excluded from every confirmed total (2026-09 decision)", () => {
  it("costs sit only in the separate `fraisObservesHorsAchats` bucket — not in coutTransport, coutAchats or totalCouts", () => {
    const rows = [
      appro({ id: "C", receptionAssessment: CONFORME }),
      appro({ id: "R", receptionAssessment: RESERVE, transport: 1000, autresFrais: 500 }),
      appro({ id: "X", receptionAssessment: REFUSAL, transport: 2000, autresFrais: 250 }),
    ];
    const c = computeErp(withAppro(...rows));
    const confirmedOnly = computeErp(withAppro(rows[0]));
    expect(c.coutTransport).toBe(700);
    expect(c.coutAchats).toBe(confirmedOnly.coutAchats);
    expect(c.totalCouts).toBe(confirmedOnly.totalCouts);
    expect(c.receptions.fraisObservesHorsAchats).toBe(3750);
  });
});

describe("source-count limit", () => {
  it("MAX_RECEPTION_SOURCES is 8 (AROM-Backend's verifiable Rules limit) and the picker refuses a ninth without truncating", () => {
    expect(MAX_RECEPTION_SOURCES).toBe(8);
    const eight = Array.from({ length: 8 }, (_, i) => `APP-${i}`);
    expect(toggleSelection(eight.slice(0, 7), "APP-7", 8)).toEqual(eight);
    expect(toggleSelection(eight, "APP-9", 8)).toEqual(eight); // refused: unchanged, nothing dropped
    expect(toggleSelection(eight, "APP-3", 8)).toEqual(eight.filter((x) => x !== "APP-3")); // removing always works
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]); // no max: as before
  });
});
