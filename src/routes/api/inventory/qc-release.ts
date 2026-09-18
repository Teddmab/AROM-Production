import { createFileRoute } from "@tanstack/react-router";
import { applyQcReleaseReceipt } from "@/lib/inventory/qcReleaseReceipt";
import { verifyInventoryServiceCaller } from "@/lib/auth/verifyInventoryServiceCaller";

/**
 * Sprint 08, Step B: called by AROM-Mobile's qualitySync.ts once its own
 * `qualityControls` transaction has committed — never before, never in the
 * same transaction (the client no longer writes `stockPF`/balance
 * projections at all; see automation-engine.md's "Trusted write boundary").
 * Auth is the calling staff member's own Firebase ID token
 * (`Authorization: Bearer <idToken>`), verified the same
 * no-Admin-SDK-needed way as `/api/mombongo/*` (see
 * verifyInventoryServiceCaller.ts).
 *
 * Endpoint-safety hardening (Step B hardening, 2026-09):
 * - Every response body is a plain, stable shape — a status/reason code
 *   and, on success, the format lists `applyQcReleaseReceipt` itself
 *   returns. Never a Firestore document, never an error's `.stack`, never
 *   a raw exception message — those are logged server-side only, tagged
 *   with this request's own correlation id, never sent to the caller.
 * - `correlationId` (a fresh id per request, independent of any business
 *   document) is on every response and every server-side log line for
 *   this request, so a report referencing one links straight to the exact
 *   log lines — without needing to log the request body or any Firestore
 *   payload to make that link.
 * - HTTP status alone tells the caller whether to retry: 409 is the one
 *   permanent, never-retry outcome (`inventoryReleaseClient.ts`'s own
 *   `retryable: false` branch); 404/422/500 are all retryable — matches
 *   qualitySync.ts's own failed vs conflict envelope states.
 */

const MAX_BODY_BYTES = 4 * 1024; // a `{qualityControlId}` body is a few dozen bytes; generous headroom, not a real limit on real callers

function errorResponse(
  correlationId: string,
  status: number,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  return Response.json({ status: "error", reason, correlationId, ...extra }, { status });
}

export const Route = createFileRoute("/api/inventory/qc-release")({
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
            `[qc-release ${correlationId}] rejected: body too large (${contentLengthHeader} bytes)`,
          );
          return errorResponse(correlationId, 413, "payload_too_large");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          console.error(`[qc-release ${correlationId}] rejected: content-type "${contentType}"`);
          return errorResponse(correlationId, 400, "invalid_content_type");
        }

        const caller = await verifyInventoryServiceCaller(request.headers.get("authorization"));
        if (!caller) {
          console.error(`[qc-release ${correlationId}] rejected: unauthorized caller`);
          return errorResponse(correlationId, 401, "unauthorized");
        }

        const body = (await request.json().catch(() => null)) as {
          qualityControlId?: unknown;
        } | null;
        const qualityControlId =
          typeof body?.qualityControlId === "string" ? body.qualityControlId.trim() : "";
        if (!qualityControlId) {
          console.error(`[qc-release ${correlationId}] rejected: missing/invalid qualityControlId`);
          return errorResponse(correlationId, 400, "missing_fields");
        }

        try {
          const result = await applyQcReleaseReceipt(qualityControlId, caller.uid, correlationId);
          const status =
            result.status === "success"
              ? 200
              : result.status === "not_found"
                ? 404
                : result.status === "invalid_state"
                  ? 422
                  : result.status === "conflict"
                    ? 409
                    : 500;
          return Response.json({ ...result, correlationId }, { status });
        } catch (err) {
          // Defensive only — applyQcReleaseReceipt already catches its own
          // transaction errors and returns a `status: "error"` result; this
          // covers a genuinely unexpected throw upstream of that (e.g. a
          // caller-identity lookup failure). Full detail stays server-side.
          console.error(`[qc-release ${correlationId}] unexpected error:`, err);
          return errorResponse(correlationId, 500, "internal_error");
        }
      },
    },
  },
});
