import { createFileRoute } from "@tanstack/react-router";
import { createMombongoCheckout } from "@/lib/payments/mombongo";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/** See create-invoice.ts's doc comment — same auth pattern, same reason this is a route, not a server function. */
export const Route = createFileRoute("/api/mombongo/create-checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = (await request.json().catch(() => null)) as {
          producerInvoiceId?: string;
          mombongoInvoiceId?: string;
          method?: "card" | "mobile_money";
          phone?: string;
          operator?: "mpesa" | "airtel" | "orange";
        } | null;
        if (!body?.producerInvoiceId || !body.mombongoInvoiceId || !body.method) {
          return Response.json({ error: "missing_fields" }, { status: 400 });
        }
        if (body.method === "mobile_money" && (!body.phone || !body.operator)) {
          return Response.json({ error: "missing_mobile_money_fields" }, { status: 400 });
        }

        try {
          const result = await createMombongoCheckout({
            producerInvoiceId: body.producerInvoiceId,
            mombongoInvoiceId: body.mombongoInvoiceId,
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
          console.error("createMombongoCheckout failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
