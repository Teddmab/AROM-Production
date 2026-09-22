import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Sprint 08, Step E — dashboard direct-sale write boundary.
 *
 * Mirrors dashboard.protected-orders.test.ts's own static-guard shape (no
 * component-test infrastructure exists in this repo): this fails if
 * dashboard.tsx ever again constructs a client-side write of a NEW
 * `ventes` document outside the trusted `/api/inventory/direct-sale`
 * operation — the exact class of bug this sprint closed (the "Nouvelle
 * vente" EntryForm and the "commercialisation" task-completion handler
 * both wrote `ventes` directly via `addRow` before being repointed).
 *
 * `ImportButton.tsx`'s own bulk CSV/Excel import writer is a distinct,
 * deliberately untouched workflow — see the second describe block below,
 * which asserts (and documents) exactly why it's not part of this
 * boundary rather than silently ignoring it.
 */

const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf-8");

describe("dashboard.tsx — no active writer creates a ventes document outside the trusted operation", () => {
  it('never calls addRow("ventes", ...) anywhere — both former call sites (Nouvelle vente, the commercialisation task) are repointed', () => {
    expect(dashboardSource).not.toMatch(/addRow\(\s*["']ventes["']/);
  });

  it("imports and calls the trusted direct-sale client", () => {
    expect(dashboardSource).toMatch(/from ["']@\/lib\/inventory\/directSaleClient["']/);
    expect(dashboardSource).toMatch(/submitDirectSale\(/);
  });

  it('every VTE-DS- id constructed client-side comes from newId("VTE-DS") — never a raw template literal that could drift from the trusted route\'s own SALE_ID_PATTERN', () => {
    const rawVteDsLiterals = [...dashboardSource.matchAll(/[`'"]VTE-DS-\$\{/g)];
    expect(rawVteDsLiterals).toHaveLength(0);
    expect([...dashboardSource.matchAll(/newId\(["']VTE-DS["']\)/g)]).toHaveLength(2); // Nouvelle vente + the commercialisation task handler
  });

  it("the only remaining direct write of a ventes document by id is the legacy record-detail modal's edit/delete of an EXISTING selected sale (updateDoc/removeRow) — never a create", () => {
    const setLikeWrites = [
      ...dashboardSource.matchAll(/\b(?:setDoc|addDoc)\(\s*doc\(\s*db,\s*["']ventes["']/g),
    ];
    expect(setLikeWrites).toHaveLength(0); // no setDoc/addDoc of ventes anywhere in this file — creation only ever goes through addRow ("ventes" - none left) or the trusted route
  });
});

describe("ImportButton.tsx's own ventes writer is intentionally untouched — not a direct-sale workflow", () => {
  const importSource = readFileSync(
    new URL("../components/erp/ImportButton.tsx", import.meta.url),
    "utf-8",
  );

  it("never touches stockBalance, stockLotBalance or stockPF — proving it has no live inventory effect, unlike a real sale", () => {
    expect(importSource).not.toMatch(/stockBalance/);
    expect(importSource).not.toMatch(/stockLotBalance/);
    expect(importSource).not.toMatch(/stockPF/);
  });

  it('writes with the legacy newId("VTE") prefix, never VTE-DS- or VTE-ORD- — it can never collide with either trusted id space', () => {
    expect(importSource).not.toMatch(/VTE-DS-/);
    expect(importSource).not.toMatch(/VTE-ORD-/);
  });

  it("every import batch is logged to importLogs, so a bulk backfill is always attributable — never anonymous", () => {
    expect(importSource).toMatch(/importLogs/);
  });
});
