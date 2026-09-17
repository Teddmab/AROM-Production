import { createFileRoute } from "@tanstack/react-router";
import { getMombongoListings } from "@/lib/payments/mombongoHarvest";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/** Sprint DP: browse Mombongo's published harvest listings. Same auth pattern as create-invoice.ts. */
export const Route = createFileRoute("/api/mombongo/listings")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = (await request.json().catch(() => ({}))) as {
          commodity?: string;
          province?: string;
          limit?: number;
        };

        try {
          const result = await getMombongoListings(body);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: 502 });
          }
          return Response.json(result, { status: 200 });
        } catch (err) {
          console.error("getMombongoListings failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
