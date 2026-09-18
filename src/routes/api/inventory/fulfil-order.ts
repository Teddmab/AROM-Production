import { createFileRoute } from "@tanstack/react-router";
import { fulfilOrderReservation } from "@/lib/inventory/orderReservation";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";

/**
 * Sprint 08, Step D: `confirmed → fulfilled`. Closes the reservation and,
 * in the same transaction, decrements `onHand` exactly once, writes one
 * immutable `stockPF` Sortie row per (order × lot × format), and writes
 * the linked `ventes` row(s) via the existing `VTE-ORD-*` deterministic
 * bridge — never a second, independent fulfilment path. Same endpoint-
 * safety shape as `/api/inventory/qc-release`.
 *
 * HTTP status: 200 success; 401 unauthorized; 400 malformed request;
 * 404 order not found; 422 order not confirmed/reserved; 500 unexpected error.
 */

const MAX_BODY_BYTES = 4 * 1024;

function errorResponse(
  correlationId: string,
  status: number,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  return Response.json({ status: "error", reason, correlationId, ...extra }, { status });
}

export const Route = createFileRoute("/api/inventory/fulfil-order")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const correlationId = crypto.randomUUID();

        const contentLengthHeader = request.headers.get("content-length");
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
        if (
          contentLength !== null &&
          (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES)
        ) {
          console.error(
            `[fulfil-order ${correlationId}] rejected: body too large (${contentLengthHeader} bytes)`,
          );
          return errorResponse(correlationId, 413, "payload_too_large");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          console.error(`[fulfil-order ${correlationId}] rejected: content-type "${contentType}"`);
          return errorResponse(correlationId, 400, "invalid_content_type");
        }

        const caller = await verifyCommercialInventoryCaller(request.headers.get("authorization"));
        if (!caller) {
          console.error(`[fulfil-order ${correlationId}] rejected: unauthorized caller`);
          return errorResponse(correlationId, 401, "unauthorized");
        }

        const body = (await request.json().catch(() => null)) as { orderId?: unknown } | null;
        const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
        if (!orderId) {
          console.error(`[fulfil-order ${correlationId}] rejected: missing/invalid orderId`);
          return errorResponse(correlationId, 400, "missing_fields");
        }

        try {
          const result = await fulfilOrderReservation(orderId, caller.uid, correlationId);
          const status =
            result.status === "success"
              ? 200
              : result.status === "not_found"
                ? 404
                : result.status === "invalid_state"
                  ? 422
                  : 500;
          return Response.json({ ...result, correlationId }, { status });
        } catch (err) {
          console.error(`[fulfil-order ${correlationId}] unexpected error:`, err);
          return errorResponse(correlationId, 500, "internal_error");
        }
      },
    },
  },
});
