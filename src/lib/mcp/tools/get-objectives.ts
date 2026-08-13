import { defineTool } from "@lovable.dev/mcp-js";
import { computeErp } from "@/lib/erp/engine";
import { SEED } from "@/lib/erp/model";

export default defineTool({
  name: "get_objectives",
  title: "Objectifs et taux de réalisation",
  description:
    "Liste les objectifs de la campagne AROM (approvisionnement, production, ventes, encaissement, clients, marge) avec le réalisé, le taux d'atteinte, le statut et le responsable.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: () => {
    const { objectifs } = computeErp(SEED);
    return {
      content: [{ type: "text", text: JSON.stringify(objectifs, null, 2) }],
      structuredContent: { objectifs },
    };
  },
});
