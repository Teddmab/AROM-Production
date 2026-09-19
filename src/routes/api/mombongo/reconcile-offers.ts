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
 * Throttle: a simple in-process minimum-interval guard (this Worker
 * instance only — no persisted, cross-instance throttle exists, since
 * AROM-Backend's externalIntegrations/mombongo doc is write-restricted to
 * isAdmin() and no other Rules-writable location exists for
 * isMombongoWebhook() to store one; a durable, cross-instance throttle
 * would need a Backend Rules change, out of scope here). This still
 * meaningfully prevents an accidental hot-loop of refresh taps from the
 * same warm Worker instance from re-running the whole paginated
 * reconciliation back to back.
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
          const summary = await reconcileMombongoOffers();
          return Response.json(summary, { status: summary.error ? 502 : 200 });
        } catch (err) {
          console.error("reconcileMombongoOffers failed:", err);
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
