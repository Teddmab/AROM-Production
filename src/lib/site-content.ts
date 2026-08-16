/**
 * Public landing page content (sprint 28) — `config/siteContent`, the one
 * Firestore doc unauthenticated visitors can read. `heroStats` is a mirror
 * of the 3 related fields on `config/parametres` (kept in sync from
 * Paramètres ERP's "Objectifs & tarifs" card whenever an admin edits them)
 * rather than the landing page reading the internal doc directly — keeps
 * `config/parametres`'s broader business data (prices, commission rates,
 * campaign dates) out of a document anyone on the internet can fetch.
 */
export interface SiteVideo {
  id: string;
  title: string;
  /** Category chip shown next to the title, e.g. "Production", "Marketing". */
  tag: string;
  /** Free-text display duration (e.g. "1:42") — not derived from the file, admin-typed. */
  duration?: string;
  videoUrl: string;
}

export interface SiteContent {
  /** "Notre histoire en images" — first entry is the large featured player, the rest are the playlist. */
  videos: SiteVideo[];
  heroStats: {
    ananasKg: number;
    bouteilles: number;
    clients: number;
  };
}
