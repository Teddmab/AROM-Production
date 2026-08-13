import { defineTool } from "@lovable.dev/mcp-js";
import { computeErp } from "@/lib/erp/engine";
import { SEED } from "@/lib/erp/model";

export default defineTool({
  name: "get_dashboard_summary",
  title: "Résumé du tableau de bord",
  description:
    "Retourne les indicateurs consolidés de la campagne pilote AROM : approvisionnement, production, stocks, ventes, finances, primes et marketing.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: () => {
    const c = computeErp(SEED);
    const summary = {
      approvisionnement: {
        kgAchetes: c.kgAchetes,
        coutAchats: c.coutAchats,
        coutTransport: c.coutTransport,
      },
      production: {
        bouteillesProduites: c.bouteillesProduites,
        volumeJusL: c.volumeJus,
        pertesL: c.pertesL,
        tauxPertes: c.tauxPertes,
        rendementMoyen: c.rendementMoyen,
        valeurProduction: c.valeurProduction,
      },
      stocks: {
        matierePremierePieces: c.stockMPPieces,
        matierePremiereValeur: c.stockMPValeur,
        produitsFinis: c.stockPF,
      },
      ventes: {
        bouteillesVendues: c.bouteillesVendues,
        chiffreAffaires: c.ca,
        encaissements: c.encaissements,
        creances: c.creances,
        tauxEncaissement: c.tauxEncaissement,
        clientsActifs: c.clientsActifs,
      },
      finances: {
        totalCouts: c.totalCouts,
        resultatBrut: c.resultatBrut,
        margeBrute: c.margeBrute,
        coutMoyenBouteille: c.coutMoyenBouteille,
        margeUnitaire: c.margeUnitaire,
      },
      primes: {
        primeProduction: c.primeProduction,
        commissionCommerciale: c.commissionCommerciale,
        totalPrimes: c.totalPrimes,
      },
      marketing: {
        coutMarketing: c.coutMarketing,
        contacts: c.contactsTouches,
        prospects: c.prospects,
        roi: c.roiMarketing,
      },
      devise: "FC",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});
