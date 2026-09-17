import { doc, getDoc } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";
import { signInAsMombongoSystem } from "./mombongoSystemAuth";

/**
 * FC/CDF->USD rate, from `config/exchangeRate` — seeded 2026-08-31 with
 * the value read directly from Mombongo's own `config/exchange_rate.usdToCdf`
 * (`AROM-Backend/scripts/set-exchange-rate.mjs`), so both systems price
 * the same producer-invoice payment consistently. Admin-write-only, same
 * no-deploy-needed rotation pattern as `externalIntegrations/mombongo` —
 * updating the rate is a script run (or a future dashboard action), never
 * a deployment. Not cached, for the same reason `mombongoConfig.ts`
 * isn't: a rate change should take effect immediately, not whenever a
 * Worker isolate happens to recycle.
 */
export async function getUsdToCdfRate(): Promise<number> {
  await signInAsMombongoSystem();
  const snap = await getDoc(doc(serverDb, "config", "exchangeRate"));
  if (!snap.exists()) {
    throw new Error("config/exchangeRate doesn't exist — run set-exchange-rate.mjs first.");
  }
  const rate = snap.data().usdToCdf;
  if (typeof rate !== "number" || rate <= 0) {
    throw new Error("config/exchangeRate.usdToCdf is missing or invalid.");
  }
  return rate;
}

/** FC and CDF are the same currency (Congolese Franc) — AROM's own field just uses the French abbreviation. */
export function convertFcToUsd(amountFc: number, usdToCdf: number): number {
  return Math.round((amountFc / usdToCdf) * 100) / 100;
}
