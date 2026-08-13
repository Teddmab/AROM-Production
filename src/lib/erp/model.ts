/**
 * Modèle de données ERP AROM — transposition fidèle du classeur
 * « AROM_ERP_Professionnel.xlsm » (feuilles Parametres, Producteurs,
 * Approvisionnement, Production, Stock_MP, Stock_PF, Clients, Ventes,
 * Marketing, Finances, Commissions, Dashboard).
 */

export type Format = "500 ml" | "330 ml" | "300 ml";
export type Qualite = "Conforme" | "Rejeté" | "À vérifier";
export type StatutPaiement = "Payé" | "Partiel" | "À crédit";
export type Canal =
  | "Hôtel"
  | "Restaurant"
  | "Boutique"
  | "Supermarché"
  | "Particulier"
  | "Grossiste";
export type TypeMouvement = "Entrée" | "Sortie" | "Ajustement";

export interface Parametres {
  objectifAnanasKg: number;
  objectifBouteilles: number;
  prix500: number;
  prix330: number;
  prix300: number;
  tauxCommission: number; // % du CA encaissé
  tauxPrimeProduction: number; // % valeur production conforme
  tauxPertesMax: number;
  distanceFournisseurKm: number;
  debutProduction: string;
  finProduction: string;
  finCommercialisation: string;
  objectifClients: number;
  objectifMargeBrute: number;
}

export interface Producteur {
  id: string;
  nom: string;
  village: string;
  secteur: string;
  territoire: string;
  telephone: string;
  produit: string;
  capaciteKgMois: number;
  prixConvenu: number;
  statut: string;
  observations: string;
}

export interface Approvisionnement {
  id: string;
  numero: string;
  date: string;
  idProducteur: string;
  fournisseur: string;
  village: string;
  produit: string;
  qteCommandeeKg: number;
  qteRecueKg: number;
  prixKg: number;
  transport: number;
  autresFrais: number;
  qualite: Qualite;
}

export interface Production {
  id: string;
  lot: string;
  date: string;
  kgUtilises: number;
  volumeJusL: number;
  q500: number;
  q330: number;
  q300: number;
  rejets: number;
  responsable: string;
  statut: string;
}

export interface MouvementStockMP {
  id: string;
  date: string;
  produit: string;
  unite: string;
  type: TypeMouvement;
  entree: number;
  sortie: number;
  coutUnitaire: number;
  observation: string;
}

export interface Client {
  id: string;
  nom: string;
  categorie: Canal;
  contact: string;
  zone: string;
  premierContact: string;
  statut: string;
}

export interface Vente {
  id: string;
  numero: string;
  date: string;
  idClient: string;
  client: string;
  canal: Canal;
  format: Format;
  quantite: number;
  prixUnitaire: number;
  remise: number;
  encaisse: number;
  commerciale: string;
}

export interface ActionMarketing {
  id: string;
  numero: string;
  date: string;
  campagne: string;
  canal: string;
  cible: string;
  description: string;
  budget: number;
  coutReel: number;
  contacts: number;
  prospects: number;
  ventesGenerees: number;
}

export interface ChargeFixe {
  id: string;
  rubrique: string;
  budget: number;
  realise: number;
}

export interface ErpState {
  parametres: Parametres;
  producteurs: Producteur[];
  approvisionnements: Approvisionnement[];
  productions: Production[];
  stockMP: MouvementStockMP[];
  clients: Client[];
  ventes: Vente[];
  marketing: ActionMarketing[];
  charges: ChargeFixe[];
}

/* ---------- Données réelles issues du classeur (campagne pilote 2026) ---------- */

export const SEED: ErpState = {
  parametres: {
    objectifAnanasKg: 300,
    objectifBouteilles: 300,
    prix500: 5000,
    prix330: 3500,
    prix300: 3000,
    tauxCommission: 0.1,
    tauxPrimeProduction: 0.18,
    tauxPertesMax: 0.05,
    distanceFournisseurKm: 13,
    debutProduction: "2026-07-12",
    finProduction: "2026-07-18",
    finCommercialisation: "2026-08-12",
    objectifClients: 25,
    objectifMargeBrute: 0.3,
  },
  producteurs: [
    {
      id: "PRD-001",
      nom: "Sian Luna Nkashama",
      village: "Tshipinjinga",
      secteur: "Dibataie",
      territoire: "Dibaya",
      telephone: "0850092707",
      produit: "Ananas",
      capaciteKgMois: 2400,
      prixConvenu: 800,
      statut: "Actif",
      observations: "Fournisseur principal – 13 km",
    },
  ],
  approvisionnements: [
    {
      id: "APP-1",
      numero: "001_2026",
      date: "2026-07-07",
      idProducteur: "PRD-001",
      fournisseur: "Bombeshayi Mike",
      village: "Tshimpidinga",
      produit: "Ananas",
      qteCommandeeKg: 300,
      qteRecueKg: 470,
      prixKg: 742,
      transport: 35000,
      autresFrais: 12800,
      qualite: "Conforme",
    },
  ],
  productions: [
    {
      id: "PRO-1",
      lot: "001_AROM",
      date: "2026-07-10",
      kgUtilises: 133.9,
      volumeJusL: 60,
      q500: 120,
      q330: 0,
      q300: 0,
      rejets: 0,
      responsable: "Directeur de production",
      statut: "Terminé",
    },
    {
      id: "PRO-2",
      lot: "001_AROM",
      date: "2026-07-11",
      kgUtilises: 171.2,
      volumeJusL: 73.5,
      q500: 147,
      q330: 0,
      q300: 0,
      rejets: 0,
      responsable: "Directeur de production",
      statut: "Terminé",
    },
    {
      id: "PRO-3",
      lot: "001_AROM",
      date: "2026-07-12",
      kgUtilises: 165.3,
      volumeJusL: 82.65,
      q500: 103,
      q330: 0,
      q300: 0,
      rejets: 0,
      responsable: "Directeur de production",
      statut: "Terminé",
    },
  ],
  stockMP: [
    {
      id: "MP-1",
      date: "2026-07-07",
      produit: "Ananas",
      unite: "Pièce",
      type: "Entrée",
      entree: 334,
      sortie: 0,
      coutUnitaire: 1044,
      observation: "Stock 1 chez Musube",
    },
    {
      id: "MP-2",
      date: "2026-07-10",
      produit: "Ananas",
      unite: "Pièce",
      type: "Sortie",
      entree: 0,
      sortie: 103,
      coutUnitaire: 1044,
      observation: "Transformation chez AROM",
    },
    {
      id: "MP-3",
      date: "2026-07-11",
      produit: "Ananas",
      unite: "Pièce",
      type: "Sortie",
      entree: 0,
      sortie: 107,
      coutUnitaire: 1044,
      observation: "Transformation chez AROM",
    },
    {
      id: "MP-4",
      date: "2026-07-12",
      produit: "Ananas",
      unite: "Pièce",
      type: "Sortie",
      entree: 0,
      sortie: 114,
      coutUnitaire: 1044,
      observation: "Transformation chez AROM",
    },
    {
      id: "MP-5",
      date: "2026-07-18",
      produit: "Ananas",
      unite: "Pièce",
      type: "Sortie",
      entree: 0,
      sortie: 6,
      coutUnitaire: 1044,
      observation: "Consommation Hôtel Chez Musube",
    },
  ],
  clients: [],
  ventes: [],
  marketing: [],
  charges: [
    { id: "CH-1", rubrique: "Emballages et consommables", budget: 555000, realise: 555000 },
    { id: "CH-2", rubrique: "Énergie et eau", budget: 66000, realise: 66000 },
    { id: "CH-3", rubrique: "Main-d'œuvre directe", budget: 118000, realise: 118000 },
    { id: "CH-4", rubrique: "Autres charges", budget: 0, realise: 0 },
  ],
};

export const FORMATS: Format[] = ["500 ml", "330 ml", "300 ml"];
export const CANAUX: Canal[] = [
  "Hôtel",
  "Restaurant",
  "Boutique",
  "Supermarché",
  "Grossiste",
  "Particulier",
];
export const QUALITES: Qualite[] = ["Conforme", "Rejeté", "À vérifier"];
export const STATUTS_PAIEMENT: StatutPaiement[] = ["Payé", "Partiel", "À crédit"];

export function prixFormat(p: Parametres, f: Format): number {
  return f === "500 ml" ? p.prix500 : f === "330 ml" ? p.prix330 : p.prix300;
}

export const fcFormat = (n: number) =>
  `${Math.round(n)
    .toLocaleString("fr-FR")
    .replace(/\u202f|\u00a0/g, " ")} FC`;

export const pctFormat = (n: number) => `${(n * 100).toFixed(1)} %`;
