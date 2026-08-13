import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { calcProduction } from "@/lib/erp/engine";
import { SEED } from "@/lib/erp/model";

export default defineTool({
  name: "list_production_lots",
  title: "Lots de production",
  description:
    "Détaille les journées de production (lot, date, kg utilisés, litres de jus, bouteilles par format, pertes, rendement, valeur).",
  inputSchema: {
    lot: z.string().optional().describe("Filtre optionnel sur le numéro de lot, ex. 001_AROM."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ lot }) => {
    const rows = SEED.productions
      .filter((r) => !lot || r.lot.toLowerCase().includes(lot.toLowerCase()))
      .map((r) => calcProduction(r, SEED.parametres));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { lignes: rows, total: rows.length },
    };
  },
});
