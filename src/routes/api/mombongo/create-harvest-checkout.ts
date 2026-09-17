import { createFileRoute } from "@tanstack/react-router";
import { createMombongoHarvestCheckout } from "@/lib/payments/mombongoHarvest";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/** Sprint DP: pay a harvest-sale invoice (one Mombongo originated via invoiceIssued). Same auth pattern as create-checkout.ts. */
export const Route = createFileRoute("/api/mombongo/create-harvest-checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = (await request.json().catch(() => null)) as {
          harvestInvoiceId?: string;
          method?: "card" | "mobile_money";
          phone?: string;
          operator?: "mpesa" | "airtel" | "orange";
        } | null;
        if (!body?.harvestInvoiceId || !body.method) {
          return Response.json({ error: "missing_fields" }, { status: 400 });
        }
        if (body.method === "mobile_money" && (!body.phone || !body.operator)) {
          return Response.json({ error: "missing_mobile_money_fields" }, { status: 400 });
        }

        try {
          const result = await createMombongoHarvestCheckout({
            harvestInvoiceId: body.harvestInvoiceId,
            method: body.method,
            phone: body.phone,
            operator: body.operator,
          });
          const status =
            result.status === "already_in_progress"
              ? 409
              : result.status === "not_found"
                ? 404
                : result.status === "provider_error"
                  ? 502
                  : result.status === "error"
                    ? 502
                    : 200;
          return Response.json(result, { status });
        } catch (err) {
          console.error("createMombongoHarvestCheckout failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
