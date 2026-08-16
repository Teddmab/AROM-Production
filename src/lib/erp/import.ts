/**
 * CSV/Excel bulk import (sprint 27) — column layouts match the real
 * "AROM_ERP_Professionnel.xlsm" workbook this whole ERP is a transposition
 * of (see model.ts's own header comment), so a sheet copied straight out of
 * that file (or a CSV export of one) can be dropped in as-is. Only the
 * fields the app actually stores are mapped — computed columns in the
 * workbook (Valeur achat, Coût total, Rendement, ROI, etc.) are skipped;
 * `engine.ts` recomputes those from the stored fields, same as manual entry.
 */
import { CANAUX, FORMATS, QUALITES } from "./model";

export type ImportTargetKey =
  | "producteurs"
  | "approvisionnements"
  | "productions"
  | "stockMP"
  | "clients"
  | "ventes"
  | "marketing";

interface ImportFieldDef {
  /** Column header exactly as it appears in the real workbook — matched case/accent-insensitively. */
  header: string;
  key: string;
  type: "text" | "number" | "date" | "select";
  options?: readonly string[];
}

interface ImportTarget {
  label: string;
  idPrefix: string;
  /** One or more field keys whose combined value identifies "the same row" for duplicate detection. */
  dupKeys: string[];
  fields: ImportFieldDef[];
}

export const IMPORT_TARGETS: Record<ImportTargetKey, ImportTarget> = {
  producteurs: {
    label: "Producteurs",
    idPrefix: "PRD",
    dupKeys: ["id"],
    fields: [
      { header: "ID Producteur", key: "id", type: "text" },
      { header: "Nom / Association", key: "nom", type: "text" },
      { header: "Village", key: "village", type: "text" },
      { header: "Secteur", key: "secteur", type: "text" },
      { header: "Territoire", key: "territoire", type: "text" },
      { header: "Téléphone", key: "telephone", type: "text" },
      { header: "Produit", key: "produit", type: "text" },
      { header: "Capacité estimée kg/mois", key: "capaciteKgMois", type: "number" },
      { header: "Prix convenu FC/kg", key: "prixConvenu", type: "number" },
      { header: "Statut", key: "statut", type: "text" },
      { header: "Observations", key: "observations", type: "text" },
    ],
  },
  approvisionnements: {
    label: "Approvisionnement",
    idPrefix: "APP",
    dupKeys: ["numero"],
    fields: [
      { header: "N° Réception", key: "numero", type: "text" },
      { header: "Date", key: "date", type: "date" },
      { header: "ID Producteur", key: "idProducteur", type: "text" },
      { header: "Fournisseur", key: "fournisseur", type: "text" },
      { header: "Village", key: "village", type: "text" },
      { header: "Produit", key: "produit", type: "text" },
      { header: "Qté commandée kg", key: "qteCommandeeKg", type: "number" },
      { header: "Qté reçue kg", key: "qteRecueKg", type: "number" },
      { header: "Prix FC/kg", key: "prixKg", type: "number" },
      { header: "Transport FC", key: "transport", type: "number" },
      { header: "Autres frais FC", key: "autresFrais", type: "number" },
      { header: "Qualité", key: "qualite", type: "select", options: QUALITES },
    ],
  },
  productions: {
    label: "Production",
    idPrefix: "PRO",
    // Lot numbers repeat across several rows (one lot = several production
    // days) — date is needed alongside it to identify one real row.
    dupKeys: ["lot", "date"],
    fields: [
      { header: "N° Lot", key: "lot", type: "text" },
      { header: "Date", key: "date", type: "date" },
      { header: "Kg ananas utilisés", key: "kgUtilises", type: "number" },
      { header: "Volume jus obtenu L", key: "volumeJusL", type: "number" },
      { header: "500 ml produits", key: "q500", type: "number" },
      { header: "330 ml produits", key: "q330", type: "number" },
      { header: "300 ml produits", key: "q300", type: "number" },
      { header: "Rejets", key: "rejets", type: "number" },
      { header: "Responsable", key: "responsable", type: "text" },
      { header: "Statut lot", key: "statut", type: "text" },
    ],
  },
  stockMP: {
    label: "Stock matières premières",
    idPrefix: "MP",
    dupKeys: ["date", "produit", "type"],
    fields: [
      { header: "Date", key: "date", type: "date" },
      { header: "Produit", key: "produit", type: "text" },
      { header: "Unité", key: "unite", type: "text" },
      {
        header: "Type mouvement",
        key: "type",
        type: "select",
        options: ["Entrée", "Sortie", "Ajustement"],
      },
      { header: "Quantité entrée", key: "entree", type: "number" },
      { header: "Quantité sortie", key: "sortie", type: "number" },
      { header: "Coût unitaire FC", key: "coutUnitaire", type: "number" },
      { header: "Observation", key: "observation", type: "text" },
    ],
  },
  clients: {
    label: "Clients",
    idPrefix: "CLI",
    dupKeys: ["id"],
    fields: [
      { header: "ID Client", key: "id", type: "text" },
      { header: "Nom client", key: "nom", type: "text" },
      { header: "Catégorie", key: "categorie", type: "select", options: CANAUX },
      { header: "Contact", key: "contact", type: "text" },
      { header: "Commune / Zone", key: "zone", type: "text" },
      { header: "Date premier contact", key: "premierContact", type: "date" },
      { header: "Statut", key: "statut", type: "text" },
    ],
  },
  ventes: {
    label: "Ventes",
    idPrefix: "VTE",
    dupKeys: ["numero"],
    fields: [
      { header: "N° Vente", key: "numero", type: "text" },
      { header: "Date", key: "date", type: "date" },
      { header: "ID Client", key: "idClient", type: "text" },
      { header: "Client", key: "client", type: "text" },
      { header: "Canal", key: "canal", type: "select", options: CANAUX },
      { header: "Format", key: "format", type: "select", options: FORMATS },
      { header: "Quantité", key: "quantite", type: "number" },
      { header: "Prix unitaire FC", key: "prixUnitaire", type: "number" },
      { header: "Remise FC", key: "remise", type: "number" },
      { header: "Montant encaissé FC", key: "encaisse", type: "number" },
      { header: "Commerciale", key: "commerciale", type: "text" },
    ],
  },
  marketing: {
    label: "Marketing",
    idPrefix: "MKT",
    dupKeys: ["numero"],
    fields: [
      { header: "ID Action", key: "numero", type: "text" },
      { header: "Date", key: "date", type: "date" },
      { header: "Campagne", key: "campagne", type: "text" },
      { header: "Canal", key: "canal", type: "text" },
      { header: "Cible", key: "cible", type: "text" },
      { header: "Description", key: "description", type: "text" },
      { header: "Budget FC", key: "budget", type: "number" },
      { header: "Coût réel FC", key: "coutReel", type: "number" },
      { header: "Contacts touchés", key: "contacts", type: "number" },
      { header: "Prospects générés", key: "prospects", type: "number" },
      { header: "Ventes générées FC", key: "ventesGenerees", type: "number" },
    ],
  },
};

const normalize = (s: string) =>
  s
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[°º]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Reads a .csv/.xlsx/.xlsm file into a raw grid of strings — one array per row. */
async function readGrid(file: File): Promise<string[][]> {
  // Loaded on demand — xlsx is a ~140kB (gzipped) library, no reason to ship
  // it in the main dashboard bundle for the vast majority of visits that
  // never touch an import button.
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  const wb = isCsv
    ? XLSX.read(new TextDecoder("utf-8").decode(buf), {
        type: "string",
        raw: false,
        cellDates: true,
      })
    : XLSX.read(buf, { type: "array", raw: false, cellDates: true, dateNF: "yyyy-mm-dd" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });
}

/**
 * The source workbook has two title rows and a blank row before the real
 * header (see Approvisionnement etc. — header lands on row 4) — a plain CSV
 * export usually has it on row 1. Scores each of the first 10 rows by how
 * many cells match one of this target's expected headers and picks the best.
 */
function findHeaderRow(grid: string[][], target: ImportTarget): number {
  const expected = target.fields.map((f) => normalize(f.header));
  let bestRow = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = grid[i].map(normalize);
    const score = cells.filter((c) => c && expected.includes(c)).length;
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

// Excel serial-date epoch (1899-12-30) — used only if a date cell still
// comes through as a raw number (raw:false/cellDates should normally
// prevent this, kept as a fallback for stricter source files).
function excelSerialToIso(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (/^\d+(\.\d+)?$/.test(v)) return excelSerialToIso(Number(v));
  return v;
}

// Strips thousands separators — comma, plain space, and the narrow/
// non-breaking space variants Excel uses for FC amounts like "348 740" —
// before parsing.
const THOUSANDS_SEPARATORS = /[,\s\u202f\u00a0]/g;
function parseNumber(raw: string): number {
  const cleaned = raw.replace(THOUSANDS_SEPARATORS, "").replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** One row of the "Journal des imports" (Paramètres ERP) — written once per confirmed import. */
export interface ImportLog {
  id: string;
  collection: ImportTargetKey;
  collectionLabel: string;
  fileName: string;
  totalRows: number;
  added: number;
  skipped: number;
  duplicatesFound: number;
  importedBy: string;
  importedByName: string;
  importedAt: string;
}

export interface ImportRow {
  /** Raw, human-readable values keyed by model field — for the preview table. */
  values: Record<string, string>;
  /** Fully typed record ready to write, minus `id`. */
  record: Record<string, string | number>;
  dupKeyValue: string;
}

export interface ParsedImport {
  targetKey: ImportTargetKey;
  headerRow: number;
  matchedFields: string[];
  unmatchedHeaders: string[];
  rows: ImportRow[];
}

export async function parseImportFile(
  file: File,
  targetKey: ImportTargetKey,
): Promise<ParsedImport> {
  const target = IMPORT_TARGETS[targetKey];
  const grid = await readGrid(file);
  const headerRowIdx = findHeaderRow(grid, target);
  const headerCells = grid[headerRowIdx] ?? [];
  const normalizedHeaders = headerCells.map(normalize);

  const columnForField = new Map<string, number>();
  target.fields.forEach((f) => {
    const idx = normalizedHeaders.indexOf(normalize(f.header));
    if (idx !== -1) columnForField.set(f.key, idx);
  });

  const dataRows = grid
    .slice(headerRowIdx + 1)
    .filter((r) => r.some((cell) => String(cell).trim() !== ""));

  const rows: ImportRow[] = dataRows.map((r) => {
    const values: Record<string, string> = {};
    const record: Record<string, string | number> = {};
    target.fields.forEach((f) => {
      const colIdx = columnForField.get(f.key);
      const raw = colIdx !== undefined ? String(r[colIdx] ?? "").trim() : "";
      values[f.key] = raw;
      record[f.key] =
        f.type === "number" ? parseNumber(raw) : f.type === "date" ? parseDate(raw) : raw;
    });
    const dupKeyValue = target.dupKeys.map((k) => String(record[k] ?? "")).join("|");
    return { values, record, dupKeyValue };
  });

  const matchedFields = target.fields.filter((f) => columnForField.has(f.key)).map((f) => f.header);
  const unmatchedHeaders = headerCells.filter(
    (h) => h.trim() && !target.fields.some((f) => normalize(f.header) === normalize(h)),
  );

  return { targetKey, headerRow: headerRowIdx, matchedFields, unmatchedHeaders, rows };
}
