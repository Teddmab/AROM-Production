import { createFileRoute } from "@tanstack/react-router";
import { authorizeOfferRefreshCaller } from "@/lib/auth/authorizeOfferRefreshCaller";
import { runOfferRefresh } from "@/lib/payments/mombongoOfferRefresh";

/**
 * POST /api/mombongo/refresh-receivable-offers — AROM-Mobile asks AROM to
 * refresh the accepted Mombongo offers a field agent receives against
 * (seller/listing context, expiring thumbnails, historical backfill). See
 * mombongoOfferRefresh.ts for exactly what it does, never does, and its bounds.
 *
 * Allowed: an active Agent de collecte or an active admin — decided only from
 * the verified ID token and that uid's own profile (authorizeOfferRefreshCaller).
 * 401 = no valid identity, 403 = not permitted.
 *
 * The request body and query string are deliberately NEVER read: there is no
 * input by which a caller could choose pagination, status, role, partner,
 * Firebase project or Mombongo environment.
 *
 * The response is a safe operational summary only — never credentials,
 * signatures, raw Mombongo payloads, farmer records or thumbnail URLs — and
 * carries no instruction to clear anything: a throttled/unavailable/partial
 * answer always leaves the client's cache and Firestore exactly as they were.
 */
export const Route = createFileRoute("/api/mombongo/refresh-receivable-offers")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let auth;
        try {
          auth = await authorizeOfferRefreshCaller(request.headers.get("authorization"));
        } catch (err) {
          console.error(
            "refresh-receivable-offers: authorization failed",
            err instanceof Error ? err.name : "unknown",
          );
          return Response.json({ error: "unavailable" }, { status: 503 });
        }
        if (!auth.ok) {
          return Response.json(
            { error: auth.status === 401 ? "unauthorized" : "forbidden" },
            { status: auth.status },
          );
        }

        try {
          const result = await runOfferRefresh();
          if (result.status === "throttled") return Response.json(result, { status: 429 });
          return Response.json(result, { status: result.status === "unavailable" ? 502 : 200 });
        } catch (err) {
          console.error(
            "refresh-receivable-offers failed:",
            err instanceof Error ? err.name : "unknown",
          );
          return Response.json({ error: "internal_error" }, { status: 500 });
        }
      },
    },
  },
});
