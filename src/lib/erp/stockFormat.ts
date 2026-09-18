import type { Format } from "./model";

/**
 * Canonical format contract (Sprint 08, Step A) — hand-kept in sync across
 * AROM-Production (this file), AROM-Mobile
 * (`src/features/stockPF/stockFormat.ts`), and AROM-Backend
 * (`scripts/lib/stockFormat.mjs`); no shared package exists between the
 * three repos, and three values don't justify creating one. Whichever
 * file you're reading, the contract is identical:
 *
 * - Business format values ("this" repo's own `Format` type, what
 *   `products`/`orders.items`/`ventes` store today): `"500 ml"` |
 *   `"330 ml"` | `"300 ml"`.
 * - Stock format keys ("canonical", what `stockPF`/`stockBalance`/
 *   `stockLotBalance` store): `"500ml"` | `"330ml"` | `"300ml"`.
 *
 * `toStockFormat` is the one parsing entry point for untrusted/free-text
 * input claiming to be a business format — no fuzzy matching, no generic
 * whitespace stripping, no partial match. Anything that isn't exactly one
 * of the three recognized business strings returns `null`; the caller
 * must treat that as a real rejection, never fall through to a default.
 */

export type StockFormat = "500ml" | "330ml" | "300ml";

const FORMAT_TO_STOCK: Readonly<Record<Format, StockFormat>> = {
  "500 ml": "500ml",
  "330 ml": "330ml",
  "300 ml": "300ml",
};

const STOCK_TO_FORMAT: Readonly<Record<StockFormat, Format>> = {
  "500ml": "500 ml",
  "330ml": "330 ml",
  "300ml": "300 ml",
};

/** Parses an untrusted string claiming to be a business-convention format ("500 ml") into the canonical stock format key. `null` for anything else — including an already-canonical value, a typo, extra whitespace, a wholly different string, or a JS object-prototype property name ("toString", "constructor", ...) that plain bracket/`in` lookup would otherwise resolve via the prototype chain. */
export function toStockFormat(value: string): StockFormat | null {
  return Object.prototype.hasOwnProperty.call(FORMAT_TO_STOCK, value)
    ? FORMAT_TO_STOCK[value as Format]
    : null;
}

/** Total — every canonical format has exactly one business representation, so this can never fail. */
export function toBusinessFormat(format: StockFormat): Format {
  return STOCK_TO_FORMAT[format];
}

/** Type guard for an already-canonical value of unknown origin (e.g. read back from a Firestore document) — not a parser, no conversion. */
export function isStockFormat(value: string): value is StockFormat {
  return value === "500ml" || value === "330ml" || value === "300ml";
}

/** Every canonical format, in a stable order. */
export const STOCK_FORMATS: readonly StockFormat[] = ["500ml", "330ml", "300ml"];
