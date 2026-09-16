import { createFileRoute } from "@tanstack/react-router";
import { confirmOrderReservation } from "@/lib/inventory/orderReservation";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";

/**
 * Sprint 08, Step C: `pending → confirmed`, reserving stock across
 * `stockBalance`/`stockLotBalance` inside one transaction. Same
 * endpoint-safety shape as `/api/inventory/qc-release` (stable status/
 * reason codes, correlation id, never a raw exception or Firestore
 * payload in the response) — see that route's own doc comment for the
 * full rationale, not repeated here.
 *
 * HTTP status: 200 success; 401 unauthorized; 400 malformed request;
 * 404 order not found; 422 order not pending, or an item references an
 * unknown/inactive/stale-format product; 409 insufficient stock (the one
 * permanent, never-retry-as-is outcome — the caller must change the
 * request, not just retry it); 500 unexpected error.
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

export const Route = createFileRoute("/api/inventory/confirm-order")({
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
            `[confirm-order ${correlationId}] rejected: body too large (${contentLengthHeader} bytes)`,
          );
          return errorResponse(correlationId, 413, "payload_too_large");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          console.error(`[confirm-order ${correlationId}] rejected: content-type "${contentType}"`);
          return errorResponse(correlationId, 400, "invalid_content_type");
        }

        const caller = await verifyCommercialInventoryCaller(request.headers.get("authorization"));
        if (!caller) {
          console.error(`[confirm-order ${correlationId}] rejected: unauthorized caller`);
          return errorResponse(correlationId, 401, "unauthorized");
        }

        const body = (await request.json().catch(() => null)) as { orderId?: unknown } | null;
        const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
        if (!orderId) {
          console.error(`[confirm-order ${correlationId}] rejected: missing/invalid orderId`);
          return errorResponse(correlationId, 400, "missing_fields");
        }

        try {
          const result = await confirmOrderReservation(orderId, caller.uid, correlationId);
          const status =
            result.status === "success"
              ? 200
              : result.status === "not_found"
                ? 404
                : result.status === "invalid_state" || result.status === "invalid_items"
                  ? 422
                  : result.status === "insufficient_stock"
                    ? 409
                    : 500;
          return Response.json({ ...result, correlationId }, { status });
        } catch (err) {
          console.error(`[confirm-order ${correlationId}] unexpected error:`, err);
          return errorResponse(correlationId, 500, "internal_error");
        }
      },
    },
  },
});
