import { createFileRoute } from "@tanstack/react-router";
import { createMombongoOffer } from "@/lib/payments/mombongoHarvest";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";
import { RECONCILIATION_ACTOR } from "@/lib/payments/mombongoActors";

/** Sprint DP: submit an offer on a published harvest listing. Same auth pattern as create-invoice.ts. */
export const Route = createFileRoute("/api/mombongo/create-offer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        // createdByUid always comes from the verified token, never the body;
        // the reserved system actor can never be a submitting user.
        if (caller.uid === RECONCILIATION_ACTOR) {
          return Response.json({ error: "reserved_actor" }, { status: 403 });
        }

        const body = (await request.json().catch(() => null)) as {
          listingId?: string;
          offerQuantityKg?: number;
          offerPricePerKgCdf?: number;
          message?: string;
          commodity?: string;
          province?: string;
          territory?: string;
          quality?: "A" | "B" | "C";
        } | null;
        if (!body?.listingId || !body.offerQuantityKg || !body.offerPricePerKgCdf) {
          return Response.json({ error: "missing_fields" }, { status: 400 });
        }

        try {
          const result = await createMombongoOffer({
            listingId: body.listingId,
            offerQuantityKg: body.offerQuantityKg,
            offerPricePerKgCdf: body.offerPricePerKgCdf,
            message: body.message,
            commodity: body.commodity,
            province: body.province,
            territory: body.territory,
            quality: body.quality,
            createdByUid: caller.uid,
          });
          // None of in_flight/conflict/unknown/reference_mismatch are
          // safe to retry as-is (see createMombongoOffer's own doc
          // comment) — 409 signals "don't just retry this," distinct from
          // a 5xx (which would suggest a transient fault worth retrying
          // blindly) and from 200 (which would look like ordinary
          // success to a caller that doesn't inspect the body).
          const status =
            result.status === "rejected"
              ? 400
              : result.status === "error"
                ? 502
                : result.status === "in_flight" ||
                    result.status === "conflict" ||
                    result.status === "unknown" ||
                    result.status === "reference_mismatch"
                  ? 409
                  : 200;
          return Response.json(result, { status });
        } catch (err) {
          console.error("createMombongoOffer failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
