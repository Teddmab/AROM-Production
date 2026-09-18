import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Deliberately separate from vite.config.ts (web ERP correction, 2026-09):
 * that config wires TanStack Start's SSR plugin and a Cloudflare/Nitro
 * build target, neither of which a plain unit test of a pure function
 * (src/lib/erp/engine.ts) needs — reusing it would pull in server-only
 * plugin machinery for no benefit. Only the "@" path alias is shared.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
  },
});
