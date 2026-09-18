import { createFileRoute } from "@tanstack/react-router";
import { createMombongoInvoice } from "@/lib/payments/mombongo";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/**
 * MOB-07/09: called by AROM-Mobile's real `mombongoProducerPaymentGateway`
 * (not AROM-Production's own frontend — a server *route*, same reasoning
 * as the webhook: "meant for HTTP endpoints that need to be called from
 * outside your TanStack Start application"). Auth is the calling admin's
 * own Firebase ID token (`Authorization: Bearer <idToken>`), verified
 * against Firebase directly (no Admin SDK — see
 * verifyFirebaseIdToken.ts), then checked against `users/{uid}.role`.
 */
export const Route = createFileRoute("/api/mombongo/create-invoice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = (await request.json().catch(() => null)) as {
          producerInvoiceId?: string;
          reference?: string;
          dueDate?: string;
        } | null;
        if (!body?.producerInvoiceId) {
          return Response.json({ error: "missing_fields" }, { status: 400 });
        }

        try {
          const result = await createMombongoInvoice({
            producerInvoiceId: body.producerInvoiceId,
            reference: body.reference,
            dueDate: body.dueDate,
          });
          const status =
            result.status === "not_found"
              ? 404
              : result.status === "unsupported_currency"
                ? 501
                : result.status === "error"
                  ? 502
                  : 200;
          return Response.json(result, { status });
        } catch (err) {
          console.error("createMombongoInvoice failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
