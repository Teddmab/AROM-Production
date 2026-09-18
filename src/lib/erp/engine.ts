import {
  type ErpState,
  type Production,
  type Approvisionnement,
  type Vente,
  type Format,
  type QualityControl,
  prixFormat,
} from "./model";

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);

/**
 * The head/authoritative control for each productionId — the one control
 * nobody else's `resolvesId` points at (a fresh control with no resolution
 * yet, or the resolution itself once one exists). Mirrors AROM-Mobile's
 * qualityRepository.ts's headControlsByProduction and AROM-Backend's
 * report-finished-stock-eligibility.mjs exactly — same logic, three
 * independent implementations (no shared package across these repos), kept
 * in sync by hand. A production with no control at all simply has no entry
 * here (correctly excluded from sellable stock — see computeErp's own use
 * of this below).
 */
function headControlsByProduction(controls: QualityControl[]): Map<string, QualityControl> {
  const byProductionId = new Map<string, QualityControl[]>();
  for (const c of controls) {
    const list = byProductionId.get(c.productionId) ?? [];
    list.push(c);
    byProductionId.set(c.productionId, list);
  }
  const heads = new Map<string, QualityControl>();
  for (const [productionId, group] of byProductionId) {
    const head = group.find((c) => !group.some((other) => other.resolvesId === c.id));
    if (head) heads.set(productionId, head);
  }
  return heads;
}

/* ---------- Lignes calculées ---------- */

export interface ApproCalc extends Approvisionnement {
  valeurAchat: number;
  coutTotal: number;
}

export function calcAppro(r: Approvisionnement): ApproCalc {
  const valeurAchat = r.qteRecueKg * r.prixKg;
  return { ...r, valeurAchat, coutTotal: valeurAchat + r.transport + r.autresFrais };
}

export interface ProductionCalc extends Production {
  totalBouteilles: number;
  volumeConditionne: number;
  pertesL: number;
  rendement: number;
  valeurProduction: number;
  conformes: number;
}

export function calcProduction(r: Production, p: ErpState["parametres"]): ProductionCalc {
  const totalBouteilles = r.q500 + r.q330 + r.q300;
  const volumeConditionne = r.q500 * 0.5 + r.q330 * 0.33 + r.q300 * 0.3;
  const pertesL = Math.max(r.volumeJusL - volumeConditionne, 0);
  return {
    ...r,
    totalBouteilles,
    volumeConditionne,
    pertesL,
    rendement: safeDiv(volumeConditionne, r.volumeJusL),
    valeurProduction: r.q500 * p.prix500 + r.q330 * p.prix330 + r.q300 * p.prix300,
    conformes: Math.max(totalBouteilles - r.rejets, 0),
  };
}

export interface VenteCalc extends Vente {
  montantBrut: number;
  soldeDu: number;
  statutPaiement: "Payé" | "Partiel" | "À crédit";
}

export function calcVente(r: Vente): VenteCalc {
  const montantBrut = r.quantite * r.prixUnitaire - r.remise;
  const soldeDu = montantBrut - r.encaisse;
  return {
    ...r,
    montantBrut,
    soldeDu,
    statutPaiement: r.encaisse <= 0 ? "À crédit" : soldeDu <= 0 ? "Payé" : "Partiel",
  };
}

/* ---------- Consolidation (feuilles Finances / Commissions / Dashboard) ---------- */

export interface ErpComputed {
  appro: ApproCalc[];
  production: ProductionCalc[];
  ventes: VenteCalc[];
  kgAchetes: number;
  kgTransformes: number;
  coutAchats: number;
  coutTransport: number;
  bouteillesProduites: number;
  bouteillesVendues: number;
  valeurProduction: number;
  volumeJus: number;
  pertesL: number;
  tauxPertes: number;
  rendementMoyen: number;
  stockMPPieces: number;
  stockMPValeur: number;
  stockPF: { format: Format; produites: number; vendues: number; stock: number; valeur: number }[];
  ca: number;
  encaissements: number;
  creances: number;
  tauxEncaissement: number;
  coutMarketing: number;
  autresCharges: number;
  totalCouts: number;
  resultatBrut: number;
  margeBrute: number;
  rendementSurCouts: number;
  coutMoyenBouteille: number;
  prixMoyenVendu: number;
  margeUnitaire: number;
  clientsActifs: number;
  primeProduction: number;
  commissionCommerciale: number;
  totalPrimes: number;
  contactsTouches: number;
  prospects: number;
  roiMarketing: number;
  objectifs: {
    label: string;
    objectif: number;
    realise: number;
    taux: number;
    unite: "kg" | "bt" | "%" | "FC";
    responsable: string;
    statut: "Atteint" | "À surveiller" | "Critique";
  }[];
}

function statutFrom(taux: number): "Atteint" | "À surveiller" | "Critique" {
  return taux >= 1 ? "Atteint" : taux >= 0.75 ? "À surveiller" : "Critique";
}

export function computeErp(state: ErpState): ErpComputed {
  const p = state.parametres;
  const appro = state.approvisionnements.map(calcAppro);
  const production = state.productions.map((r) => calcProduction(r, p));
  const ventes = state.ventes.map(calcVente);
  const headControls = headControlsByProduction(state.qualityControls);

  const kgAchetes = sum(appro.map((r) => r.qteRecueKg));
  const kgTransformes = sum(production.map((r) => r.kgUtilises));
  const coutAchats = sum(appro.map((r) => r.valeurAchat));
  const coutTransport = sum(appro.map((r) => r.transport + r.autresFrais));

  const bouteillesProduites = sum(production.map((r) => r.totalBouteilles));
  const valeurProduction = sum(production.map((r) => r.valeurProduction));
  const volumeJus = sum(production.map((r) => r.volumeJusL));
  const pertesL = sum(production.map((r) => r.pertesL));
  const volumeConditionne = sum(production.map((r) => r.volumeConditionne));

  const bouteillesVendues = sum(ventes.map((r) => r.quantite));
  const ca = sum(ventes.map((r) => r.montantBrut));
  const encaissements = sum(ventes.map((r) => r.encaisse));
  const creances = sum(ventes.map((r) => r.soldeDu));

  const coutMarketing = sum(state.marketing.map((r) => r.coutReel));
  const autresCharges = sum(state.charges.map((r) => r.realise));
  // Staff bonuses are a real cost of running the campaign — folded into
  // totalCouts (and everything derived from it: resultatBrut, margeBrute,
  // rendementSurCouts, coutMoyenBouteille, margeUnitaire) rather than only
  // shown separately on the Primes & personnel page.
  const primeProduction = sum(production.map((r) => r.valeurProduction)) * p.tauxPrimeProduction;
  const commissionCommerciale = encaissements * p.tauxCommission;
  const totalCouts =
    coutAchats +
    coutTransport +
    autresCharges +
    coutMarketing +
    primeProduction +
    commissionCommerciale;
  const resultatBrut = ca - totalCouts;

  // Web ERP correction (2026-09): this used to sum every production's
  // q500/q330/q300 regardless of quality-control decision, so a
  // quarantined or rejected lot's bottles counted as sellable stock —
  // reported and fixed. Now gated by the SAME head-control logic
  // AROM-Mobile's qualitySync.ts uses to decide whether a release is
  // authoritative (headControlsByProduction above): a production counts
  // toward `produites` only when its own head control's decision is
  // exactly "liberer" — never for a production with no control yet, one
  // still in quarantine, or one rejected.
  //
  // This is a QC-gated PROJECTION computed from productions +
  // qualityControls — it does NOT read the Firestore `stockPF` ledger
  // itself. It is equivalent to summing that ledger only for what's
  // currently supported: production receipts ("Entrée" rows), which is
  // the only thing either side writes today. It is NOT a durable "single
  // source of truth" — the moment outbound movements (order fulfilment
  // Sortie), damage, or manual corrections exist as real `stockPF` rows,
  // this projection will diverge from the ledger's real on-hand balance,
  // since it only ever re-derives "produites" from packaging fields and
  // has no way to know about a Sortie/Ajustement it never reads. Whichever
  // batch implements outbound movements must migrate this to real
  // aggregation over the `stockPF` collection (see AROM-Documentation/
  // automation-engine.md's "Next lifecycle" section) rather than extending
  // this projection further.
  const releasedProductionIds = new Set(
    production.filter((r) => headControls.get(r.id)?.decision === "liberer").map((r) => r.id),
  );
  const stockPF = (["500 ml", "330 ml", "300 ml"] as Format[]).map((f) => {
    const produites = sum(
      production
        .filter((r) => releasedProductionIds.has(r.id))
        .map((r) => (f === "500 ml" ? r.q500 : f === "330 ml" ? r.q330 : r.q300)),
    );
    const vendues = sum(ventes.filter((v) => v.format === f).map((v) => v.quantite));
    const stock = produites - vendues;
    return { format: f, produites, vendues, stock, valeur: stock * prixFormat(p, f) };
  });

  const stockMPPieces = sum(state.stockMP.map((m) => m.entree - m.sortie));
  const dernierCout = state.stockMP.length
    ? state.stockMP[state.stockMP.length - 1].coutUnitaire
    : 0;

  const clientsActifs = new Set(ventes.map((v) => v.idClient || v.client).filter(Boolean)).size;
  const tauxEncaissement = safeDiv(encaissements, ca);
  const margeBrute = safeDiv(resultatBrut, ca);
  const tauxPertes = safeDiv(pertesL, volumeJus);

  const objectifs: ErpComputed["objectifs"] = [
    {
      label: "Approvisionnement ananas",
      objectif: p.objectifAnanasKg,
      realise: kgAchetes,
      unite: "kg",
      responsable: "Directeur production",
    },
    {
      label: "Production bouteilles",
      objectif: p.objectifBouteilles,
      realise: bouteillesProduites,
      unite: "bt",
      responsable: "Directeur production",
    },
    {
      label: "Ventes bouteilles",
      objectif: p.objectifBouteilles,
      realise: bouteillesVendues,
      unite: "bt",
      responsable: "Chargée commerciale",
    },
    {
      label: "Taux d'encaissement",
      objectif: 1,
      realise: tauxEncaissement,
      unite: "%",
      responsable: "Chargée commerciale",
    },
    {
      label: "Clients actifs",
      objectif: p.objectifClients,
      realise: clientsActifs,
      unite: "bt",
      responsable: "Chargée commerciale",
    },
    {
      label: "Marge brute",
      objectif: p.objectifMargeBrute,
      realise: margeBrute,
      unite: "%",
      responsable: "Direction générale",
    },
  ].map((o) => ({
    ...o,
    taux: safeDiv(o.realise, o.objectif),
    statut: statutFrom(safeDiv(o.realise, o.objectif)),
  })) as ErpComputed["objectifs"];

  return {
    appro,
    production,
    ventes,
    kgAchetes,
    kgTransformes,
    coutAchats,
    coutTransport,
    bouteillesProduites,
    bouteillesVendues,
    valeurProduction,
    volumeJus,
    pertesL,
    tauxPertes,
    rendementMoyen: safeDiv(volumeConditionne, volumeJus),
    stockMPPieces,
    stockMPValeur: stockMPPieces * dernierCout,
    stockPF,
    ca,
    encaissements,
    creances,
    tauxEncaissement,
    coutMarketing,
    autresCharges,
    totalCouts,
    resultatBrut,
    margeBrute,
    rendementSurCouts: safeDiv(resultatBrut, totalCouts),
    coutMoyenBouteille: safeDiv(totalCouts, bouteillesProduites),
    prixMoyenVendu: safeDiv(ca, bouteillesVendues),
    margeUnitaire: safeDiv(ca, bouteillesVendues) - safeDiv(totalCouts, bouteillesProduites),
    clientsActifs,
    primeProduction,
    commissionCommerciale,
    totalPrimes: primeProduction + commissionCommerciale,
    contactsTouches: sum(state.marketing.map((m) => m.contacts)),
    prospects: sum(state.marketing.map((m) => m.prospects)),
    roiMarketing: safeDiv(
      sum(state.marketing.map((m) => m.ventesGenerees)) - coutMarketing,
      coutMarketing,
    ),
    objectifs,
  };
}
