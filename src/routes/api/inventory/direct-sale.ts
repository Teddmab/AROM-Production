import { createFileRoute } from "@tanstack/react-router";
import { createDirectSale, type DirectSaleInput } from "@/lib/inventory/directSale";
import { verifyCommercialInventoryCaller } from "@/lib/auth/verifyCommercialInventoryCaller";

/**
 * Sprint 08, Step E: a manual (no-order) sale. Same endpoint-safety shape
 * as `/api/inventory/{qc-release,confirm-order,cancel-order,fulfil-order}`
 * — verifies the caller, never trusts client-sent totals/availability/
 * lot ids, allocates FIFO, and either fully commits or writes nothing.
 *
 * HTTP status: 200 success; 400 malformed request or invalid sale id;
 * 401 unauthorized; 409 insufficient stock; 422 invalid product/format/
 * quantity/price; 500 unexpected error.
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

interface RequestBody {
  saleId?: unknown;
  format?: unknown;
  quantity?: unknown;
  prixUnitaire?: unknown;
  remise?: unknown;
  encaisse?: unknown;
  idClient?: unknown;
  clientNom?: unknown;
  canal?: unknown;
  numero?: unknown;
  commerciale?: unknown;
}

function parseInput(body: RequestBody | null): DirectSaleInput | null {
  const saleId = typeof body?.saleId === "string" ? body.saleId.trim() : "";
  const format = typeof body?.format === "string" ? body.format : "";
  const quantity = typeof body?.quantity === "number" ? body.quantity : NaN;
  const prixUnitaire = typeof body?.prixUnitaire === "number" ? body.prixUnitaire : NaN;
  const commerciale =
    typeof body?.commerciale === "string" && body.commerciale.trim() ? body.commerciale.trim() : "";
  if (!saleId || !format || !commerciale) return null;
  return {
    saleId,
    format,
    quantity,
    prixUnitaire,
    commerciale,
    remise: typeof body?.remise === "number" ? body.remise : undefined,
    encaisse: typeof body?.encaisse === "number" ? body.encaisse : undefined,
    idClient: typeof body?.idClient === "string" ? body.idClient : undefined,
    clientNom: typeof body?.clientNom === "string" ? body.clientNom : undefined,
    canal: typeof body?.canal === "string" ? body.canal : undefined,
    numero: typeof body?.numero === "string" ? body.numero : undefined,
  };
}

export const Route = createFileRoute("/api/inventory/direct-sale")({
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
            `[direct-sale ${correlationId}] rejected: body too large (${contentLengthHeader} bytes)`,
          );
          return errorResponse(correlationId, 413, "payload_too_large");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          console.error(`[direct-sale ${correlationId}] rejected: content-type "${contentType}"`);
          return errorResponse(correlationId, 400, "invalid_content_type");
        }

        const caller = await verifyCommercialInventoryCaller(request.headers.get("authorization"));
        if (!caller) {
          console.error(`[direct-sale ${correlationId}] rejected: unauthorized caller`);
          return errorResponse(correlationId, 401, "unauthorized");
        }

        const body = (await request.json().catch(() => null)) as RequestBody | null;
        const input = parseInput(body);
        if (!input) {
          console.error(`[direct-sale ${correlationId}] rejected: missing/invalid fields`);
          return errorResponse(correlationId, 400, "missing_fields");
        }

        try {
          const result = await createDirectSale(input, caller.uid, correlationId);
          const status =
            result.status === "success"
              ? 200
              : result.status === "invalid_sale_id"
                ? 400
                : result.status === "insufficient_stock"
                  ? 409
                  : result.status === "invalid_items"
                    ? 422
                    : 500;
          return Response.json({ ...result, correlationId }, { status });
        } catch (err) {
          console.error(`[direct-sale ${correlationId}] unexpected error:`, err);
          return errorResponse(correlationId, 500, "internal_error");
        }
      },
    },
  },
});
