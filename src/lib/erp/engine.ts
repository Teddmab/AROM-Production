import {
  type ErpState,
  type Production,
  type Approvisionnement,
  type Vente,
  type Format,
  prixFormat,
} from "./model";

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);

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
  const totalCouts = coutAchats + coutTransport + autresCharges + coutMarketing;
  const resultatBrut = ca - totalCouts;

  const stockPF = (["500 ml", "330 ml", "300 ml"] as Format[]).map((f) => {
    const produites = sum(
      production.map((r) => (f === "500 ml" ? r.q500 : f === "330 ml" ? r.q330 : r.q300)),
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

  const primeProduction = sum(production.map((r) => r.valeurProduction)) * p.tauxPrimeProduction;
  const commissionCommerciale = encaissements * p.tauxCommission;

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
