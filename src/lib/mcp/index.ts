import { defineMcp } from "@lovable.dev/mcp-js";
import getDashboardSummary from "./tools/get-dashboard-summary";
import getObjectives from "./tools/get-objectives";
import listProductionLots from "./tools/list-production-lots";
import listSupplyChain from "./tools/list-suppliers";
import simulateScenario from "./tools/simulate-scenario";

export default defineMcp({
  name: "juice-flow-dashboard",
  title: "Juice Flow Dashboard",
  version: "0.1.0",
  instructions:
    "Outils de lecture pour l'ERP AROM (jus d'ananas naturel, campagne pilote 2026). Utilisez get_dashboard_summary pour la vue consolidée, get_objectives pour le suivi des objectifs, list_production_lots et list_supply_chain pour le détail opérationnel, et simulate_scenario pour tester des hypothèses de prix, primes ou ventes sans modifier les données.",
  tools: [
    getDashboardSummary,
    getObjectives,
    listProductionLots,
    listSupplyChain,
    simulateScenario,
  ],
});
