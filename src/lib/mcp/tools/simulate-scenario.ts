import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { computeErp } from "@/lib/erp/engine";
import { SEED, type ErpState } from "@/lib/erp/model";

export default defineTool({
  name: "simulate_scenario",
  title: "Simuler un scénario",
  description:
    "Recalcule les indicateurs AROM avec des hypothèses modifiées (prix de vente, taux de prime/commission, objectifs, bouteilles vendues au prix courant). Ne modifie aucune donnée enregistrée.",
  inputSchema: {
    prix500: z.number().optional().describe("Prix de vente du format 500 ml en FC."),
    prix330: z.number().optional().describe("Prix de vente du format 330 ml en FC."),
    prix300: z.number().optional().describe("Prix de vente du format 300 ml en FC."),
    tauxCommission: z
      .number()
      .optional()
      .describe("Taux de commission commerciale, en décimal (0.1 = 10 %)."),
    tauxPrimeProduction: z
      .number()
      .optional()
      .describe("Taux de prime production, en décimal (0.18 = 18 %)."),
    objectifBouteilles: z.number().optional().describe("Objectif de bouteilles pour la campagne."),
    objectifAnanasKg: z
      .number()
      .optional()
      .describe("Objectif d'approvisionnement en kg d'ananas."),
    bouteillesVendues500: z
      .number()
      .optional()
      .describe("Bouteilles 500 ml vendues et encaissées à simuler."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: (input) => {
    const parametres = { ...SEED.parametres };
    for (const key of [
      "prix500",
      "prix330",
      "prix300",
      "tauxCommission",
      "tauxPrimeProduction",
      "objectifBouteilles",
      "objectifAnanasKg",
    ] as const) {
      const value = input[key];
      if (typeof value === "number" && Number.isFinite(value)) parametres[key] = value;
    }

    const state: ErpState = { ...SEED, parametres, ventes: [...SEED.ventes] };
    const qte = input.bouteillesVendues500;
    if (typeof qte === "number" && qte > 0) {
      state.ventes = [
        ...state.ventes,
        {
          id: "SIM-1",
          numero: "SIM_001",
          date: parametres.finProduction,
          idClient: "SIM-CLIENT",
          client: "Scénario simulé",
          canal: "Grossiste",
          format: "500 ml",
          quantite: Math.round(qte),
          prixUnitaire: parametres.prix500,
          remise: 0,
          encaisse: Math.round(qte) * parametres.prix500,
          commerciale: "Chargée commerciale",
        },
      ];
    }

    const base = computeErp(SEED);
    const c = computeErp(state);
    const result = {
      hypotheses: { ...input },
      simule: {
        chiffreAffaires: c.ca,
        resultatBrut: c.resultatBrut,
        margeBrute: c.margeBrute,
        valeurProduction: c.valeurProduction,
        primeProduction: c.primeProduction,
        commissionCommerciale: c.commissionCommerciale,
        objectifs: c.objectifs,
      },
      reference: {
        chiffreAffaires: base.ca,
        resultatBrut: base.resultatBrut,
        margeBrute: base.margeBrute,
        valeurProduction: base.valeurProduction,
        primeProduction: base.primeProduction,
        commissionCommerciale: base.commissionCommerciale,
      },
      devise: "FC",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
