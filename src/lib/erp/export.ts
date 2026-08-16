/**
 * Export des dashboards ERP AROM — PDF (impression) et Excel (CSV UTF-8).
 * Chaque export est filtré par période (dates) et par campagne.
 */

import type { ErpState } from "./model";
import { fcFormat, pctFormat } from "./model";
import { computeErp, type ErpComputed } from "./engine";

export type ExportSection =
  | "executif"
  | "appro"
  | "production"
  | "stock"
  | "commercialisation"
  | "parcours"
  | "marketing"
  | "finances"
  | "kpi";

export interface ExportFilter {
  from: string; // yyyy-mm-dd ("" = pas de borne)
  to: string;
  campagne: string; // "" = toutes
}

export interface ReportBlock {
  title: string;
  headers: string[];
  rows: (string | number)[][];
}

export interface Report {
  section: ExportSection;
  titre: string;
  responsable: string;
  blocks: ReportBlock[];
}

export const SECTION_LABELS: Record<ExportSection, { titre: string; responsable: string }> = {
  executif: { titre: "Tableau de bord exécutif", responsable: "Direction générale" },
  kpi: { titre: "KPI stratégiques", responsable: "Direction générale" },
  appro: { titre: "Approvisionnement", responsable: "Directeur de production" },
  production: { titre: "Production", responsable: "Directeur de production" },
  stock: { titre: "Stocks", responsable: "Directeur de production" },
  commercialisation: {
    titre: "Ventes & commercialisation",
    responsable: "Chargée de commercialisation",
  },
  parcours: { titre: "Parcours production", responsable: "Direction générale" },
  marketing: { titre: "Marketing & communication", responsable: "Chargée de commercialisation" },
  finances: { titre: "Finances", responsable: "Direction générale" },
};

/* ---------- Filtrage période / campagne ---------- */

const inPeriode = (date: string, f: ExportFilter) =>
  (!f.from || date >= f.from) && (!f.to || date <= f.to);

const matchCampagne = (tag: string | undefined, f: ExportFilter) =>
  !f.campagne || tag === f.campagne;

export function campagnesDisponibles(state: ErpState): string[] {
  const tags = [
    ...state.approvisionnements.map((r) => r.numero),
    ...state.productions.map((r) => r.lot),
    ...state.marketing.map((r) => r.campagne),
  ].filter(Boolean);
  return Array.from(new Set(tags));
}

export function filterErpState(state: ErpState, f: ExportFilter): ErpState {
  return {
    ...state,
    approvisionnements: state.approvisionnements.filter(
      (r) => inPeriode(r.date, f) && matchCampagne(r.numero, f),
    ),
    productions: state.productions.filter((r) => inPeriode(r.date, f) && matchCampagne(r.lot, f)),
    stockMP: state.stockMP.filter((r) => inPeriode(r.date, f)),
    ventes: state.ventes.filter((r) => inPeriode(r.date, f)),
    marketing: state.marketing.filter((r) => inPeriode(r.date, f) && matchCampagne(r.campagne, f)),
  };
}

/* ---------- Construction du rapport ---------- */

const n = (v: number) => Math.round(v * 100) / 100;

export function buildReport(section: ExportSection, state: ErpState, c: ErpComputed): Report {
  const meta = SECTION_LABELS[section];
  const blocks: ReportBlock[] = [];

  if (section === "executif") {
    blocks.push({
      title: "Indicateurs clés de la campagne",
      headers: ["Indicateur", "Objectif", "Réalisé", "Taux"],
      rows: [
        [
          "Ananas achetés (kg)",
          state.parametres.objectifAnanasKg,
          n(c.kgAchetes),
          pctFormat(
            state.parametres.objectifAnanasKg ? c.kgAchetes / state.parametres.objectifAnanasKg : 0,
          ),
        ],
        [
          "Ananas transformés (kg)",
          state.parametres.objectifAnanasKg,
          n(c.kgTransformes),
          pctFormat(
            state.parametres.objectifAnanasKg
              ? c.kgTransformes / state.parametres.objectifAnanasKg
              : 0,
          ),
        ],
        [
          "Bouteilles produites",
          state.parametres.objectifBouteilles,
          c.bouteillesProduites,
          pctFormat(
            state.parametres.objectifBouteilles
              ? c.bouteillesProduites / state.parametres.objectifBouteilles
              : 0,
          ),
        ],
        [
          "Bouteilles vendues",
          state.parametres.objectifBouteilles,
          c.bouteillesVendues,
          pctFormat(
            state.parametres.objectifBouteilles
              ? c.bouteillesVendues / state.parametres.objectifBouteilles
              : 0,
          ),
        ],
        [
          "Clients actifs",
          state.parametres.objectifClients,
          c.clientsActifs,
          pctFormat(
            state.parametres.objectifClients
              ? c.clientsActifs / state.parametres.objectifClients
              : 0,
          ),
        ],
        [
          "Marge brute",
          pctFormat(state.parametres.objectifMargeBrute),
          pctFormat(c.margeBrute),
          pctFormat(
            state.parametres.objectifMargeBrute
              ? c.margeBrute / state.parametres.objectifMargeBrute
              : 0,
          ),
        ],
      ],
    });
    blocks.push({
      title: "Synthèse financière consolidée",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Chiffre d'affaires", fcFormat(c.ca)],
        ["Encaissements", fcFormat(c.encaissements)],
        ["Créances clients", fcFormat(c.creances)],
        ["Total coûts", fcFormat(c.totalCouts)],
        ["Résultat brut", fcFormat(c.resultatBrut)],
        ["Valeur de production", fcFormat(c.valeurProduction)],
        ["Primes & commissions", fcFormat(c.totalPrimes)],
      ],
    });
  }

  if (section === "kpi") {
    blocks.push({
      title: "Indicateurs stratégiques",
      headers: ["Indicateur", "Objectif", "Réalisé"],
      rows: [
        [
          "Taux de transformation",
          "100 %",
          pctFormat(c.kgAchetes ? c.kgTransformes / c.kgAchetes : 0),
        ],
        [
          "Taux de vente",
          "100 %",
          pctFormat(c.bouteillesProduites ? c.bouteillesVendues / c.bouteillesProduites : 0),
        ],
        ["Taux d'encaissement", "100 %", pctFormat(c.tauxEncaissement)],
        ["Rendement matière", "> 95 %", pctFormat(c.rendementMoyen)],
        ["Pertes", `< ${pctFormat(state.parametres.tauxPertesMax)}`, pctFormat(c.tauxPertes)],
        ["Clients actifs", state.parametres.objectifClients, c.clientsActifs],
        ["Marge brute", pctFormat(state.parametres.objectifMargeBrute), pctFormat(c.margeBrute)],
        ["Coût moyen / bouteille", "-", fcFormat(c.coutMoyenBouteille)],
        ["Prix moyen vendu", "-", fcFormat(c.prixMoyenVendu)],
        ["Marge unitaire", "-", fcFormat(c.margeUnitaire)],
        ["ROI marketing", "-", pctFormat(c.roiMarketing)],
        ["Créances à recouvrer", "0 FC", fcFormat(c.creances)],
      ],
    });
  }

  if (section === "appro") {
    blocks.push({
      title: "Achats fournisseurs",
      headers: [
        "N°",
        "Date",
        "Fournisseur",
        "Village",
        "Commandé (kg)",
        "Reçu (kg)",
        "Prix/kg",
        "Transport",
        "Autres frais",
        "Qualité",
        "Valeur achat",
        "Coût total",
      ],
      rows: c.appro.map((r) => [
        r.numero,
        r.date,
        r.fournisseur,
        r.village,
        r.qteCommandeeKg,
        r.qteRecueKg,
        r.prixKg,
        r.transport,
        r.autresFrais,
        r.qualite,
        n(r.valeurAchat),
        n(r.coutTotal),
      ]),
    });
    blocks.push({
      title: "Synthèse approvisionnement",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Kg achetés", n(c.kgAchetes)],
        ["Objectif kg", state.parametres.objectifAnanasKg],
        ["Coût des achats", fcFormat(c.coutAchats)],
        ["Transport & frais", fcFormat(c.coutTransport)],
        [
          "Coût moyen / kg",
          fcFormat(c.kgAchetes ? (c.coutAchats + c.coutTransport) / c.kgAchetes : 0),
        ],
      ],
    });
  }

  if (section === "production") {
    blocks.push({
      title: "Lots de production",
      headers: [
        "Lot",
        "Date",
        "Kg utilisés",
        "Volume jus (L)",
        "500 ml",
        "330 ml",
        "300 ml",
        "Total bouteilles",
        "Rejets",
        "Pertes (L)",
        "Rendement",
        "Valeur production",
        "Responsable",
      ],
      rows: c.production.map((r) => [
        r.lot,
        r.date,
        n(r.kgUtilises),
        n(r.volumeJusL),
        r.q500,
        r.q330,
        r.q300,
        r.totalBouteilles,
        r.rejets,
        n(r.pertesL),
        pctFormat(r.rendement),
        n(r.valeurProduction),
        r.responsable,
      ]),
    });
    blocks.push({
      title: "Synthèse production",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Bouteilles produites", c.bouteillesProduites],
        ["Objectif bouteilles", state.parametres.objectifBouteilles],
        ["Volume jus (L)", n(c.volumeJus)],
        ["Pertes (L)", n(c.pertesL)],
        ["Taux de pertes", pctFormat(c.tauxPertes)],
        ["Rendement moyen", pctFormat(c.rendementMoyen)],
        ["Valeur de production", fcFormat(c.valeurProduction)],
      ],
    });
  }

  if (section === "stock") {
    blocks.push({
      title: "Mouvements matières premières",
      headers: [
        "Date",
        "Produit",
        "Unité",
        "Type",
        "Entrée",
        "Sortie",
        "Coût unitaire",
        "Observation",
      ],
      rows: state.stockMP.map((m) => [
        m.date,
        m.produit,
        m.unite,
        m.type,
        m.entree,
        m.sortie,
        m.coutUnitaire,
        m.observation,
      ]),
    });
    blocks.push({
      title: "Stock produits finis",
      headers: ["Format", "Produites", "Vendues", "Stock", "Valeur stock"],
      rows: c.stockPF.map((s) => [s.format, s.produites, s.vendues, s.stock, fcFormat(s.valeur)]),
    });
    blocks.push({
      title: "Synthèse stock",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Stock MP (pièces)", n(c.stockMPPieces)],
        ["Valeur stock MP", fcFormat(c.stockMPValeur)],
        ["Valeur stock PF", fcFormat(c.stockPF.reduce((a, s) => a + s.valeur, 0))],
      ],
    });
  }

  if (section === "commercialisation") {
    blocks.push({
      title: "Ventes",
      headers: [
        "N°",
        "Date",
        "Client",
        "Canal",
        "Format",
        "Quantité",
        "Prix unitaire",
        "Remise",
        "Montant brut",
        "Encaissé",
        "Solde dû",
        "Statut",
        "Commerciale",
      ],
      rows: c.ventes.map((v) => [
        v.numero,
        v.date,
        v.client,
        v.canal,
        v.format,
        v.quantite,
        v.prixUnitaire,
        v.remise,
        n(v.montantBrut),
        n(v.encaisse),
        n(v.soldeDu),
        v.statutPaiement,
        v.commerciale,
      ]),
    });
    blocks.push({
      title: "Synthèse commerciale",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Bouteilles vendues", c.bouteillesVendues],
        ["Chiffre d'affaires", fcFormat(c.ca)],
        ["Encaissements", fcFormat(c.encaissements)],
        ["Créances clients", fcFormat(c.creances)],
        ["Taux d'encaissement", pctFormat(c.tauxEncaissement)],
        ["Clients actifs", c.clientsActifs],
        ["Prix moyen vendu", fcFormat(c.prixMoyenVendu)],
      ],
    });
  }

  if (section === "parcours") {
    const tauxTransformation = c.kgAchetes ? c.kgTransformes / c.kgAchetes : 0;
    const stockActuel = c.stockPF.reduce((a, s) => a + s.stock, 0);
    const valeurStockFinis = c.stockPF.reduce((a, s) => a + s.valeur, 0);
    const tauxVenteStock = c.bouteillesProduites ? c.bouteillesVendues / c.bouteillesProduites : 0;
    blocks.push({
      title: "Parcours production",
      headers: ["Étape", "Indicateur", "Valeur"],
      rows: [
        ["01 Approvisionnement", "Ananas reçu", `${n(c.kgAchetes)} kg`],
        ["02 Production", "Taux de transformation", pctFormat(tauxTransformation)],
        ["02 Production", "Bouteilles produites", c.bouteillesProduites],
        ["03 Stock", "Stock actuel", `${stockActuel} bt`],
        ["03 Stock", "Valeur stock produits finis", fcFormat(valeurStockFinis)],
        ["04 Commercialisation", "Bouteilles vendues", c.bouteillesVendues],
        ["04 Commercialisation", "Taux vendu sur produit", pctFormat(tauxVenteStock)],
        ["04 Commercialisation", "Chiffre d'affaires", fcFormat(c.ca)],
      ],
    });
  }

  if (section === "marketing") {
    blocks.push({
      title: "Actions marketing",
      headers: [
        "N°",
        "Date",
        "Campagne",
        "Canal",
        "Cible",
        "Description",
        "Budget",
        "Coût réel",
        "Contacts",
        "Prospects",
        "Ventes générées",
      ],
      rows: state.marketing.map((m) => [
        m.numero,
        m.date,
        m.campagne,
        m.canal,
        m.cible,
        m.description,
        m.budget,
        m.coutReel,
        m.contacts,
        m.prospects,
        m.ventesGenerees,
      ]),
    });
    blocks.push({
      title: "Synthèse marketing",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Coût marketing", fcFormat(c.coutMarketing)],
        ["Contacts touchés", c.contactsTouches],
        ["Prospects", c.prospects],
        ["ROI marketing", pctFormat(c.roiMarketing)],
      ],
    });
  }

  if (section === "finances") {
    blocks.push({
      title: "Charges",
      headers: ["Rubrique", "Budget", "Réalisé", "Écart"],
      rows: state.charges.map((ch) => [ch.rubrique, ch.budget, ch.realise, ch.budget - ch.realise]),
    });
    blocks.push({
      title: "Compte d'exploitation",
      headers: ["Indicateur", "Valeur"],
      rows: [
        ["Chiffre d'affaires", fcFormat(c.ca)],
        ["Encaissements", fcFormat(c.encaissements)],
        ["Achats matière", fcFormat(c.coutAchats)],
        ["Transport & frais", fcFormat(c.coutTransport)],
        ["Charges d'exploitation", fcFormat(c.autresCharges)],
        ["Coût marketing", fcFormat(c.coutMarketing)],
        ["Total coûts", fcFormat(c.totalCouts)],
        ["Résultat brut", fcFormat(c.resultatBrut)],
        ["Marge brute", pctFormat(c.margeBrute)],
        ["Coût moyen / bouteille", fcFormat(c.coutMoyenBouteille)],
        ["Marge unitaire", fcFormat(c.margeUnitaire)],
      ],
    });
    blocks.push({
      title: "Primes & commissions",
      headers: ["Bénéficiaire", "Base", "Taux", "Montant"],
      rows: [
        [
          "Directeur de production",
          fcFormat(c.valeurProduction),
          pctFormat(state.parametres.tauxPrimeProduction),
          fcFormat(c.primeProduction),
        ],
        [
          "Chargée de commercialisation",
          fcFormat(c.encaissements),
          pctFormat(state.parametres.tauxCommission),
          fcFormat(c.commissionCommerciale),
        ],
      ],
    });
  }

  blocks.push({
    title: "Objectifs de la campagne",
    headers: ["Objectif", "Cible", "Réalisé", "Taux", "Responsable", "Statut"],
    rows: c.objectifs.map((o) => [
      o.label,
      o.unite === "%" ? pctFormat(o.objectif) : o.objectif,
      o.unite === "%" ? pctFormat(o.realise) : n(o.realise),
      pctFormat(o.taux),
      o.responsable,
      o.statut,
    ]),
  });

  return { section, titre: meta.titre, responsable: meta.responsable, blocks };
}

export function buildFilteredReport(
  section: ExportSection,
  state: ErpState,
  f: ExportFilter,
): Report {
  const filtered = filterErpState(state, f);
  return buildReport(section, filtered, computeErp(filtered));
}

/* ---------- Rendu ---------- */

const periodeLabel = (f: ExportFilter) =>
  f.from || f.to
    ? `${f.from ? `du ${f.from}` : "jusqu'au"} ${f.to ? `au ${f.to}` : ""}`.trim()
    : "Toute la période";

const campagneLabel = (f: ExportFilter) => f.campagne || "Toutes les campagnes";

const fileBase = (r: Report, f: ExportFilter) =>
  `AROM_${r.titre.replace(/[^a-zA-Z0-9]+/g, "_")}_${(f.campagne || "toutes").replace(/[^a-zA-Z0-9]+/g, "_")}_${f.from || "debut"}_${f.to || "fin"}`;

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const csvCell = (v: string | number) => {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportExcel(report: Report, f: ExportFilter) {
  const lines: string[] = [
    `AROM - ${report.titre}`,
    `Campagne;${campagneLabel(f)}`,
    `Période;${periodeLabel(f)}`,
    `Responsable;${report.responsable}`,
    `Édité le;${new Date().toLocaleString("fr-FR")}`,
    "",
  ];
  for (const b of report.blocks) {
    lines.push(b.title);
    lines.push(b.headers.map(csvCell).join(";"));
    if (b.rows.length === 0) lines.push("Aucune donnée sur la période");
    for (const r of b.rows) lines.push(r.map(csvCell).join(";"));
    lines.push("");
  }
  download("\uFEFF" + lines.join("\r\n"), `${fileBase(report, f)}.csv`, "text/csv;charset=utf-8");
}

const esc = (v: string | number) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function exportPdf(report: Report, f: ExportFilter, logoUrl?: string) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${esc(fileBase(report, f))}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #17301f; margin: 0; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #d8a83a; padding-bottom: 12px; }
  header img { width: 54px; height: 54px; border-radius: 50%; object-fit: cover; }
  h1 { font-size: 20px; margin: 0; color: #124a2a; }
  .sub { font-size: 11px; color: #5d6b60; margin-top: 2px; }
  .meta { margin: 14px 0 18px; display: flex; flex-wrap: wrap; gap: 18px; font-size: 11px; }
  .meta div span { display: block; text-transform: uppercase; letter-spacing: .12em; font-size: 8px; color: #8a9990; }
  .meta div b { color: #124a2a; font-size: 12px; }
  h2 { font-size: 13px; color: #124a2a; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #124a2a; color: #fff; text-align: left; padding: 5px 6px; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
  td { border-bottom: 1px solid #e3e8e4; padding: 5px 6px; }
  tr:nth-child(even) td { background: #f7faf7; }
  .empty { font-size: 10px; color: #8a9990; padding: 6px 0; }
  footer { margin-top: 22px; border-top: 1px solid #e3e8e4; padding-top: 8px; font-size: 9px; color: #8a9990; }
  table, tr, h2 { page-break-inside: avoid; }
</style></head><body>
<header>${logoUrl ? `<img src="${esc(logoUrl)}" alt="AROM">` : ""}
  <div><h1>AROM - ${esc(report.titre)}</h1>
  <div class="sub">Saveurs naturelles · Rapport ERP</div></div>
</header>
<div class="meta">
  <div><span>Campagne</span><b>${esc(campagneLabel(f))}</b></div>
  <div><span>Période</span><b>${esc(periodeLabel(f))}</b></div>
  <div><span>Responsable</span><b>${esc(report.responsable)}</b></div>
  <div><span>Édité le</span><b>${esc(new Date().toLocaleString("fr-FR"))}</b></div>
</div>
${report.blocks
  .map(
    (b) =>
      `<h2>${esc(b.title)}</h2>` +
      (b.rows.length === 0
        ? `<p class="empty">Aucune donnée sur la période sélectionnée.</p>`
        : `<table><thead><tr>${b.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`),
  )
  .join("")}
<footer>Document généré automatiquement par l'ERP AROM, usage interne.</footer>
<script>window.onload = function () { setTimeout(function(){ window.print(); }, 250); };</script>
</body></html>`;

  const w = window.open("", "_blank", "width=1100,height=800");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
