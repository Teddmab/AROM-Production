import { describe, expect, it } from "vitest";
import { isStockFormat, STOCK_FORMATS, toBusinessFormat, toStockFormat } from "./stockFormat";

describe("toStockFormat — parses every supported business value", () => {
  it.each([
    ["500 ml", "500ml"],
    ["330 ml", "330ml"],
    ["300 ml", "300ml"],
  ] as const)("%s -> %s", (business, canonical) => {
    expect(toStockFormat(business)).toBe(canonical);
  });
});

describe("toStockFormat — rejects everything else, no fuzzy matching", () => {
  it.each([
    "500ml",
    "500  ml",
    " 500 ml",
    "500 ml ",
    "500ML",
    "500",
    "500 milliliters",
    "1L",
    "",
    "500 ml,330 ml",
  ])("rejects %j", (value) => {
    expect(toStockFormat(value)).toBeNull();
  });

  it("rejects a value inherited from Object.prototype (e.g. 'toString')", () => {
    expect(toStockFormat("toString")).toBeNull();
    expect(toStockFormat("constructor")).toBeNull();
  });
});

describe("toBusinessFormat — total, exhaustive, matches the reverse of toStockFormat", () => {
  it.each(STOCK_FORMATS)(
    "%s round-trips through toStockFormat(toBusinessFormat(...))",
    (format) => {
      expect(toStockFormat(toBusinessFormat(format))).toBe(format);
    },
  );
});

describe("isStockFormat", () => {
  it.each(STOCK_FORMATS)("accepts %s", (format) => {
    expect(isStockFormat(format)).toBe(true);
  });

  it.each(["500 ml", "500ML", "500", "", "700ml"])("rejects %j", (value) => {
    expect(isStockFormat(value)).toBe(false);
  });
});
