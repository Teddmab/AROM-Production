import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { toast } from "sonner";
import { ErpProvider, useErp, newId } from "@/lib/erp/store";
import { db, storage } from "@/lib/firebase/config";
import {
  CANAUX,
  FORMATS,
  QUALITES,
  fcFormat,
  pctFormat,
  prixFormat,
  type Canal,
  type Format,
  type Qualite,
} from "@/lib/erp/model";
import { ExportBar } from "@/components/erp/ExportBar";
import { RequireRole } from "@/lib/firebase/require-role";
import { useAuth, canAccessMenu } from "@/lib/firebase/auth";

export const Route = createFileRoute("/dashboard")({
  component: DashboardRoute,
  head: () => ({
    meta: [
      { title: "AROM - ERP & tableau de bord opérationnel" },
      {
        name: "description",
        content:
          "ERP AROM connecté : approvisionnement, production, stocks, ventes, marketing, finances et primes, campagne N°001/2026.",
      },
      { property: "og:title", content: "AROM - ERP & tableau de bord opérationnel" },
      {
        property: "og:description",
        content:
          "Pilotage intégré de l'unité de production de jus AROM : objectifs, réalisés et indicateurs calculés en temps réel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

type SectionId =
  | "executif"
  | "appro"
  | "production"
  | "stock"
  | "commercialisation"
  | "marketing"
  | "finances"
  | "personnel"
  | "kpi"
  | "parametres"
  | "roadmap";

const SECTIONS: { id: SectionId; label: string; num: string }[] = [
  { id: "executif", label: "Exécutif", num: "00" },
  { id: "appro", label: "Approvisionnement", num: "01" },
  { id: "production", label: "Production", num: "02" },
  { id: "stock", label: "Stock", num: "03" },
  { id: "commercialisation", label: "Commercialisation", num: "04" },
  { id: "marketing", label: "Marketing", num: "05" },
  { id: "finances", label: "Finances", num: "06" },
  { id: "personnel", label: "Primes & personnel", num: "07" },
  { id: "kpi", label: "KPI stratégiques", num: "08" },
  { id: "parametres", label: "Paramètres ERP", num: "09" },
  { id: "roadmap", label: "Feuille de route", num: "10" },
];

function DashboardRoute() {
  return (
    <RequireRole roles={["admin", "staff"]}>
      <ErpProvider>
        <Dashboard />
      </ErpProvider>
    </RequireRole>
  );
}

function Dashboard() {
  const { profile, signOutUser } = useAuth();
  const visibleSections = SECTIONS.filter((s) => canAccessMenu(profile, s.id));
  const [active, setActive] = useState<SectionId>(visibleSections[0]?.id ?? "executif");
  const { computed } = useErp();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-4">
          <Link to="/" className="flex items-center gap-3">
            <img
              src="/logo-nav.png"
              alt="AROM"
              className="h-11 w-11 rounded-full object-cover ring-2 ring-gold/40"
            />
            <div className="leading-tight">
              <p className="font-display text-lg font-bold text-primary">AROM</p>
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-gold">
                ERP · Tableau de bord
              </p>
            </div>
          </Link>

          <div className="hidden flex-1 items-center gap-6 md:flex">
            <Divider />
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Campagne
              </p>
              <p className="text-sm font-semibold text-primary">N°001 / 2026</p>
            </div>
            <Divider />
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                CA encaissé
              </p>
              <p className="text-sm font-semibold text-primary">
                {fcFormat(computed.encaissements)}
              </p>
            </div>
            <Divider />
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Marge brute
              </p>
              <p className="text-sm font-semibold text-primary">{pctFormat(computed.margeBrute)}</p>
            </div>
          </div>

          <span className="badge-status bg-success/15 text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> ERP connecté
          </span>

          <div className="hidden items-center gap-3 sm:flex">
            <div className="text-right leading-tight">
              <p className="text-xs font-semibold text-primary">
                {profile?.displayName || profile?.email}
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {profile?.role}
              </p>
            </div>
            <button
              onClick={() => signOutUser()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:text-primary"
            >
              Déconnexion
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] flex-col gap-8 px-6 py-8 lg:flex-row">
        <aside className="sticky top-24 hidden h-fit w-56 shrink-0 flex-col gap-1 lg:flex">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                active === s.id
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/15"
                  : "text-foreground/70 hover:bg-primary/5 hover:text-primary"
              }`}
            >
              <span
                className={`grid h-7 w-7 place-items-center rounded-lg font-display text-[11px] font-bold ${
                  active === s.id ? "bg-gold text-primary" : "bg-primary/5 text-primary"
                }`}
              >
                {s.num}
              </span>
              <span className="font-medium">{s.label}</span>
            </button>
          ))}
        </aside>

        <div className="lg:hidden">
          <select
            value={active}
            onChange={(e) => setActive(e.target.value as SectionId)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-primary"
          >
            {visibleSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.num} · {s.label}
              </option>
            ))}
          </select>
        </div>

        <main className="min-w-0 flex-1">
          {active === "executif" && <ExecutiveSection />}
          {active === "appro" && <ApproSection />}
          {active === "production" && <ProductionSection />}
          {active === "stock" && <StockSection />}
          {active === "commercialisation" && <CommercialisationSection />}
          {active === "marketing" && <MarketingSection />}
          {active === "finances" && <FinancesSection />}
          {active === "personnel" && <PersonnelSection />}
          {active === "kpi" && <KpiSection />}
          {active === "parametres" && <ParametresSection />}
          {active === "roadmap" && <RoadmapSection />}
        </main>
      </div>
    </div>
  );
}

/* ---------- Primitives ---------- */

function Divider() {
  return <span className="h-8 w-px bg-border" />;
}

function SectionHeader({
  eyebrow,
  title,
  subtitle,
  responsable,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  responsable?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-gold">{eyebrow}</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-primary md:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {responsable && (
        <div className="rounded-full border border-border bg-card px-4 py-2 text-xs">
          <span className="text-muted-foreground">Responsable · </span>
          <span className="font-semibold text-primary">{responsable}</span>
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-5 shadow-sm ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h3 className="font-display text-lg font-semibold text-primary">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function KpiTile({
  label,
  objectif,
  realise,
  unit,
  taux,
}: {
  label: string;
  objectif?: string | number;
  realise?: string | number;
  unit?: string;
  taux?: number;
}) {
  const pct = typeof taux === "number" ? Math.max(0, Math.min(100, Math.round(taux * 100))) : null;
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="font-display text-2xl font-bold text-primary md:text-3xl">
          {realise ?? "-"}
          {unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}
        </p>
        {objectif !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            Obj.{" "}
            <span className="font-semibold text-foreground">
              {objectif}
              {unit ? ` ${unit}` : ""}
            </span>
          </p>
        )}
      </div>
      {pct !== null && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-leaf"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-right text-[10px] font-semibold text-muted-foreground">{pct}%</p>
        </div>
      )}
    </div>
  );
}

function Table({
  headers,
  rows,
  empty = "Aucune saisie enregistrée",
}: {
  headers: string[];
  rows: (string | number | ReactNode)[][];
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-primary/5 text-left text-[11px] uppercase tracking-wider text-primary">
          <tr>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} className="px-3 py-6 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i} className="hover:bg-primary/5">
                {r.map((c, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-2.5 align-middle">
                    {c === "" || c === null || c === undefined ? (
                      <span className="text-muted-foreground/50">-</span>
                    ) : (
                      c
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Status({
  statut,
}: {
  statut: "Atteint" | "À surveiller" | "Critique" | "Conforme" | "Excès";
}) {
  const tone =
    statut === "Atteint" || statut === "Conforme"
      ? "bg-success/15 text-success"
      : statut === "À surveiller"
        ? "bg-warning/20 text-warning"
        : "bg-destructive/15 text-destructive";
  return <span className={`badge-status ${tone}`}>{statut}</span>;
}

type FieldDef = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "select";
  options?: readonly string[];
  default?: string | number;
};

function EntryForm({
  fields,
  submitLabel,
  onSubmit,
}: {
  fields: FieldDef[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const initial = () => Object.fromEntries(fields.map((f) => [f.name, String(f.default ?? "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
      >
        + {submitLabel}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
        setValues(initial());
        setOpen(false);
      }}
      className="w-full rounded-xl border border-border bg-primary/5 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map((f) => (
          <label key={f.name} className="text-xs font-medium text-muted-foreground">
            {f.label}
            {f.type === "select" ? (
              <select
                value={values[f.name]}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
              >
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type ?? "text"}
                step="any"
                value={values[f.name]}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
        >
          Enregistrer
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}

const n = (v: string | undefined) => Number(v ?? 0) || 0;

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-xs font-semibold text-destructive hover:underline"
      aria-label="Supprimer la ligne"
    >
      Suppr.
    </button>
  );
}

/* ---------- Sections ---------- */

function ExecutiveSection() {
  const { computed, state } = useErp();
  const p = state.parametres;
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Tableau de bord exécutif"
        title="Vue générale de la campagne"
        subtitle="Direction Générale, données consolidées depuis l'ERP"
      />
      <ExportBar section="executif" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Ananas achetés"
          objectif={p.objectifAnanasKg}
          realise={Math.round(computed.kgAchetes)}
          unit="kg"
          taux={computed.kgAchetes / p.objectifAnanasKg}
        />
        <KpiTile
          label="Ananas transformés"
          objectif={p.objectifAnanasKg}
          realise={Math.round(computed.kgTransformes)}
          unit="kg"
          taux={computed.kgTransformes / p.objectifAnanasKg}
        />
        <KpiTile
          label="Bouteilles produites"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesProduites}
          taux={computed.bouteillesProduites / p.objectifBouteilles}
        />
        <KpiTile
          label="Bouteilles vendues"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesVendues}
          taux={computed.bouteillesVendues / p.objectifBouteilles}
        />
        <KpiTile label="Chiffre d'affaires" realise={fcFormat(computed.ca)} />
        <KpiTile label="Résultat brut" realise={fcFormat(computed.resultatBrut)} />
        <KpiTile
          label="Clients actifs"
          objectif={p.objectifClients}
          realise={computed.clientsActifs}
          taux={computed.clientsActifs / p.objectifClients}
        />
        <KpiTile
          label="Marge brute"
          objectif={pctFormat(p.objectifMargeBrute)}
          realise={pctFormat(computed.margeBrute)}
          taux={computed.margeBrute / p.objectifMargeBrute}
        />
      </div>

      <Card title="Synthèse par domaine (objectifs ERP)">
        <Table
          headers={["Indicateur", "Objectif", "Réalisé", "Taux", "Responsable", "Statut"]}
          rows={computed.objectifs.map((o) => [
            o.label,
            o.unite === "%"
              ? pctFormat(o.objectif)
              : `${o.objectif} ${o.unite === "kg" ? "kg" : o.unite === "bt" ? "" : ""}`.trim(),
            o.unite === "%" ? pctFormat(o.realise) : Math.round(o.realise * 100) / 100,
            pctFormat(o.taux),
            o.responsable,
            <Status statut={o.statut} />,
          ])}
        />
      </Card>

      <Card title="Synthèse financière (hors amortissement)">
        <Table
          headers={["Indicateur", "Valeur", "Lecture"]}
          rows={[
            ["Chiffre d'affaires", fcFormat(computed.ca), "Brut"],
            ["Encaissements", fcFormat(computed.encaissements), "Trésorerie reçue"],
            ["Créances clients", fcFormat(computed.creances), "À recouvrer"],
            ["Total coûts", fcFormat(computed.totalCouts), "Exploitation"],
            ["Résultat brut", fcFormat(computed.resultatBrut), "Avant impôt et amortissement"],
            ["Marge brute", pctFormat(computed.margeBrute), "Résultat / CA"],
            ["Rendement sur coûts", pctFormat(computed.rendementSurCouts), "Résultat / coûts"],
          ]}
        />
      </Card>
    </div>
  );
}

function ApproSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const p = state.parametres;
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 01"
        title="Approvisionnement"
        responsable="Directeur de Production"
      />
      <ExportBar section="appro" />

      <Card
        title="Réceptions fournisseurs"
        action={
          <EntryForm
            submitLabel="Nouvelle réception"
            fields={[
              { name: "numero", label: "N° réception", default: "002_2026" },
              { name: "date", label: "Date", type: "date", default: "2026-07-20" },
              { name: "idProducteur", label: "ID producteur", default: "PRD-001" },
              { name: "fournisseur", label: "Fournisseur" },
              { name: "village", label: "Village" },
              { name: "qteCommandeeKg", label: "Qté commandée (kg)", type: "number", default: 0 },
              { name: "qteRecueKg", label: "Qté reçue (kg)", type: "number", default: 0 },
              { name: "prixKg", label: "Prix FC/kg", type: "number", default: p.prix300 ? 742 : 0 },
              { name: "transport", label: "Transport FC", type: "number", default: 0 },
              { name: "autresFrais", label: "Autres frais FC", type: "number", default: 0 },
              {
                name: "qualite",
                label: "Qualité",
                type: "select",
                options: QUALITES,
                default: "Conforme",
              },
            ]}
            onSubmit={(v) =>
              addRow("approvisionnements", {
                id: newId("APP"),
                numero: v.numero,
                date: v.date,
                idProducteur: v.idProducteur,
                fournisseur: v.fournisseur,
                village: v.village,
                produit: "Ananas",
                qteCommandeeKg: n(v.qteCommandeeKg),
                qteRecueKg: n(v.qteRecueKg),
                prixKg: n(v.prixKg),
                transport: n(v.transport),
                autresFrais: n(v.autresFrais),
                qualite: v.qualite as Qualite,
              })
            }
          />
        }
      >
        <Table
          headers={[
            "N°",
            "Date",
            "Fournisseur",
            "Village",
            "Commandé",
            "Reçu",
            "Prix/kg",
            "Valeur achat",
            "Transport",
            "Coût total",
            "Qualité",
            "",
          ]}
          rows={computed.appro.map((r) => [
            r.numero,
            r.date,
            r.fournisseur,
            r.village,
            `${r.qteCommandeeKg} kg`,
            `${r.qteRecueKg} kg`,
            fcFormat(r.prixKg),
            fcFormat(r.valeurAchat),
            fcFormat(r.transport + r.autresFrais),
            fcFormat(r.coutTotal),
            r.qualite,
            <DeleteButton onClick={() => removeRow("approvisionnements", r.id)} />,
          ])}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Fournisseurs actifs"
          objectif={1}
          realise={state.producteurs.length}
          taux={state.producteurs.length / 1}
        />
        <KpiTile
          label="Quantité reçue"
          objectif={p.objectifAnanasKg}
          realise={Math.round(computed.kgAchetes)}
          unit="kg"
          taux={computed.kgAchetes / p.objectifAnanasKg}
        />
        <KpiTile label="Coût matière" realise={fcFormat(computed.coutAchats)} />
        <KpiTile label="Transport & frais" realise={fcFormat(computed.coutTransport)} />
      </div>

      <Card title="Registre des producteurs">
        <Table
          headers={[
            "ID",
            "Nom / Association",
            "Village",
            "Territoire",
            "Téléphone",
            "Capacité kg/mois",
            "Prix convenu",
            "Statut",
          ]}
          rows={state.producteurs.map((r) => [
            r.id,
            r.nom,
            r.village,
            r.territoire,
            r.telephone,
            r.capaciteKgMois,
            fcFormat(r.prixConvenu),
            r.statut,
          ])}
        />
      </Card>
    </div>
  );
}

function ProductionSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const p = state.parametres;
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 02"
        title="Production & transformation"
        responsable="Directeur de Production"
      />
      <ExportBar section="production" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Bouteilles produites"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesProduites}
          taux={computed.bouteillesProduites / p.objectifBouteilles}
        />
        <KpiTile
          label="Rendement volume"
          objectif="95 %"
          realise={pctFormat(computed.rendementMoyen)}
          taux={computed.rendementMoyen / 0.95}
        />
        <KpiTile
          label="Pertes volume"
          objectif={pctFormat(p.tauxPertesMax)}
          realise={pctFormat(computed.tauxPertes)}
        />
        <KpiTile label="Valeur production" realise={fcFormat(computed.valeurProduction)} />
      </div>

      <Card
        title="Lots de production"
        action={
          <EntryForm
            submitLabel="Nouveau lot"
            fields={[
              { name: "lot", label: "N° lot", default: "002_AROM" },
              { name: "date", label: "Date", type: "date", default: "2026-07-13" },
              { name: "kgUtilises", label: "Kg ananas utilisés", type: "number", default: 0 },
              { name: "volumeJusL", label: "Volume jus (L)", type: "number", default: 0 },
              { name: "q500", label: "500 ml produits", type: "number", default: 0 },
              { name: "q330", label: "330 ml produits", type: "number", default: 0 },
              { name: "q300", label: "300 ml produits", type: "number", default: 0 },
              { name: "rejets", label: "Rejets", type: "number", default: 0 },
              { name: "responsable", label: "Responsable", default: "Directeur de production" },
              {
                name: "statut",
                label: "Statut lot",
                type: "select",
                options: ["En cours", "Terminé"],
                default: "Terminé",
              },
            ]}
            onSubmit={(v) =>
              addRow("productions", {
                id: newId("PRO"),
                lot: v.lot,
                date: v.date,
                kgUtilises: n(v.kgUtilises),
                volumeJusL: n(v.volumeJusL),
                q500: n(v.q500),
                q330: n(v.q330),
                q300: n(v.q300),
                rejets: n(v.rejets),
                responsable: v.responsable,
                statut: v.statut,
              })
            }
          />
        }
      >
        <Table
          headers={[
            "Lot",
            "Date",
            "Kg utilisés",
            "Jus (L)",
            "500 ml",
            "330 ml",
            "300 ml",
            "Total bt",
            "Conditionné (L)",
            "Pertes (L)",
            "Rendement",
            "Valeur",
            "Statut",
            "",
          ]}
          rows={computed.production.map((r) => [
            r.lot,
            r.date,
            r.kgUtilises,
            r.volumeJusL,
            r.q500,
            r.q330,
            r.q300,
            r.totalBouteilles,
            r.volumeConditionne.toFixed(2),
            r.pertesL.toFixed(2),
            pctFormat(r.rendement),
            fcFormat(r.valeurProduction),
            r.statut,
            <DeleteButton onClick={() => removeRow("productions", r.id)} />,
          ])}
        />
      </Card>

      <Card title="Contrôle qualité par lot">
        <Table
          headers={[
            "Lot",
            "Total bouteilles",
            "Rejets",
            "Conformes",
            "Taux conformité",
            "Responsable",
          ]}
          rows={computed.production.map((r) => [
            r.lot + " · " + r.date,
            r.totalBouteilles,
            r.rejets,
            r.conformes,
            pctFormat(r.totalBouteilles ? r.conformes / r.totalBouteilles : 0),
            r.responsable,
          ])}
        />
      </Card>
    </div>
  );
}

function StockSection() {
  const { state, computed, addRow, removeRow } = useErp();
  let cumul = 0;
  return (
    <div className="space-y-6">
      <SectionHeader eyebrow="Module ERP 03" title="Stocks" responsable="Production / Magasin" />
      <ExportBar section="stock" />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Stock matières premières" realise={computed.stockMPPieces} unit="pcs" />
        <KpiTile label="Valeur stock MP" realise={fcFormat(computed.stockMPValeur)} />
        <KpiTile
          label="Stock produits finis"
          realise={computed.stockPF.reduce((a, s) => a + s.stock, 0)}
          unit="bt"
        />
      </div>

      <Card
        title="Mouvements matières premières"
        action={
          <EntryForm
            submitLabel="Mouvement"
            fields={[
              { name: "date", label: "Date", type: "date", default: "2026-07-20" },
              { name: "produit", label: "Produit", default: "Ananas" },
              { name: "unite", label: "Unité", default: "Pièce" },
              {
                name: "type",
                label: "Type",
                type: "select",
                options: ["Entrée", "Sortie", "Ajustement"],
                default: "Entrée",
              },
              { name: "entree", label: "Quantité entrée", type: "number", default: 0 },
              { name: "sortie", label: "Quantité sortie", type: "number", default: 0 },
              { name: "coutUnitaire", label: "Coût unitaire FC", type: "number", default: 1044 },
              { name: "observation", label: "Observation" },
            ]}
            onSubmit={(v) =>
              addRow("stockMP", {
                id: newId("MP"),
                date: v.date,
                produit: v.produit,
                unite: v.unite,
                type: v.type as "Entrée" | "Sortie" | "Ajustement",
                entree: n(v.entree),
                sortie: n(v.sortie),
                coutUnitaire: n(v.coutUnitaire),
                observation: v.observation,
              })
            }
          />
        }
      >
        <Table
          headers={[
            "Date",
            "Produit",
            "Type",
            "Entrée",
            "Sortie",
            "Stock cumulé",
            "Coût unitaire",
            "Valeur stock",
            "Observation",
            "",
          ]}
          rows={state.stockMP.map((m) => {
            cumul += m.entree - m.sortie;
            return [
              m.date,
              m.produit,
              m.type,
              m.entree || "",
              m.sortie || "",
              cumul,
              fcFormat(m.coutUnitaire),
              fcFormat(cumul * m.coutUnitaire),
              m.observation,
              <DeleteButton onClick={() => removeRow("stockMP", m.id)} />,
            ];
          })}
        />
      </Card>

      <Card title="Stock produits finis (production − ventes)">
        <Table
          headers={["Format", "Produites", "Vendues", "Stock", "Valeur stock"]}
          rows={computed.stockPF.map((s) => [
            s.format,
            s.produites,
            s.vendues,
            s.stock,
            fcFormat(s.valeur),
          ])}
        />
      </Card>
    </div>
  );
}

interface Product {
  id: string;
  name: string;
  format: Format;
  price: number;
  active: boolean;
  imageUrl?: string;
}

type ProductDraft = { name: string; format: Format; price: string };

function ProductPhoto({
  product,
  uploading,
  onUpload,
}: {
  product: Product;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <label className="group relative block h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-border bg-secondary/40">
      {product.imageUrl ? (
        <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-[10px] font-medium text-muted-foreground">
          Photo
        </div>
      )}
      <div className="absolute inset-0 grid place-items-center bg-black/50 text-[10px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
        {uploading ? "Envoi…" : "Changer"}
      </div>
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />
    </label>
  );
}

/**
 * The only dashboard section with real per-row editing (elsewhere the
 * pattern is append + delete) — products need it, since "wrong price"
 * shouldn't mean deleting and re-creating a product partners already
 * have in past orders (orders snapshot product data at order time, so
 * editing here never touches order history — see sprints/01).
 */
function CatalogueCard() {
  const [products, setProducts] = useState<Product[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProductDraft>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(db, "products"),
      (snap) => {
        const rows = snap.docs
          .map((d) => d.data() as Product)
          .sort((a, b) => a.name.localeCompare(b.name));
        setProducts(rows);
        setDrafts((prev) => {
          const next = { ...prev };
          for (const p of rows) {
            if (!next[p.id])
              next[p.id] = { name: p.name, format: p.format, price: String(p.price) };
          }
          return next;
        });
      },
      (err) => toast.error(`Synchronisation "catalogue" impossible : ${err.message}`),
    );
  }, []);

  const draftFor = (p: Product): ProductDraft =>
    drafts[p.id] ?? { name: p.name, format: p.format, price: String(p.price) };

  const setDraft = (id: string, patch: Partial<ProductDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const saveProduct = (p: Product) => {
    const draft = draftFor(p);
    updateDoc(doc(db, "products", p.id), {
      name: draft.name.trim() || p.name,
      format: draft.format,
      price: n(draft.price),
    })
      .then(() => toast.success("Produit enregistré."))
      .catch((err) => toast.error(`Enregistrement impossible : ${err.message}`));
  };

  const toggleActive = (p: Product) =>
    updateDoc(doc(db, "products", p.id), { active: !p.active }).catch((err) =>
      toast.error(`Mise à jour impossible : ${err.message}`),
    );

  const uploadPhoto = async (p: Product, file: File) => {
    setUploadingId(p.id);
    try {
      const photoRef = ref(storage, `products/${p.id}/photo`);
      await uploadBytes(photoRef, file);
      const url = await getDownloadURL(photoRef);
      await updateDoc(doc(db, "products", p.id), { imageUrl: url });
      toast.success("Photo mise à jour.");
    } catch (err) {
      toast.error(err instanceof Error ? `Envoi impossible : ${err.message}` : "Envoi impossible.");
    } finally {
      setUploadingId(null);
    }
  };

  const createProduct = (v: Record<string, string>) => {
    const id = newId("PRD");
    setDoc(doc(db, "products", id), {
      id,
      name: v.name,
      format: v.format as Format,
      price: n(v.price),
      active: true,
    }).catch((err) => toast.error(`Création impossible : ${err.message}`));
  };

  return (
    <Card
      title="Catalogue boutique"
      action={
        <EntryForm
          submitLabel="Nouveau produit"
          fields={[
            { name: "name", label: "Nom", default: "AROM Ananas 500 ml" },
            {
              name: "format",
              label: "Format",
              type: "select",
              options: FORMATS,
              default: "500 ml",
            },
            { name: "price", label: "Prix FC", type: "number", default: 5000 },
          ]}
          onSubmit={createProduct}
        />
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {products.map((p) => {
          const draft = draftFor(p);
          return (
            <div
              key={p.id}
              className={`flex gap-3 rounded-xl border border-border bg-card p-4 ${!p.active ? "opacity-60" : ""}`}
            >
              <ProductPhoto
                product={p}
                uploading={uploadingId === p.id}
                onUpload={(file) => uploadPhoto(p, file)}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft(p.id, { name: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm font-semibold text-foreground"
                />
                <div className="flex gap-2">
                  <select
                    value={draft.format}
                    onChange={(e) => setDraft(p.id, { format: e.target.value as Format })}
                    className="w-1/2 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                  >
                    {FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={draft.price}
                    onChange={(e) => setDraft(p.id, { price: e.target.value })}
                    className="w-1/2 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    onClick={() => toggleActive(p)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      p.active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {p.active ? "Actif" : "Inactif"}
                  </button>
                  <button
                    onClick={() => saveProduct(p)}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    Enregistrer
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {products.length === 0 && (
          <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
            Aucun produit. Ajoutez le premier avec « Nouveau produit ».
          </p>
        )}
      </div>
    </Card>
  );
}

interface StorefrontOrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  format: string;
}

const ORDER_STATUS_LABELS: Record<StorefrontOrder["status"], string> = {
  pending: "En attente",
  confirmed: "Confirmée",
  fulfilled: "Livrée",
  cancelled: "Annulée",
};

interface StorefrontOrder {
  id: string;
  partnerId: string;
  partnerName: string;
  items: StorefrontOrderItem[];
  total: number;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  createdAt: string;
  payment?: { method: "pawapay" | "cash_on_delivery"; status: "pending" | "completed" };
}

/**
 * Confirming/fulfilling a storefront order didn't create a `ventes` row, so
 * storefront sales never reached the dashboard's commercial KPIs. Marking an
 * order "livrée" now atomically closes it out and writes one `ventes` row
 * per line item — deterministic doc IDs (`VTE-ORD-<orderId>-<idx>`) make the
 * write idempotent if it's ever retried.
 */
function OrdersCard() {
  const [orders, setOrders] = useState<StorefrontOrder[]>([]);

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    return onSnapshot(
      q,
      (snap) =>
        setOrders(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StorefrontOrder, "id">) })),
        ),
      (err) => toast.error(`Synchronisation "commandes" impossible : ${err.message}`),
    );
  }, []);

  const setStatus = (id: string, status: StorefrontOrder["status"]) =>
    updateDoc(doc(db, "orders", id), { status }).catch((err) =>
      toast.error(`Mise à jour de la commande impossible : ${err.message}`),
    );

  const fulfillAndConvert = async (order: StorefrontOrder) => {
    const batch = writeBatch(db);
    batch.update(doc(db, "orders", order.id), { status: "fulfilled" });
    const base = `CMD-${order.id.slice(-6).toUpperCase()}`;
    order.items.forEach((item, idx) => {
      const numero = order.items.length > 1 ? `${base}-${idx + 1}` : base;
      batch.set(doc(db, "ventes", `VTE-ORD-${order.id}-${idx}`), {
        id: `VTE-ORD-${order.id}-${idx}`,
        numero,
        date: order.createdAt.slice(0, 10),
        idClient: order.partnerId,
        client: order.partnerName,
        canal: "Grossiste" as Canal,
        format: (FORMATS.includes(item.format as Format) ? item.format : "500 ml") as Format,
        quantite: item.quantity,
        prixUnitaire: item.unitPrice,
        remise: 0,
        // Mobile money is already settled by checkout time (payment.status
        // "completed"); cash on delivery is collected the moment the order
        // is marked "livrée" — either way the full line amount is encaissé
        // here. Orders without a `payment` field predate this flow, so we
        // can't assume cash changed hands and leave encaisse at 0.
        encaisse: order.payment ? item.quantity * item.unitPrice : 0,
        commerciale: "Boutique partenaire",
      });
    });
    try {
      await batch.commit();
      toast.success("Commande livrée, ventes enregistrées.");
    } catch (err) {
      toast.error(
        err instanceof Error ? `Conversion impossible : ${err.message}` : "Conversion impossible.",
      );
    }
  };

  return (
    <Card title="Commandes boutique partenaires">
      <Table
        headers={["Date", "Partenaire", "Articles", "Total", "Paiement", "Statut", "Actions"]}
        rows={orders.map((o) => [
          new Date(o.createdAt).toLocaleDateString("fr-FR"),
          o.partnerName,
          o.items.map((i) => `${i.quantity}× ${i.name}`).join(", "),
          fcFormat(o.total),
          <span>
            {!o.payment
              ? "—"
              : o.payment.method === "cash_on_delivery"
                ? "Livraison"
                : "Mobile money"}
          </span>,
          <span>{ORDER_STATUS_LABELS[o.status]}</span>,
          <div className="flex gap-3">
            {o.status === "pending" && (
              <>
                <button
                  onClick={() => setStatus(o.id, "confirmed")}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  Confirmer
                </button>
                <button
                  onClick={() => setStatus(o.id, "cancelled")}
                  className="text-xs font-semibold text-destructive hover:underline"
                >
                  Annuler
                </button>
              </>
            )}
            {o.status === "confirmed" && (
              <>
                <button
                  onClick={() => fulfillAndConvert(o)}
                  className="text-xs font-semibold text-success hover:underline"
                >
                  Marquer livrée
                </button>
                <button
                  onClick={() => setStatus(o.id, "cancelled")}
                  className="text-xs font-semibold text-destructive hover:underline"
                >
                  Annuler
                </button>
              </>
            )}
          </div>,
        ])}
      />
    </Card>
  );
}

function CommercialisationSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const p = state.parametres;
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 04"
        title="Ventes & encaissements"
        responsable="Chargée de Commercialisation"
      />
      <ExportBar section="commercialisation" />

      <CatalogueCard />

      <OrdersCard />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Bouteilles vendues"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesVendues}
          taux={computed.bouteillesVendues / p.objectifBouteilles}
        />
        <KpiTile label="Chiffre d'affaires" realise={fcFormat(computed.ca)} />
        <KpiTile
          label="Taux d'encaissement"
          objectif="100 %"
          realise={pctFormat(computed.tauxEncaissement)}
          taux={computed.tauxEncaissement}
        />
        <KpiTile label="Créances clients" realise={fcFormat(computed.creances)} />
      </div>

      <Card
        title="Journal des ventes"
        action={
          <EntryForm
            submitLabel="Nouvelle vente"
            fields={[
              { name: "numero", label: "N° vente", default: "V-001" },
              { name: "date", label: "Date", type: "date", default: "2026-07-20" },
              { name: "client", label: "Client" },
              {
                name: "canal",
                label: "Canal",
                type: "select",
                options: CANAUX,
                default: "Restaurant",
              },
              {
                name: "format",
                label: "Format",
                type: "select",
                options: FORMATS,
                default: "500 ml",
              },
              { name: "quantite", label: "Quantité", type: "number", default: 0 },
              {
                name: "prixUnitaire",
                label: "Prix unitaire FC",
                type: "number",
                default: p.prix500,
              },
              { name: "remise", label: "Remise FC", type: "number", default: 0 },
              { name: "encaisse", label: "Montant encaissé FC", type: "number", default: 0 },
              {
                name: "commerciale",
                label: "Commerciale",
                default: "Chargée de commercialisation",
              },
            ]}
            onSubmit={(v) =>
              addRow("ventes", {
                id: newId("VTE"),
                numero: v.numero,
                date: v.date,
                idClient: v.client,
                client: v.client,
                canal: v.canal as Canal,
                format: v.format as Format,
                quantite: n(v.quantite),
                prixUnitaire: n(v.prixUnitaire) || prixFormat(p, v.format as Format),
                remise: n(v.remise),
                encaisse: n(v.encaisse),
                commerciale: v.commerciale,
              })
            }
          />
        }
      >
        <Table
          headers={[
            "N°",
            "Date",
            "Client",
            "Canal",
            "Format",
            "Qté",
            "PU",
            "Brut",
            "Encaissé",
            "Solde dû",
            "Statut",
            "",
          ]}
          rows={computed.ventes.map((v) => [
            v.numero,
            v.date,
            v.client,
            v.canal,
            v.format,
            v.quantite,
            fcFormat(v.prixUnitaire),
            fcFormat(v.montantBrut),
            fcFormat(v.encaisse),
            fcFormat(v.soldeDu),
            v.statutPaiement,
            <DeleteButton onClick={() => removeRow("ventes", v.id)} />,
          ])}
        />
      </Card>

      <Card title="Portefeuille clients par canal">
        <Table
          headers={["Canal", "Clients", "Bouteilles", "CA", "Encaissé", "Solde dû"]}
          rows={CANAUX.map((c) => {
            const rows = computed.ventes.filter((v) => v.canal === c);
            return [
              c,
              new Set(rows.map((r) => r.client)).size,
              rows.reduce((a, r) => a + r.quantite, 0),
              fcFormat(rows.reduce((a, r) => a + r.montantBrut, 0)),
              fcFormat(rows.reduce((a, r) => a + r.encaisse, 0)),
              fcFormat(rows.reduce((a, r) => a + r.soldeDu, 0)),
            ];
          })}
        />
      </Card>
    </div>
  );
}

function MarketingSection() {
  const { state, computed, addRow, removeRow } = useErp();
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 05"
        title="Marketing & prospection"
        responsable="Chargée de Commercialisation"
      />
      <ExportBar section="marketing" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Budget engagé" realise={fcFormat(computed.coutMarketing)} />
        <KpiTile label="Contacts touchés" realise={computed.contactsTouches} />
        <KpiTile label="Prospects générés" realise={computed.prospects} />
        <KpiTile label="ROI marketing" realise={pctFormat(computed.roiMarketing)} />
      </div>

      <Card
        title="Actions marketing"
        action={
          <EntryForm
            submitLabel="Nouvelle action"
            fields={[
              { name: "numero", label: "ID action", default: "MKT-001" },
              { name: "date", label: "Date", type: "date", default: "2026-07-20" },
              { name: "campagne", label: "Campagne", default: "Campagne pilote 2026" },
              {
                name: "canal",
                label: "Canal",
                type: "select",
                options: [
                  "Dégustation",
                  "Facebook",
                  "WhatsApp",
                  "TikTok",
                  "Instagram",
                  "Affiches",
                  "Prospection terrain",
                ],
                default: "Facebook",
              },
              { name: "cible", label: "Cible" },
              { name: "description", label: "Description" },
              { name: "budget", label: "Budget FC", type: "number", default: 0 },
              { name: "coutReel", label: "Coût réel FC", type: "number", default: 0 },
              { name: "contacts", label: "Contacts touchés", type: "number", default: 0 },
              { name: "prospects", label: "Prospects générés", type: "number", default: 0 },
              { name: "ventesGenerees", label: "Ventes générées FC", type: "number", default: 0 },
            ]}
            onSubmit={(v) =>
              addRow("marketing", {
                id: newId("MKT"),
                numero: v.numero,
                date: v.date,
                campagne: v.campagne,
                canal: v.canal,
                cible: v.cible,
                description: v.description,
                budget: n(v.budget),
                coutReel: n(v.coutReel),
                contacts: n(v.contacts),
                prospects: n(v.prospects),
                ventesGenerees: n(v.ventesGenerees),
              })
            }
          />
        }
      >
        <Table
          headers={[
            "ID",
            "Date",
            "Canal",
            "Cible",
            "Budget",
            "Coût réel",
            "Contacts",
            "Prospects",
            "Ventes générées",
            "ROI",
            "",
          ]}
          rows={state.marketing.map((m) => [
            m.numero,
            m.date,
            m.canal,
            m.cible,
            fcFormat(m.budget),
            fcFormat(m.coutReel),
            m.contacts,
            m.prospects,
            fcFormat(m.ventesGenerees),
            pctFormat(m.coutReel ? (m.ventesGenerees - m.coutReel) / m.coutReel : 0),
            <DeleteButton onClick={() => removeRow("marketing", m.id)} />,
          ])}
        />
      </Card>
    </div>
  );
}

function FinancesSection() {
  const { computed } = useErp();
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 06"
        title="Finances de campagne"
        subtitle="Analyse hors amortissement"
        responsable="Direction Générale"
      />
      <ExportBar section="finances" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Revenus">
          <Table
            headers={["Rubrique", "Montant"]}
            rows={[
              ["Chiffre d'affaires brut", fcFormat(computed.ca)],
              ["Encaissements", fcFormat(computed.encaissements)],
              ["Créances clients", fcFormat(computed.creances)],
            ]}
          />
        </Card>
        <Card title="Coûts d'exploitation">
          <Table
            headers={["Rubrique", "Réalisé"]}
            rows={[
              ["Achats ananas", fcFormat(computed.coutAchats)],
              ["Transport et frais", fcFormat(computed.coutTransport)],
              ["Autres charges d'exploitation", fcFormat(computed.autresCharges)],
              ["Marketing", fcFormat(computed.coutMarketing)],
              ["TOTAL COÛTS", fcFormat(computed.totalCouts)],
            ]}
          />
        </Card>
      </div>

      <Card title="Résultat & indicateurs unitaires">
        <Table
          headers={["Indicateur", "Valeur", "Lecture"]}
          rows={[
            ["Résultat brut hors amortissement", fcFormat(computed.resultatBrut), "CA − coûts"],
            ["Marge brute", pctFormat(computed.margeBrute), "Résultat / CA"],
            ["Rendement sur coûts", pctFormat(computed.rendementSurCouts), "Résultat / coûts"],
            [
              "Coût moyen / bouteille",
              fcFormat(computed.coutMoyenBouteille),
              "Coût d'exploitation moyen",
            ],
            [
              "Prix moyen vendu",
              fcFormat(computed.prixMoyenVendu),
              "Recette moyenne par bouteille",
            ],
            ["Marge unitaire", fcFormat(computed.margeUnitaire), "Hors amortissement"],
            ["Besoin cycle suivant", fcFormat(computed.totalCouts), "Fonds de roulement minimum"],
          ]}
        />
      </Card>
    </div>
  );
}

interface Invite {
  id: string;
  email: string;
  role: "admin" | "staff";
  menus: "all" | string[];
  used: boolean;
  usedBy?: string;
  createdAt: string;
}

/**
 * Admin-only: create an invite so someone can self-register as admin/staff
 * at /join, instead of needing AROM-Backend/scripts/create-user.mjs run by
 * hand. Enforced by firestore.rules (email/role/menus must match the
 * invite exactly) — this UI is convenience, not the security boundary.
 */
function InviteCard() {
  const { profile } = useAuth();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [menus, setMenus] = useState<string[]>([]);
  const [allMenus, setAllMenus] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (profile?.role !== "admin") return;
    return onSnapshot(
      query(collection(db, "invites"), orderBy("createdAt", "desc")),
      (snap) =>
        setInvites(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Invite, "id">) }))),
      (err) => toast.error(`Synchronisation "invitations" impossible : ${err.message}`),
    );
  }, [profile?.role]);

  if (profile?.role !== "admin") return null;

  const toggleMenu = (id: string) =>
    setMenus((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  const createInvite = async () => {
    if (!email.trim()) {
      toast.error("Adresse e-mail requise.");
      return;
    }
    const inviteRef = doc(collection(db, "invites"));
    try {
      await setDoc(inviteRef, {
        email: email.trim(),
        role,
        menus: role === "admin" || allMenus ? "all" : menus,
        used: false,
        createdBy: profile.uid,
        createdAt: new Date().toISOString(),
      });
      setEmail("");
      setMenus([]);
      setAllMenus(false);
      toast.success("Invitation créée — copiez le lien pour la partager.");
    } catch (err) {
      toast.error(
        err instanceof Error ? `Création impossible : ${err.message}` : "Création impossible.",
      );
    }
  };

  const copyLink = (invite: Invite) => {
    const link = `${window.location.origin}/join?invite=${invite.id}`;
    navigator.clipboard.writeText(link).then(
      () => {
        setCopiedId(invite.id);
        setTimeout(() => setCopiedId(null), 2000);
      },
      () => toast.error("Copie impossible — copiez le lien manuellement."),
    );
  };

  const revoke = (invite: Invite) =>
    deleteDoc(doc(db, "invites", invite.id)).catch((err) =>
      toast.error(`Révocation impossible : ${err.message}`),
    );

  return (
    <Card title="Inviter un membre de l'équipe">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
          E-mail
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="personne@exemple.cd"
            className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
          />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Rôle
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "staff")}
            className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
          >
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            onClick={createInvite}
            className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
          >
            Créer l'invitation
          </button>
        </div>
      </div>

      {role === "staff" && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground">Sections accessibles</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setAllMenus((v) => !v)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                allMenus
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >
              Toutes les sections
            </button>
            {!allMenus &&
              SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleMenu(s.id)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    menus.includes(s.id)
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground"
                  }`}
                >
                  {s.label}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="mt-5 overflow-hidden rounded-xl border border-border">
        <Table
          headers={["E-mail", "Rôle", "Sections", "Statut", "Lien"]}
          rows={invites.map((inv) => [
            inv.email,
            inv.role,
            inv.menus === "all" ? "Toutes" : inv.menus.join(", ") || "—",
            inv.used ? (
              <span className="badge-status bg-success/15 text-success">Utilisée</span>
            ) : (
              <span className="badge-status bg-warning/20 text-warning">En attente</span>
            ),
            inv.used ? (
              "—"
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => copyLink(inv)}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  {copiedId === inv.id ? "Copié !" : "Copier le lien"}
                </button>
                <DeleteButton onClick={() => revoke(inv)} />
              </div>
            ),
          ])}
        />
      </div>
    </Card>
  );
}

function PersonnelSection() {
  const { state, computed } = useErp();
  const p = state.parametres;
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 07"
        title="Primes & commissions"
        subtitle="Calcul automatique sur production conforme et encaissements"
        responsable="Direction Générale"
      />

      <InviteCard />

      <Card title="Directeur de Production">
        <Table
          headers={["Indicateur", "Objectif", "Réalisé", "Statut"]}
          rows={[
            [
              "Production",
              `${p.objectifBouteilles} bouteilles`,
              computed.bouteillesProduites,
              <Status
                statut={
                  computed.bouteillesProduites >= p.objectifBouteilles ? "Atteint" : "À surveiller"
                }
              />,
            ],
            [
              "Rendement volume",
              "> 95 %",
              pctFormat(computed.rendementMoyen),
              <Status statut={computed.rendementMoyen >= 0.95 ? "Atteint" : "À surveiller"} />,
            ],
            [
              "Pertes",
              `< ${pctFormat(p.tauxPertesMax)}`,
              pctFormat(computed.tauxPertes),
              <Status statut={computed.tauxPertes <= p.tauxPertesMax ? "Conforme" : "Excès"} />,
            ],
          ]}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-primary/5 p-4 text-sm">
          <span className="font-semibold text-primary">Prime</span>
          <span className="rounded-md bg-card px-3 py-1.5 font-medium">
            {fcFormat(computed.valeurProduction)}
          </span>
          <span className="text-muted-foreground">×</span>
          <span className="rounded-md bg-gold px-3 py-1.5 font-bold text-primary">
            {pctFormat(p.tauxPrimeProduction)}
          </span>
          <span className="text-muted-foreground">=</span>
          <span className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground">
            {fcFormat(computed.primeProduction)}
          </span>
        </div>
      </Card>

      <Card title="Chargée de Commercialisation">
        <Table
          headers={["Indicateur", "Objectif", "Réalisé", "Statut"]}
          rows={[
            [
              "Ventes",
              `${p.objectifBouteilles} bouteilles`,
              computed.bouteillesVendues,
              <Status
                statut={
                  computed.bouteillesVendues >= p.objectifBouteilles ? "Atteint" : "À surveiller"
                }
              />,
            ],
            [
              "Clients",
              `${p.objectifClients} clients`,
              computed.clientsActifs,
              <Status
                statut={computed.clientsActifs >= p.objectifClients ? "Atteint" : "À surveiller"}
              />,
            ],
            [
              "Encaissement",
              "100 %",
              pctFormat(computed.tauxEncaissement),
              <Status statut={computed.tauxEncaissement >= 1 ? "Atteint" : "À surveiller"} />,
            ],
          ]}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-primary/5 p-4 text-sm">
          <span className="font-semibold text-primary">Commission</span>
          <span className="rounded-md bg-card px-3 py-1.5 font-medium">
            {fcFormat(computed.encaissements)}
          </span>
          <span className="text-muted-foreground">×</span>
          <span className="rounded-md bg-gold px-3 py-1.5 font-bold text-primary">
            {pctFormat(p.tauxCommission)}
          </span>
          <span className="text-muted-foreground">=</span>
          <span className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground">
            {fcFormat(computed.commissionCommerciale)}
          </span>
        </div>
      </Card>

      <Card title="Total primes campagne">
        <Table
          headers={["Période", "Base production", "Base encaissements", "Total primes"]}
          rows={[
            [
              "Campagne pilote 2026",
              fcFormat(computed.valeurProduction),
              fcFormat(computed.encaissements),
              fcFormat(computed.totalPrimes),
            ],
          ]}
        />
      </Card>
    </div>
  );
}

function KpiSection() {
  const { state, computed } = useErp();
  const p = state.parametres;
  const items = [
    {
      k: "Taux de transformation",
      o: "100 %",
      r: pctFormat(computed.kgAchetes ? computed.kgTransformes / computed.kgAchetes : 0),
    },
    {
      k: "Taux de vente",
      o: "100 %",
      r: pctFormat(
        computed.bouteillesProduites
          ? computed.bouteillesVendues / computed.bouteillesProduites
          : 0,
      ),
    },
    { k: "Taux d'encaissement", o: "100 %", r: pctFormat(computed.tauxEncaissement) },
    { k: "Rendement matière", o: "> 95 %", r: pctFormat(computed.rendementMoyen) },
    { k: "Pertes", o: `< ${pctFormat(p.tauxPertesMax)}`, r: pctFormat(computed.tauxPertes) },
    { k: "Clients actifs", o: String(p.objectifClients), r: String(computed.clientsActifs) },
    { k: "Marge brute", o: pctFormat(p.objectifMargeBrute), r: pctFormat(computed.margeBrute) },
    { k: "Coût moyen / bouteille", o: "-", r: fcFormat(computed.coutMoyenBouteille) },
    { k: "Créances à recouvrer", o: "0 FC", r: fcFormat(computed.creances) },
  ];
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 08"
        title="Indicateurs stratégiques"
        subtitle="Calculés en temps réel à partir des modules ERP"
      />
      <ExportBar section="kpi" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <KpiTile key={i.k} label={i.k} objectif={i.o} realise={i.r} />
        ))}
      </div>
    </div>
  );
}

function ParametresSection() {
  const { state, updateParametres, reset } = useErp();
  const p = state.parametres;
  const num = (label: string, key: keyof typeof p, step = "1") => (
    <label className="text-xs font-medium text-muted-foreground">
      {label}
      <input
        type="number"
        step={step}
        value={String(p[key])}
        onChange={(e) => updateParametres({ [key]: Number(e.target.value) } as never)}
        className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
      />
    </label>
  );
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 09"
        title="Paramètres de gestion"
        subtitle="Hypothèses modifiables, elles recalculent tous les tableaux de bord"
        responsable="Direction Générale"
      />
      <Card
        title="Objectifs & tarifs"
        action={
          <button
            onClick={reset}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-primary"
          >
            Réinitialiser les données ERP
          </button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {num("Objectif ananas (kg)", "objectifAnanasKg")}
          {num("Objectif bouteilles", "objectifBouteilles")}
          {num("Objectif clients", "objectifClients")}
          {num("Objectif marge brute", "objectifMargeBrute", "0.01")}
          {num("Prix 500 ml (FC)", "prix500", "100")}
          {num("Prix 330 ml (FC)", "prix330", "100")}
          {num("Prix 300 ml (FC)", "prix300", "100")}
          {num("Distance fournisseur (km)", "distanceFournisseurKm")}
          {num("Commission commerciale", "tauxCommission", "0.01")}
          {num("Prime production", "tauxPrimeProduction", "0.01")}
          {num("Taux pertes maximum", "tauxPertesMax", "0.01")}
        </div>
      </Card>
      <Card title="Calendrier de campagne">
        <Table
          headers={["Étape", "Date"]}
          rows={[
            ["Début production", p.debutProduction],
            ["Fin production", p.finProduction],
            ["Fin commercialisation", p.finCommercialisation],
          ]}
        />
      </Card>
    </div>
  );
}

function RoadmapSection() {
  const { computed } = useErp();
  const phases = [
    { p: "Pilote", c: 300 },
    { p: "Phase 2", c: 600 },
    { p: "Phase 3", c: 1000 },
    { p: "Phase 4", c: 2000 },
  ];
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 10"
        title="Feuille de route de croissance"
        subtitle="Trajectoire d'industrialisation suivie par la production réelle"
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {phases.map((ph, i) => {
          const done = computed.bouteillesProduites >= ph.c;
          return (
            <div
              key={ph.p}
              className="relative overflow-hidden rounded-2xl border border-border bg-card p-6"
            >
              <div className="absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gold/15" />
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">
                Étape {i + 1}
              </p>
              <h3 className="mt-2 font-display text-2xl font-bold text-primary">{ph.p}</h3>
              <p className="mt-1 text-sm text-muted-foreground">Capacité cible</p>
              <p className="mt-1 font-display text-xl font-semibold text-foreground">
                {ph.c} bouteilles
              </p>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-leaf"
                  style={{
                    width: `${Math.min(100, (computed.bouteillesProduites / ph.c) * 100)}%`,
                  }}
                />
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs">
                <span
                  className={`grid h-5 w-5 place-items-center rounded border ${done ? "border-success bg-success text-primary-foreground" : "border-border bg-background"}`}
                >
                  {done ? "✓" : ""}
                </span>
                <span className="text-muted-foreground">{done ? "Atteinte" : "En cours"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
