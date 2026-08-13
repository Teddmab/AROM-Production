import { defineTool } from "@lovable.dev/mcp-js";
import { calcAppro } from "@/lib/erp/engine";
import { SEED } from "@/lib/erp/model";

export default defineTool({
  name: "list_supply_chain",
  title: "Producteurs et approvisionnements",
  description:
    "Liste les producteurs partenaires d'AROM et les commandes d'approvisionnement avec quantités reçues, prix au kg, transport et coût total.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: () => {
    const data = {
      producteurs: SEED.producteurs,
      approvisionnements: SEED.approvisionnements.map(calcAppro),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  },
});
