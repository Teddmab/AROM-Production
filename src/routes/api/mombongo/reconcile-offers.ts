import { createFileRoute } from "@tanstack/react-router";
import { reconcileMombongoOffers } from "@/lib/payments/mombongoReconciliation";
import { verifyMombongoCaller } from "@/lib/auth/verifyMombongoCaller";

/**
 * Contract v2 (Section G) — a trusted, authenticated route AROM-Mobile
 * can call to request a reconciliation pass, without ever reaching
 * Mombongo directly or seeing partner credentials (verifyMombongoCaller
 * gates on the calling admin's real Firebase ID token, same pattern as
 * every other /api/mombongo/* route). Returns only safe counts/
 * diagnostics — never Mombongo's response bodies, never a credential.
 *
 * Throttle: an in-process minimum-interval guard (this Worker instance only).
 * It is NOT needed for correctness — concurrent runs are safe (idempotent
 * application, forward-only compare-and-set checkpoint, see
 * mombongoReconciliation.ts) — it only avoids wasted duplicate work from a
 * hot loop of refresh taps.
 */
const MIN_INTERVAL_MS = 10_000;
let lastRunAt = 0;

export const Route = createFileRoute("/api/mombongo/reconcile-offers")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await verifyMombongoCaller(request.headers.get("authorization"));
        if (!caller) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const now = Date.now();
        if (now - lastRunAt < MIN_INTERVAL_MS) {
          return Response.json(
            { status: "throttled", retryAfterMs: MIN_INTERVAL_MS - (now - lastRunAt) },
            { status: 429 },
          );
        }
        lastRunAt = now;

        try {
          // No request input is read here on purpose: the checkpoint
          // document, the bootstrap lower bound, the overlap and the page
          // limits are all fixed server-side, so a caller can only ask
          // "please reconcile", never choose what or from where.
          const summary = await reconcileMombongoOffers();
          const status =
            summary.status === "error" ? 502 : summary.status === "not_configured" ? 503 : 200;
          return Response.json(summary, { status });
        } catch (err) {
          console.error(
            "reconcileMombongoOffers failed:",
            err instanceof Error ? err.name : "unknown",
          );
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
