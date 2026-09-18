import { createFileRoute } from "@tanstack/react-router";
import { createMombongoOffer } from "@/lib/payments/mombongoHarvest";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/** Sprint DP: submit an offer on a published harvest listing. Same auth pattern as create-invoice.ts. */
export const Route = createFileRoute("/api/mombongo/create-offer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
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
          const status = result.status === "rejected" ? 400 : result.status === "error" ? 502 : 200;
          return Response.json(result, { status });
        } catch (err) {
          console.error("createMombongoOffer failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
