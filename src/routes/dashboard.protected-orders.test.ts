import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Sprint 08, Steps C/D — dashboard integration gap.
 *
 * No component-test infrastructure exists in this repo (no
 * @testing-library/react, no render()ed test anywhere), so this is a
 * narrow, focused static guard rather than a general source-code linter:
 * it fails if dashboard.tsx ever again constructs a client-side write of
 * a protected order transition (pending->confirmed, confirmed->fulfilled)
 * or the `reservation` field directly — the exact class of bug this
 * sprint closed (setStatus/confirmWithDeliveryDate/fulfillAndConvert/the
 * task-driven confirm+fulfil handlers all wrote these fields directly
 * before being repointed at the trusted /api/inventory/* routes).
 *
 * confirmed->cancelled and pending->cancelled are deliberately not
 * checked here: cancelling a pending order never touches stock/
 * reservation and is an approved direct-write carve-out (see
 * automation-engine.md), and the confirmed-cancel path is covered by
 * asserting cancelOrderTrusted is actually used below.
 */

const source = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf-8");

describe("dashboard.tsx — protected order transitions stay trusted-route-only", () => {
  it('never constructs a client-side write of status: "confirmed"', () => {
    expect(source).not.toMatch(/status:\s*["']confirmed["']/);
  });

  it('never constructs a client-side write of status: "fulfilled"', () => {
    expect(source).not.toMatch(/status:\s*["']fulfilled["']/);
  });

  it("never constructs a client-side write of a reservation field", () => {
    expect(source).not.toMatch(/\breservation\s*:/);
  });

  it("imports and calls all three trusted order-reservation routes", () => {
    expect(source).toMatch(/from ["']@\/lib\/inventory\/orderReservationClient["']/);
    expect(source).toMatch(/confirmOrderTrusted\(/);
    expect(source).toMatch(/cancelOrderTrusted\(/);
    expect(source).toMatch(/fulfilOrderTrusted\(/);
  });

  it("the only remaining direct order status write is the pending-cancel carve-out", () => {
    const directWrites = [
      ...source.matchAll(/updateDoc\(doc\(db, ["']orders["'][^)]*\), \{ status \}\)/g),
    ];
    expect(directWrites).toHaveLength(1);
  });
});
