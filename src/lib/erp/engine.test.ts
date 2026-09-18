import { describe, expect, it } from "vitest";
import { computeErp } from "./engine";
import { SEED, type ErpState, type Production, type QualityControl } from "./model";

/**
 * Web ERP correction (2026-09): "the existing web dashboard must stop
 * treating all packaged production as sellable stock before quality
 * release." These tests pin exactly the four required behaviors — see
 * engine.ts's own computeErp/headControlsByProduction doc comments for the
 * gating logic itself.
 */
function production(overrides: Partial<Production> = {}): Production {
  return {
    id: "PRO-1",
    lot: "001_AROM",
    date: "2026-08-28",
    kgUtilises: 100,
    volumeJusL: 45,
    q500: 60,
    q330: 0,
    q300: 0,
    rejets: 0,
    responsable: "Directeur de production",
    statut: "Terminé",
    ...overrides,
  };
}

function qc(overrides: Partial<QualityControl> = {}): QualityControl {
  return { id: "QC-1", productionId: "PRO-1", decision: "liberer", ...overrides };
}

function stateWith(productions: Production[], qualityControls: QualityControl[]): ErpState {
  return { ...SEED, productions, ventes: [], qualityControls };
}

function stock500ml(state: ErpState) {
  return computeErp(state).stockPF.find((s) => s.format === "500 ml")!;
}

describe("computeErp — stockPF is gated by quality-control release, not raw packaging", () => {
  it("unreviewed production (no quality control at all) is not sellable stock", () => {
    const state = stateWith([production()], []);
    expect(stock500ml(state).produites).toBe(0);
    expect(stock500ml(state).stock).toBe(0);
  });

  it("quarantined production (head control decision: quarantaine) is not sellable stock", () => {
    const state = stateWith([production()], [qc({ decision: "quarantaine" })]);
    expect(stock500ml(state).produites).toBe(0);
  });

  it("rejected production (head control decision: rejeter) is not sellable stock", () => {
    const state = stateWith([production()], [qc({ decision: "rejeter" })]);
    expect(stock500ml(state).produites).toBe(0);
  });

  it("released production (head control decision: liberer) appears once, at its own packaged quantity", () => {
    const state = stateWith([production({ q500: 60 })], [qc({ decision: "liberer" })]);
    expect(stock500ml(state).produites).toBe(60);
  });

  it("a quarantine resolved to liberer counts the production exactly once, not twice (both controls present)", () => {
    const quarantine = qc({ id: "QC-1", decision: "quarantaine" });
    const resolution = qc({ id: "QC-2", decision: "liberer", resolvesId: "QC-1" });
    const state = stateWith([production({ q500: 60 })], [quarantine, resolution]);
    expect(stock500ml(state).produites).toBe(60); // not 120 — one production, counted once
  });

  it("mixes released, quarantined, rejected, and unreviewed productions correctly in the same total", () => {
    const state = stateWith(
      [
        production({ id: "PRO-released", q500: 10 }),
        production({ id: "PRO-quarantine", q500: 20 }),
        production({ id: "PRO-rejected", q500: 30 }),
        production({ id: "PRO-unreviewed", q500: 40 }),
      ],
      [
        qc({ id: "QC-r", productionId: "PRO-released", decision: "liberer" }),
        qc({ id: "QC-q", productionId: "PRO-quarantine", decision: "quarantaine" }),
        qc({ id: "QC-x", productionId: "PRO-rejected", decision: "rejeter" }),
      ],
    );
    expect(stock500ml(state).produites).toBe(10); // only PRO-released's own 10
  });
});
