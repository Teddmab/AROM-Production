import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { ErpProvider, useErp, newId } from "@/lib/erp/store";
import { db, storage } from "@/lib/firebase/config";
import {
  CANAUX,
  FORMATS,
  QUALITES,
  fcFormat,
  formatDateOnly,
  pctFormat,
  prixFormat,
  type Canal,
  type Format,
  type Qualite,
} from "@/lib/erp/model";
import { ExportBar } from "@/components/erp/ExportBar";
import { RecordDetailModal, type DetailField } from "@/components/erp/RecordDetailModal";
import { RequireRole } from "@/lib/firebase/require-role";
import { useAuth, canAccessMenu, STAFF_POSTES, type StaffPoste } from "@/lib/firebase/auth";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  | "parcours"
  | "marketing"
  | "finances"
  | "personnel"
  | "kpi"
  | "parametres"
  | "roadmap";

const SECTIONS: {
  id: SectionId;
  label: string;
  num: string;
  subItems?: { id: string; label: string }[];
}[] = [
  { id: "executif", label: "Exécutif", num: "00" },
  { id: "appro", label: "Approvisionnement", num: "01" },
  { id: "production", label: "Production", num: "02" },
  { id: "stock", label: "Stock", num: "03" },
  {
    id: "commercialisation",
    label: "Commercialisation",
    num: "04",
    subItems: [
      { id: "catalogue", label: "Catalogue" },
      { id: "promotions", label: "Promotions" },
      { id: "commandes", label: "Commandes" },
      { id: "ventes", label: "Ventes & clients" },
    ],
  },
  { id: "parcours", label: "Parcours production", num: "05" },
  { id: "marketing", label: "Marketing", num: "06" },
  { id: "finances", label: "Finances", num: "07" },
  {
    id: "personnel",
    label: "Primes & personnel",
    num: "08",
    subItems: [
      { id: "invitations", label: "Invitations" },
      { id: "equipe", label: "Équipe" },
      { id: "boutiques", label: "Boutiques partenaires" },
      { id: "primes-production", label: "Primes production" },
      { id: "primes-commercial", label: "Primes commercial" },
    ],
  },
  { id: "kpi", label: "KPI stratégiques", num: "09" },
  { id: "parametres", label: "Paramètres ERP", num: "10" },
  { id: "roadmap", label: "Feuille de route", num: "11" },
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
  // Keyed by section id, one entry per tabbed section — defaults to that
  // section's first tab the first time it's visited.
  const [activeSubTab, setActiveSubTab] = useState<Record<string, string>>({});
  const goTo = (sectionId: SectionId, subTabId?: string) => {
    setActive(sectionId);
    if (subTabId) setActiveSubTab((s) => ({ ...s, [sectionId]: subTabId }));
  };
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
            <div key={s.id}>
              <button
                onClick={() => setActive(s.id)}
                className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
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
              {/* Shortcut access to this section's tabs — only shown once
                  the section is active, so the sidebar stays compact for
                  the 9 sections that don't have sub-tabs. */}
              {s.subItems && active === s.id && (
                <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border pl-3">
                  {s.subItems.map((sub) => {
                    const isActiveSub = (activeSubTab[s.id] ?? s.subItems![0].id) === sub.id;
                    return (
                      <button
                        key={sub.id}
                        onClick={() => goTo(s.id, sub.id)}
                        className={`rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                          isActiveSub
                            ? "font-semibold text-primary"
                            : "text-muted-foreground hover:text-primary"
                        }`}
                      >
                        {sub.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
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
          {active === "commercialisation" && (
            <CommercialisationSection
              activeTab={activeSubTab.commercialisation ?? "catalogue"}
              onTabChange={(v) => setActiveSubTab((s) => ({ ...s, commercialisation: v }))}
            />
          )}
          {active === "parcours" && <ParcoursSection onNavigate={setActive} />}
          {active === "marketing" && <MarketingSection />}
          {active === "finances" && <FinancesSection />}
          {active === "personnel" && (
            <PersonnelSection
              activeTab={activeSubTab.personnel ?? "invitations"}
              onTabChange={(v) => setActiveSubTab((s) => ({ ...s, personnel: v }))}
            />
          )}
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
  description,
}: {
  label: string;
  objectif?: string | number;
  realise?: string | number;
  unit?: string;
  taux?: number;
  /** When set, the tile is clickable and opens an explanation modal — what this figure is and where it comes from. */
  description?: string;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const pct = typeof taux === "number" ? Math.max(0, Math.min(100, Math.round(taux * 100))) : null;
  return (
    <>
      <div
        onClick={description ? () => setShowDetail(true) : undefined}
        className={`rounded-2xl border border-border bg-card p-5 ${description ? "cursor-pointer transition hover:border-primary/40" : ""}`}
      >
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
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
            <p className="mt-1 text-right text-[10px] font-semibold text-muted-foreground">
              {pct}%
            </p>
          </div>
        )}
      </div>
      {showDetail && description && (
        <RecordDetailModal
          title={label}
          onClose={() => setShowDetail(false)}
          fields={[
            {
              label: "Valeur",
              value: `${realise ?? "-"}${unit ? ` ${unit}` : ""}`,
              description,
            },
            ...(objectif !== undefined
              ? [
                  {
                    label: "Objectif",
                    value: `${objectif}${unit ? ` ${unit}` : ""}`,
                    description: "Cible définie dans Paramètres ERP pour la campagne en cours.",
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}

function Table({
  headers,
  rows,
  empty = "Aucune saisie enregistrée",
  onRowClick,
}: {
  headers: string[];
  rows: (string | number | ReactNode)[][];
  empty?: string;
  /** When set, every row opens a detail modal — see RecordDetailModal. */
  onRowClick?: (index: number) => void;
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
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(i) : undefined}
                className={`hover:bg-primary/5 ${onRowClick ? "cursor-pointer" : ""}`}
              >
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

function DeleteButton({ onClick }: { onClick: (e: MouseEvent) => void }) {
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

const trendChartConfig = {
  bouteilles: { label: "Bouteilles produites", color: "var(--primary)" },
  ca: { label: "Chiffre d'affaires (FC)", color: "var(--gold)" },
} satisfies ChartConfig;

/**
 * The one real chart in the dashboard (recharts was installed but never
 * rendered anywhere) — production volume and sales revenue by date, so
 * the Exécutif page (every role's landing view) has an actual trend to
 * look at instead of only number tiles.
 */
function TrendChart({
  production,
  ventes,
}: {
  production: { date: string; totalBouteilles: number }[];
  ventes: { date: string; montantBrut: number }[];
}) {
  const byDate = new Map<string, { date: string; bouteilles: number; ca: number }>();
  const bucket = (date: string) => {
    if (!byDate.has(date)) byDate.set(date, { date, bouteilles: 0, ca: 0 });
    return byDate.get(date)!;
  };
  production.forEach((r) => {
    bucket(r.date).bouteilles += r.totalBouteilles;
  });
  ventes.forEach((r) => {
    bucket(r.date).ca += r.montantBrut;
  });
  const data = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Pas encore de production ou de ventes à afficher.
      </p>
    );
  }

  return (
    <ChartContainer config={trendChartConfig} className="aspect-auto h-72 w-full">
      <AreaChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatDateOnly(v)}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(v) => formatDateOnly(String(v))} />}
        />
        <Area
          dataKey="bouteilles"
          type="monotone"
          fill="var(--color-bouteilles)"
          fillOpacity={0.15}
          stroke="var(--color-bouteilles)"
        />
        <Area
          dataKey="ca"
          type="monotone"
          fill="var(--color-ca)"
          fillOpacity={0.15}
          stroke="var(--color-ca)"
        />
      </AreaChart>
    </ChartContainer>
  );
}

function ExecutiveSection() {
  const { computed, state } = useErp();
  const p = state.parametres;
  const [selectedObjectif, setSelectedObjectif] = useState<
    (typeof computed.objectifs)[number] | null
  >(null);
  const [selectedFinRow, setSelectedFinRow] = useState<{
    label: string;
    value: string;
    lecture: string;
  } | null>(null);
  const finRows = [
    {
      label: "Chiffre d'affaires",
      value: fcFormat(computed.ca),
      lecture: "Brut — calculé automatiquement, somme des ventes.",
    },
    {
      label: "Encaissements",
      value: fcFormat(computed.encaissements),
      lecture: "Trésorerie reçue — calculé automatiquement.",
    },
    {
      label: "Créances clients",
      value: fcFormat(computed.creances),
      lecture: "À recouvrer — calculé automatiquement : CA − encaissements.",
    },
    {
      label: "Total coûts",
      value: fcFormat(computed.totalCouts),
      lecture: "Exploitation — calculé automatiquement, voir le détail dans Finances.",
    },
    {
      label: "Résultat brut",
      value: fcFormat(computed.resultatBrut),
      lecture: "Avant impôt et amortissement — calculé automatiquement : CA − coûts.",
    },
    {
      label: "Marge brute",
      value: pctFormat(computed.margeBrute),
      lecture: "Résultat / CA — calculé automatiquement.",
    },
    {
      label: "Rendement sur coûts",
      value: pctFormat(computed.rendementSurCouts),
      lecture: "Résultat / coûts — calculé automatiquement.",
    },
  ];
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
          description="Calculé automatiquement : somme des quantités reçues (Approvisionnement)."
        />
        <KpiTile
          label="Ananas transformés"
          objectif={p.objectifAnanasKg}
          realise={Math.round(computed.kgTransformes)}
          unit="kg"
          taux={computed.kgTransformes / p.objectifAnanasKg}
          description="Calculé automatiquement : somme des kg utilisés sur tous les lots (Production)."
        />
        <KpiTile
          label="Bouteilles produites"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesProduites}
          taux={computed.bouteillesProduites / p.objectifBouteilles}
          description="Calculé automatiquement : somme des bouteilles conditionnées (500/330/300 ml) sur tous les lots (Production)."
        />
        <KpiTile
          label="Bouteilles vendues"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesVendues}
          taux={computed.bouteillesVendues / p.objectifBouteilles}
          description="Calculé automatiquement : somme des quantités du Journal des ventes (Commercialisation)."
        />
        <KpiTile
          label="Chiffre d'affaires"
          realise={fcFormat(computed.ca)}
          description="Calculé automatiquement : somme des montants bruts de toutes les ventes."
        />
        <KpiTile
          label="Résultat brut"
          realise={fcFormat(computed.resultatBrut)}
          description="Calculé automatiquement : chiffre d'affaires − total des coûts d'exploitation (voir Finances)."
        />
        <KpiTile
          label="Clients actifs"
          objectif={p.objectifClients}
          realise={computed.clientsActifs}
          taux={computed.clientsActifs / p.objectifClients}
          description="Calculé automatiquement : nombre de clients distincts ayant au moins une vente enregistrée."
        />
        <KpiTile
          label="Marge brute"
          objectif={pctFormat(p.objectifMargeBrute)}
          realise={pctFormat(computed.margeBrute)}
          taux={computed.margeBrute / p.objectifMargeBrute}
          description="Calculé automatiquement : résultat brut / chiffre d'affaires."
        />
      </div>

      <Card title="Évolution de la campagne">
        <TrendChart production={computed.production} ventes={computed.ventes} />
      </Card>

      <Card title="Synthèse par domaine (objectifs ERP)">
        <Table
          onRowClick={(i) => setSelectedObjectif(computed.objectifs[i])}
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

      {selectedObjectif && (
        <RecordDetailModal
          title={selectedObjectif.label}
          subtitle={`Responsable · ${selectedObjectif.responsable}`}
          onClose={() => setSelectedObjectif(null)}
          fields={[
            {
              label: "Objectif",
              value:
                selectedObjectif.unite === "%"
                  ? pctFormat(selectedObjectif.objectif)
                  : `${selectedObjectif.objectif} ${selectedObjectif.unite === "kg" ? "kg" : ""}`.trim(),
              description: "Cible définie dans Paramètres ERP pour la campagne en cours.",
            },
            {
              label: "Réalisé",
              value:
                selectedObjectif.unite === "%"
                  ? pctFormat(selectedObjectif.realise)
                  : Math.round(selectedObjectif.realise * 100) / 100,
              description:
                "Calculé automatiquement à partir des collections du module concerné (Approvisionnement, Production, Ventes, etc.).",
            },
            {
              label: "Taux",
              value: pctFormat(selectedObjectif.taux),
              description: "Calculé automatiquement : réalisé / objectif.",
            },
            {
              label: "Statut",
              value: selectedObjectif.statut,
              description:
                "Dérivé automatiquement du taux — aucune ligne Firestore unique, rien à modifier ici.",
            },
          ]}
        />
      )}

      <Card title="Synthèse financière (hors amortissement)">
        <Table
          onRowClick={(i) => setSelectedFinRow(finRows[i])}
          headers={["Indicateur", "Valeur", "Lecture"]}
          rows={finRows.map((r) => [r.label, r.value, r.lecture])}
        />
      </Card>

      {selectedFinRow && (
        <RecordDetailModal
          title={selectedFinRow.label}
          onClose={() => setSelectedFinRow(null)}
          fields={[
            { label: "Valeur", value: selectedFinRow.value, description: selectedFinRow.lecture },
          ]}
        />
      )}
    </div>
  );
}

function ApproSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const p = state.parametres;
  const [selectedAppro, setSelectedAppro] = useState<(typeof computed.appro)[number] | null>(null);
  const [selectedProducteur, setSelectedProducteur] = useState<
    (typeof state.producteurs)[number] | null
  >(null);
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
          onRowClick={(i) => setSelectedAppro(computed.appro[i])}
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
            <DeleteButton
              onClick={(e) => {
                e.stopPropagation();
                removeRow("approvisionnements", r.id);
              }}
            />,
          ])}
        />
      </Card>

      {selectedAppro && (
        <RecordDetailModal
          title={`Réception ${selectedAppro.numero}`}
          subtitle={selectedAppro.date}
          onClose={() => setSelectedAppro(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "approvisionnements", selectedAppro.id), patch);
            setSelectedAppro(null);
          }}
          onDelete={() => {
            removeRow("approvisionnements", selectedAppro.id);
            setSelectedAppro(null);
          }}
          fields={[
            {
              label: "N° réception",
              value: selectedAppro.numero,
              description: "Identifiant attribué à cette réception de marchandise.",
              edit: { key: "numero", type: "text", value: selectedAppro.numero },
            },
            {
              label: "Date",
              value: selectedAppro.date,
              description:
                "Date de la réception, saisie dans le formulaire « Nouvelle réception ».",
              edit: { key: "date", type: "date", value: selectedAppro.date },
            },
            {
              label: "ID producteur",
              value: selectedAppro.idProducteur,
              description:
                "Identifiant du producteur fournisseur, lié au Registre des producteurs.",
              edit: { key: "idProducteur", type: "text", value: selectedAppro.idProducteur },
            },
            {
              label: "Fournisseur",
              value: selectedAppro.fournisseur,
              description: "Nom du fournisseur ayant livré cette réception.",
              edit: { key: "fournisseur", type: "text", value: selectedAppro.fournisseur },
            },
            {
              label: "Village",
              value: selectedAppro.village,
              description: "Village d'origine de la livraison.",
              edit: { key: "village", type: "text", value: selectedAppro.village },
            },
            {
              label: "Quantité commandée",
              value: `${selectedAppro.qteCommandeeKg} kg`,
              description: "Quantité commandée auprès du producteur, en kilogrammes.",
              edit: {
                key: "qteCommandeeKg",
                type: "number",
                value: String(selectedAppro.qteCommandeeKg),
              },
            },
            {
              label: "Quantité reçue",
              value: `${selectedAppro.qteRecueKg} kg`,
              description: "Quantité effectivement reçue et pesée à la livraison, en kilogrammes.",
              edit: { key: "qteRecueKg", type: "number", value: String(selectedAppro.qteRecueKg) },
            },
            {
              label: "Prix / kg",
              value: fcFormat(selectedAppro.prixKg),
              description: "Prix négocié par kilogramme, en FC.",
              edit: { key: "prixKg", type: "number", value: String(selectedAppro.prixKg) },
            },
            {
              label: "Transport",
              value: fcFormat(selectedAppro.transport),
              description: "Coût du transport de la marchandise jusqu'au site, en FC.",
              edit: { key: "transport", type: "number", value: String(selectedAppro.transport) },
            },
            {
              label: "Autres frais",
              value: fcFormat(selectedAppro.autresFrais),
              description: "Autres frais liés à la réception (manutention, etc.), en FC.",
              edit: {
                key: "autresFrais",
                type: "number",
                value: String(selectedAppro.autresFrais),
              },
            },
            {
              label: "Qualité",
              value: selectedAppro.qualite,
              description: "Résultat du contrôle qualité effectué à la réception.",
              edit: {
                key: "qualite",
                type: "select",
                options: QUALITES,
                value: selectedAppro.qualite,
              },
            },
            {
              label: "Valeur achat",
              value: fcFormat(selectedAppro.valeurAchat),
              description: "Calculé automatiquement : quantité reçue × prix/kg.",
            },
            {
              label: "Coût total",
              value: fcFormat(selectedAppro.coutTotal),
              description:
                "Calculé automatiquement : valeur d'achat + transport + autres frais — ce montant alimente les coûts d'exploitation en Finances.",
            },
          ]}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Fournisseurs actifs"
          objectif={1}
          realise={state.producteurs.length}
          taux={state.producteurs.length / 1}
          description="Calculé automatiquement : nombre de fiches dans le Registre des producteurs."
        />
        <KpiTile
          label="Quantité reçue"
          objectif={p.objectifAnanasKg}
          realise={Math.round(computed.kgAchetes)}
          unit="kg"
          taux={computed.kgAchetes / p.objectifAnanasKg}
          description="Calculé automatiquement : somme des quantités reçues sur toutes les réceptions."
        />
        <KpiTile
          label="Coût matière"
          realise={fcFormat(computed.coutAchats)}
          description="Calculé automatiquement : somme des valeurs d'achat (quantité reçue × prix/kg) sur toutes les réceptions."
        />
        <KpiTile
          label="Transport & frais"
          realise={fcFormat(computed.coutTransport)}
          description="Calculé automatiquement : somme du transport et autres frais sur toutes les réceptions."
        />
      </div>

      <Card title="Registre des producteurs">
        <Table
          onRowClick={(i) => setSelectedProducteur(state.producteurs[i])}
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

      {selectedProducteur && (
        <RecordDetailModal
          title={selectedProducteur.nom}
          subtitle={`Producteur ${selectedProducteur.id}`}
          onClose={() => setSelectedProducteur(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "producteurs", selectedProducteur.id), patch);
            setSelectedProducteur(null);
          }}
          onDelete={() => {
            removeRow("producteurs", selectedProducteur.id);
            setSelectedProducteur(null);
          }}
          fields={[
            {
              label: "Nom / Association",
              value: selectedProducteur.nom,
              description: "Nom du producteur ou de l'association fournisseur, saisi au Registre.",
              edit: { key: "nom", type: "text", value: selectedProducteur.nom },
            },
            {
              label: "Village",
              value: selectedProducteur.village,
              description: "Village où se trouve l'exploitation.",
              edit: { key: "village", type: "text", value: selectedProducteur.village },
            },
            {
              label: "Territoire",
              value: selectedProducteur.territoire,
              description: "Territoire administratif de rattachement.",
              edit: { key: "territoire", type: "text", value: selectedProducteur.territoire },
            },
            {
              label: "Téléphone",
              value: selectedProducteur.telephone,
              description: "Numéro de contact du producteur.",
              edit: { key: "telephone", type: "text", value: selectedProducteur.telephone },
            },
            {
              label: "Capacité (kg/mois)",
              value: selectedProducteur.capaciteKgMois,
              description: "Capacité de production mensuelle déclarée, en kilogrammes.",
              edit: {
                key: "capaciteKgMois",
                type: "number",
                value: String(selectedProducteur.capaciteKgMois),
              },
            },
            {
              label: "Prix convenu",
              value: fcFormat(selectedProducteur.prixConvenu),
              description: "Prix par kilogramme convenu avec ce producteur, en FC.",
              edit: {
                key: "prixConvenu",
                type: "number",
                value: String(selectedProducteur.prixConvenu),
              },
            },
            {
              label: "Statut",
              value: selectedProducteur.statut,
              description: "Statut de la relation avec ce producteur.",
              edit: { key: "statut", type: "text", value: selectedProducteur.statut },
            },
          ]}
        />
      )}
    </div>
  );
}

function ProductionSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const { profile } = useAuth();
  const p = state.parametres;
  const [selectedLot, setSelectedLot] = useState<(typeof computed.production)[number] | null>(null);
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
          description="Calculé automatiquement : somme des bouteilles conditionnées (500/330/300 ml) sur tous les lots."
        />
        <KpiTile
          label="Rendement volume"
          objectif="95 %"
          realise={pctFormat(computed.rendementMoyen)}
          taux={computed.rendementMoyen / 0.95}
          description="Calculé automatiquement : volume conditionné / volume de jus, moyenné sur tous les lots."
        />
        <KpiTile
          label="Pertes volume"
          objectif={pctFormat(p.tauxPertesMax)}
          realise={pctFormat(computed.tauxPertes)}
          description="Calculé automatiquement : volume perdu / volume de jus, comparé au taux maximum toléré (Paramètres ERP)."
        />
        <KpiTile
          label="Valeur production"
          realise={fcFormat(computed.valeurProduction)}
          description="Calculé automatiquement : quantités par format × prix de vente définis dans Paramètres ERP, sommé sur tous les lots."
        />
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
                // Auto-filled from the logged-in staff member — one less
                // field to type, and reliable enough (a real uid) to power
                // per-person bonus tracking (sprint 17), unlike matching on
                // free-text names.
                responsable: profile?.displayName || profile?.email || "Équipe production",
                ...(profile?.uid ? { staffUid: profile.uid } : {}),
                statut: v.statut,
              })
            }
          />
        }
      >
        <Table
          onRowClick={(i) => setSelectedLot(computed.production[i])}
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
            <DeleteButton
              onClick={(e) => {
                e.stopPropagation();
                removeRow("productions", r.id);
              }}
            />,
          ])}
        />
      </Card>

      <Card title="Contrôle qualité par lot">
        <Table
          onRowClick={(i) => setSelectedLot(computed.production[i])}
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

      {selectedLot && (
        <RecordDetailModal
          title={`Lot ${selectedLot.lot}`}
          subtitle={selectedLot.date}
          onClose={() => setSelectedLot(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "productions", selectedLot.id), patch);
            setSelectedLot(null);
          }}
          onDelete={() => {
            removeRow("productions", selectedLot.id);
            setSelectedLot(null);
          }}
          fields={[
            {
              label: "N° lot",
              value: selectedLot.lot,
              description: "Identifiant du lot, saisi dans le formulaire « Nouveau lot ».",
              edit: { key: "lot", type: "text", value: selectedLot.lot },
            },
            {
              label: "Date",
              value: selectedLot.date,
              description: "Date de production du lot.",
              edit: { key: "date", type: "date", value: selectedLot.date },
            },
            {
              label: "Kg ananas utilisés",
              value: selectedLot.kgUtilises,
              description: "Quantité d'ananas transformée pour ce lot, en kilogrammes.",
              edit: { key: "kgUtilises", type: "number", value: String(selectedLot.kgUtilises) },
            },
            {
              label: "Volume jus (L)",
              value: selectedLot.volumeJusL,
              description: "Volume de jus extrait avant conditionnement, en litres.",
              edit: { key: "volumeJusL", type: "number", value: String(selectedLot.volumeJusL) },
            },
            {
              label: "500 ml produits",
              value: selectedLot.q500,
              description: "Nombre de bouteilles de 500 ml conditionnées pour ce lot.",
              edit: { key: "q500", type: "number", value: String(selectedLot.q500) },
            },
            {
              label: "330 ml produits",
              value: selectedLot.q330,
              description: "Nombre de bouteilles de 330 ml conditionnées pour ce lot.",
              edit: { key: "q330", type: "number", value: String(selectedLot.q330) },
            },
            {
              label: "300 ml produits",
              value: selectedLot.q300,
              description: "Nombre de bouteilles de 300 ml conditionnées pour ce lot.",
              edit: { key: "q300", type: "number", value: String(selectedLot.q300) },
            },
            {
              label: "Rejets",
              value: selectedLot.rejets,
              description: "Bouteilles rejetées au contrôle qualité de ce lot.",
              edit: { key: "rejets", type: "number", value: String(selectedLot.rejets) },
            },
            {
              label: "Statut",
              value: selectedLot.statut,
              description: "Avancement de ce lot de production.",
              edit: {
                key: "statut",
                type: "select",
                options: ["En cours", "Terminé"],
                value: selectedLot.statut,
              },
            },
            {
              label: "Responsable",
              value: selectedLot.responsable,
              description:
                "Auto-attribué au compte staff connecté lors de la saisie (sprint 17) — sert au calcul des primes de production par personne.",
            },
            {
              label: "Total bouteilles",
              value: selectedLot.totalBouteilles,
              description: "Calculé automatiquement : somme des formats 500/330/300 ml.",
            },
            {
              label: "Conditionné (L)",
              value: selectedLot.volumeConditionne.toFixed(2),
              description:
                "Calculé automatiquement à partir des quantités par format (0,5 L / 0,33 L / 0,3 L par bouteille).",
            },
            {
              label: "Pertes (L)",
              value: selectedLot.pertesL.toFixed(2),
              description: "Calculé automatiquement : volume de jus − volume conditionné.",
            },
            {
              label: "Rendement",
              value: pctFormat(selectedLot.rendement),
              description: "Calculé automatiquement : volume conditionné / volume de jus.",
            },
            {
              label: "Valeur production",
              value: fcFormat(selectedLot.valeurProduction),
              description:
                "Calculé automatiquement à partir des prix de vente par format définis dans Paramètres ERP.",
            },
          ]}
        />
      )}
    </div>
  );
}

function StockSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const [selectedMouvement, setSelectedMouvement] = useState<{
    m: (typeof state.stockMP)[number];
    cumul: number;
  } | null>(null);
  const [selectedStockPF, setSelectedStockPF] = useState<(typeof computed.stockPF)[number] | null>(
    null,
  );
  let cumul = 0;
  const stockRows = state.stockMP.map((m) => {
    cumul += m.entree - m.sortie;
    return { m, cumul };
  });
  return (
    <div className="space-y-6">
      <SectionHeader eyebrow="Module ERP 03" title="Stocks" responsable="Production / Magasin" />
      <ExportBar section="stock" />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Stock matières premières"
          realise={computed.stockMPPieces}
          unit="pcs"
          description="Calculé automatiquement : cumul chronologique des entrées − sorties (Mouvements matières premières)."
        />
        <KpiTile
          label="Valeur stock MP"
          realise={fcFormat(computed.stockMPValeur)}
          description="Calculé automatiquement : stock cumulé × coût unitaire du dernier mouvement."
        />
        <KpiTile
          label="Stock produits finis"
          realise={computed.stockPF.reduce((a, s) => a + s.stock, 0)}
          unit="bt"
          description="Calculé automatiquement : bouteilles produites − vendues, tous formats confondus."
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
          onRowClick={(i) => setSelectedMouvement(stockRows[i])}
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
          rows={stockRows.map(({ m, cumul: c }) => [
            m.date,
            m.produit,
            m.type,
            m.entree || "",
            m.sortie || "",
            c,
            fcFormat(m.coutUnitaire),
            fcFormat(c * m.coutUnitaire),
            m.observation,
            <DeleteButton
              onClick={(e) => {
                e.stopPropagation();
                removeRow("stockMP", m.id);
              }}
            />,
          ])}
        />
      </Card>

      {selectedMouvement && (
        <RecordDetailModal
          title={`${selectedMouvement.m.type} — ${selectedMouvement.m.produit}`}
          subtitle={selectedMouvement.m.date}
          onClose={() => setSelectedMouvement(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "stockMP", selectedMouvement.m.id), patch);
            setSelectedMouvement(null);
          }}
          onDelete={() => {
            removeRow("stockMP", selectedMouvement.m.id);
            setSelectedMouvement(null);
          }}
          fields={[
            {
              label: "Date",
              value: selectedMouvement.m.date,
              description:
                "Date du mouvement — trie le tableau chronologiquement (sprint 18), d'où dépend le stock cumulé.",
              edit: { key: "date", type: "date", value: selectedMouvement.m.date },
            },
            {
              label: "Produit",
              value: selectedMouvement.m.produit,
              description: "Produit concerné par ce mouvement de stock.",
              edit: { key: "produit", type: "text", value: selectedMouvement.m.produit },
            },
            {
              label: "Type",
              value: selectedMouvement.m.type,
              description: "Nature du mouvement : entrée, sortie ou ajustement d'inventaire.",
              edit: {
                key: "type",
                type: "select",
                options: ["Entrée", "Sortie", "Ajustement"],
                value: selectedMouvement.m.type,
              },
            },
            {
              label: "Quantité entrée",
              value: selectedMouvement.m.entree,
              description: "Quantité ajoutée au stock par ce mouvement.",
              edit: { key: "entree", type: "number", value: String(selectedMouvement.m.entree) },
            },
            {
              label: "Quantité sortie",
              value: selectedMouvement.m.sortie,
              description: "Quantité retirée du stock par ce mouvement.",
              edit: { key: "sortie", type: "number", value: String(selectedMouvement.m.sortie) },
            },
            {
              label: "Coût unitaire",
              value: fcFormat(selectedMouvement.m.coutUnitaire),
              description: "Coût unitaire retenu pour valoriser ce mouvement, en FC.",
              edit: {
                key: "coutUnitaire",
                type: "number",
                value: String(selectedMouvement.m.coutUnitaire),
              },
            },
            {
              label: "Observation",
              value: selectedMouvement.m.observation || "—",
              description: "Note libre saisie avec ce mouvement.",
              edit: {
                key: "observation",
                type: "text",
                value: selectedMouvement.m.observation ?? "",
              },
            },
            {
              label: "Stock cumulé",
              value: selectedMouvement.cumul,
              description:
                "Calculé automatiquement : somme des entrées − sorties de tous les mouvements jusqu'à celui-ci, par ordre chronologique.",
            },
          ]}
        />
      )}

      <Card title="Stock produits finis (production − ventes)">
        <Table
          onRowClick={(i) => setSelectedStockPF(computed.stockPF[i])}
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

      {selectedStockPF && (
        <RecordDetailModal
          title={`Stock produits finis — ${selectedStockPF.format}`}
          onClose={() => setSelectedStockPF(null)}
          fields={[
            {
              label: "Format",
              value: selectedStockPF.format,
              description: "Format de bouteille (500 ml / 330 ml / 300 ml).",
            },
            {
              label: "Produites",
              value: selectedStockPF.produites,
              description:
                "Calculé automatiquement : somme des quantités de ce format sur tous les lots de Production.",
            },
            {
              label: "Vendues",
              value: selectedStockPF.vendues,
              description:
                "Calculé automatiquement : somme des quantités de ce format dans le Journal des ventes.",
            },
            {
              label: "Stock",
              value: selectedStockPF.stock,
              description:
                "Calculé automatiquement : produites − vendues. Aucune ligne Firestore unique ne correspond à ce chiffre — rien à modifier ou supprimer ici directement.",
            },
            {
              label: "Valeur stock",
              value: fcFormat(selectedStockPF.valeur),
              description:
                "Calculé automatiquement : stock × prix de vente de ce format (Paramètres ERP).",
            },
          ]}
        />
      )}
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
  description?: string;
}

type ProductDraft = { name: string; format: Format; price: string; description: string };

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
              next[p.id] = {
                name: p.name,
                format: p.format,
                price: String(p.price),
                description: p.description ?? "",
              };
          }
          return next;
        });
      },
      (err) => toast.error(`Synchronisation "catalogue" impossible : ${err.message}`),
    );
  }, []);

  const draftFor = (p: Product): ProductDraft =>
    drafts[p.id] ?? {
      name: p.name,
      format: p.format,
      price: String(p.price),
      description: p.description ?? "",
    };

  const setDraft = (id: string, patch: Partial<ProductDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const saveProduct = (p: Product) => {
    const draft = draftFor(p);
    updateDoc(doc(db, "products", p.id), {
      name: draft.name.trim() || p.name,
      format: draft.format,
      price: n(draft.price),
      description: draft.description.trim(),
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
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft(p.id, { description: e.target.value })}
                  placeholder="Description affichée sur la fiche produit de la boutique (optionnel)"
                  rows={2}
                  className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70"
                />
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
  partnerPhone?: string;
  partnerAddress?: string;
  items: StorefrontOrderItem[];
  total: number;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  createdAt: string;
  fulfilledAt?: string;
  deliveryDate?: string;
  payment?: { method: "pawapay" | "cash_on_delivery"; status: "pending" | "completed" };
}

/**
 * Confirming/fulfilling a storefront order didn't create a `ventes` row, so
 * storefront sales never reached the dashboard's commercial KPIs. Marking an
 * order "livrée" now atomically closes it out and writes one `ventes` row
 * per line item — deterministic doc IDs (`VTE-ORD-<orderId>-<idx>`) make the
 * write idempotent if it's ever retried.
 */

interface Promo {
  active: boolean;
  headline: string;
  description: string;
  productId: string;
  startDate: string;
  endDate: string;
}

const EMPTY_PROMO: Promo = {
  active: false,
  headline: "",
  description: "",
  productId: "",
  startDate: "",
  endDate: "",
};

/**
 * Single active-or-not promo (sprint 06) — a `config/promo` singleton,
 * mirroring the existing `config/parametres` pattern. Deliberately no
 * rotation/scheduling queue: v1 ships with exactly one promo, matching
 * how a small operation actually runs a promotion.
 */
function PromoCard() {
  const [promo, setPromo] = useState<Promo>(EMPTY_PROMO);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    return onSnapshot(
      doc(db, "config", "promo"),
      (snap) => setPromo(snap.exists() ? { ...EMPTY_PROMO, ...snap.data() } : EMPTY_PROMO),
      (err) => toast.error(`Synchronisation "promo" impossible : ${err.message}`),
    );
  }, []);

  useEffect(() => {
    return onSnapshot(collection(db, "products"), (snap) => {
      setProducts(snap.docs.map((d) => d.data() as { id: string; name: string }));
    });
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, "config", "promo"), promo);
      toast.success("Promotion enregistrée.");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Enregistrement impossible : ${err.message}`
          : "Enregistrement impossible.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Promotion boutique">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={promo.active}
            onChange={(e) => setPromo((p) => ({ ...p, active: e.target.checked }))}
            className="h-4 w-4 rounded border-border"
          />
          Promotion active
        </label>
        <input
          value={promo.headline}
          onChange={(e) => setPromo((p) => ({ ...p, headline: e.target.value }))}
          placeholder="Titre (ex. -10% sur les bouteilles 500 ml)"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
        <textarea
          value={promo.description}
          onChange={(e) => setPromo((p) => ({ ...p, description: e.target.value }))}
          placeholder="Description (optionnel)"
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <select
            value={promo.productId}
            onChange={(e) => setPromo((p) => ({ ...p, productId: e.target.value }))}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="">Aucun produit lié</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={promo.startDate}
            onChange={(e) => setPromo((p) => ({ ...p, startDate: e.target.value }))}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
          <input
            type="date"
            value={promo.endDate}
            onChange={(e) => setPromo((p) => ({ ...p, endDate: e.target.value }))}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
    </Card>
  );
}

function OrdersCard() {
  const [orders, setOrders] = useState<StorefrontOrder[]>([]);
  const [confirmDates, setConfirmDates] = useState<Record<string, string>>({});
  const [selectedOrder, setSelectedOrder] = useState<StorefrontOrder | null>(null);

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

  const confirmWithDeliveryDate = (id: string) =>
    updateDoc(doc(db, "orders", id), {
      status: "confirmed",
      ...(confirmDates[id] ? { deliveryDate: confirmDates[id] } : {}),
    }).catch((err) => toast.error(`Mise à jour de la commande impossible : ${err.message}`));

  const fulfillAndConvert = async (order: StorefrontOrder) => {
    const batch = writeBatch(db);
    batch.update(doc(db, "orders", order.id), {
      status: "fulfilled",
      fulfilledAt: new Date().toISOString(),
    });
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
        onRowClick={(i) => setSelectedOrder(orders[i])}
        headers={[
          "Date",
          "Partenaire",
          "Livraison",
          "Articles",
          "Total",
          "Paiement",
          "Statut",
          "Actions",
        ]}
        rows={orders.map((o) => [
          new Date(o.createdAt).toLocaleDateString("fr-FR"),
          o.partnerName,
          <div className="text-xs">
            <p>{o.partnerPhone ? `+${o.partnerPhone}` : "—"}</p>
            {o.partnerAddress && <p className="text-muted-foreground">{o.partnerAddress}</p>}
            {o.deliveryDate && (
              <p className="mt-0.5 font-medium text-primary">
                Livraison : {formatDateOnly(o.deliveryDate)}
              </p>
            )}
          </div>,
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
          <div className="flex flex-col items-start gap-1.5" onClick={(e) => e.stopPropagation()}>
            {o.status === "pending" && (
              <>
                <input
                  type="date"
                  value={confirmDates[o.id] ?? ""}
                  onChange={(e) => setConfirmDates((d) => ({ ...d, [o.id]: e.target.value }))}
                  className="rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                  aria-label="Date de livraison"
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => confirmWithDeliveryDate(o.id)}
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
                </div>
              </>
            )}
            {o.status === "confirmed" && (
              <div className="flex gap-3">
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
              </div>
            )}
          </div>,
        ])}
      />

      {selectedOrder && (
        <RecordDetailModal
          title={`Commande de ${selectedOrder.partnerName}`}
          subtitle={new Date(selectedOrder.createdAt).toLocaleDateString("fr-FR")}
          onClose={() => setSelectedOrder(null)}
          fields={[
            {
              label: "Partenaire",
              value: selectedOrder.partnerName,
              description: "Boutique partenaire ayant passé la commande depuis /storefront.",
            },
            {
              label: "Contact",
              value: `${selectedOrder.partnerPhone ? `+${selectedOrder.partnerPhone}` : "—"}`,
              description:
                "Téléphone du partenaire au moment de la commande — figé (snapshot), ne change pas si le profil du partenaire est modifié ensuite.",
            },
            {
              label: "Adresse de livraison",
              value: selectedOrder.partnerAddress || "—",
              description: "Adresse du partenaire au moment de la commande, également figée.",
            },
            {
              label: "Articles",
              value: (
                <ul className="space-y-1">
                  {selectedOrder.items.map((i) => (
                    <li key={i.productId}>
                      {i.quantity} × {i.name} ({i.format}) — {fcFormat(i.quantity * i.unitPrice)}
                    </li>
                  ))}
                </ul>
              ),
              description: "Nom, format et prix unitaire figés au moment de la commande.",
            },
            {
              label: "Total",
              value: fcFormat(selectedOrder.total),
              description: "Montant total de la commande.",
            },
            {
              label: "Paiement",
              value: !selectedOrder.payment
                ? "—"
                : selectedOrder.payment.method === "cash_on_delivery"
                  ? "Paiement à la livraison"
                  : `Mobile money (${selectedOrder.payment.status === "completed" ? "réglé" : "en attente"})`,
              description: "Méthode choisie par le partenaire au moment du paiement.",
            },
            {
              label: "Statut",
              value: ORDER_STATUS_LABELS[selectedOrder.status],
              description:
                "Modifiable uniquement via les actions Confirmer / Marquer livrée / Annuler du tableau — la conversion en ventes à la livraison dépend de cette transition, donc pas d'édition libre ici.",
            },
            ...(selectedOrder.deliveryDate
              ? [
                  {
                    label: "Date de livraison prévue",
                    value: formatDateOnly(selectedOrder.deliveryDate),
                    description: "Fixée à la main par l'admin lors de la confirmation.",
                  },
                ]
              : []),
          ]}
        />
      )}
    </Card>
  );
}

function CommercialisationSection({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const { state, computed, addRow, removeRow } = useErp();
  const { profile } = useAuth();
  const p = state.parametres;
  const [selectedVente, setSelectedVente] = useState<(typeof computed.ventes)[number] | null>(null);
  const [selectedCanal, setSelectedCanal] = useState<Canal | null>(null);
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 04"
        title="Ventes & encaissements"
        responsable="Chargée de Commercialisation"
      />
      <ExportBar section="commercialisation" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Bouteilles vendues"
          objectif={p.objectifBouteilles}
          realise={computed.bouteillesVendues}
          taux={computed.bouteillesVendues / p.objectifBouteilles}
          description="Calculé automatiquement : somme des quantités du Journal des ventes."
        />
        <KpiTile
          label="Chiffre d'affaires"
          realise={fcFormat(computed.ca)}
          description="Calculé automatiquement : somme des montants bruts de toutes les ventes."
        />
        <KpiTile
          label="Taux d'encaissement"
          objectif="100 %"
          realise={pctFormat(computed.tauxEncaissement)}
          taux={computed.tauxEncaissement}
          description="Calculé automatiquement : encaissements / chiffre d'affaires brut."
        />
        <KpiTile
          label="Créances clients"
          realise={fcFormat(computed.creances)}
          description="Calculé automatiquement : chiffre d'affaires − encaissements, ce qui reste dû par les clients."
        />
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
          <TabsTrigger value="promotions">Promotions</TabsTrigger>
          <TabsTrigger value="commandes">Commandes</TabsTrigger>
          <TabsTrigger value="ventes">Ventes & clients</TabsTrigger>
        </TabsList>
        <TabsContent value="catalogue">
          <CatalogueCard />
        </TabsContent>
        <TabsContent value="promotions">
          <PromoCard />
        </TabsContent>
        <TabsContent value="commandes">
          <OrdersCard />
        </TabsContent>
        <TabsContent value="ventes" className="space-y-6">
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
                    // Auto-filled from the logged-in staff member — see the
                    // matching note in ProductionSection.
                    commerciale: profile?.displayName || profile?.email || "Équipe commerciale",
                    ...(profile?.uid ? { staffUid: profile.uid } : {}),
                  })
                }
              />
            }
          >
            <Table
              onRowClick={(i) => setSelectedVente(computed.ventes[i])}
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
                <DeleteButton
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRow("ventes", v.id);
                  }}
                />,
              ])}
            />
          </Card>

          {selectedVente && (
            <RecordDetailModal
              title={`Vente ${selectedVente.numero}`}
              subtitle={selectedVente.date}
              onClose={() => setSelectedVente(null)}
              onSave={(patch) => {
                updateDoc(doc(db, "ventes", selectedVente.id), patch);
                setSelectedVente(null);
              }}
              onDelete={() => {
                removeRow("ventes", selectedVente.id);
                setSelectedVente(null);
              }}
              fields={[
                {
                  label: "N° vente",
                  value: selectedVente.numero,
                  description:
                    "Identifiant de la vente, saisi dans le formulaire « Nouvelle vente ».",
                  edit: { key: "numero", type: "text", value: selectedVente.numero },
                },
                {
                  label: "Date",
                  value: selectedVente.date,
                  description: "Date de la vente.",
                  edit: { key: "date", type: "date", value: selectedVente.date },
                },
                {
                  label: "Client",
                  value: selectedVente.client,
                  description:
                    "Nom du client — texte libre, non relié au Registre clients interne.",
                  edit: { key: "client", type: "text", value: selectedVente.client },
                },
                {
                  label: "Canal",
                  value: selectedVente.canal,
                  description: "Circuit de vente utilisé pour cette transaction.",
                  edit: {
                    key: "canal",
                    type: "select",
                    options: CANAUX,
                    value: selectedVente.canal,
                  },
                },
                {
                  label: "Format",
                  value: selectedVente.format,
                  description: "Format de bouteille vendu.",
                  edit: {
                    key: "format",
                    type: "select",
                    options: FORMATS,
                    value: selectedVente.format,
                  },
                },
                {
                  label: "Quantité",
                  value: selectedVente.quantite,
                  description: "Nombre de bouteilles vendues.",
                  edit: { key: "quantite", type: "number", value: String(selectedVente.quantite) },
                },
                {
                  label: "Prix unitaire",
                  value: fcFormat(selectedVente.prixUnitaire),
                  description: "Prix unitaire appliqué à cette vente, en FC.",
                  edit: {
                    key: "prixUnitaire",
                    type: "number",
                    value: String(selectedVente.prixUnitaire),
                  },
                },
                {
                  label: "Remise",
                  value: fcFormat(selectedVente.remise),
                  description: "Remise accordée sur cette vente, en FC.",
                  edit: { key: "remise", type: "number", value: String(selectedVente.remise) },
                },
                {
                  label: "Encaissé",
                  value: fcFormat(selectedVente.encaisse),
                  description:
                    "Montant réellement encaissé — s'il est inférieur au montant brut, la différence reste en créance client.",
                  edit: { key: "encaisse", type: "number", value: String(selectedVente.encaisse) },
                },
                {
                  label: "Commerciale",
                  value: selectedVente.commerciale,
                  description:
                    "Auto-attribué au compte staff connecté lors de la saisie (sprint 17) — sert au calcul des commissions par personne.",
                },
                {
                  label: "Montant brut",
                  value: fcFormat(selectedVente.montantBrut),
                  description: "Calculé automatiquement : quantité × prix unitaire − remise.",
                },
                {
                  label: "Solde dû",
                  value: fcFormat(selectedVente.soldeDu),
                  description: "Calculé automatiquement : montant brut − encaissé.",
                },
                {
                  label: "Statut paiement",
                  value: selectedVente.statutPaiement,
                  description: "Calculé automatiquement à partir du solde dû.",
                },
              ]}
            />
          )}

          <Card title="Portefeuille clients par canal">
            <Table
              onRowClick={(i) => setSelectedCanal(CANAUX[i])}
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

          {selectedCanal &&
            (() => {
              const rows = computed.ventes.filter((v) => v.canal === selectedCanal);
              return (
                <RecordDetailModal
                  title={`Portefeuille — ${selectedCanal}`}
                  onClose={() => setSelectedCanal(null)}
                  fields={[
                    {
                      label: "Canal",
                      value: selectedCanal,
                      description: "Un des circuits de vente définis dans le modèle ERP.",
                    },
                    {
                      label: "Clients",
                      value: new Set(rows.map((r) => r.client)).size,
                      description:
                        "Calculé automatiquement : nombre de clients distincts ayant acheté sur ce canal.",
                    },
                    {
                      label: "Bouteilles",
                      value: rows.reduce((a, r) => a + r.quantite, 0),
                      description:
                        "Calculé automatiquement : somme des quantités vendues sur ce canal (Journal des ventes).",
                    },
                    {
                      label: "Chiffre d'affaires",
                      value: fcFormat(rows.reduce((a, r) => a + r.montantBrut, 0)),
                      description:
                        "Calculé automatiquement : somme des montants bruts sur ce canal.",
                    },
                    {
                      label: "Encaissé",
                      value: fcFormat(rows.reduce((a, r) => a + r.encaisse, 0)),
                      description:
                        "Calculé automatiquement : somme des montants encaissés sur ce canal.",
                    },
                    {
                      label: "Solde dû",
                      value: fcFormat(rows.reduce((a, r) => a + r.soldeDu, 0)),
                      description:
                        "Calculé automatiquement : créances restantes sur ce canal. Aucune ligne unique — rien à modifier ici ; corrigez la vente concernée dans le Journal des ventes.",
                    },
                  ]}
                />
              );
            })()}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * One stage of the Parcours production funnel (sprint 20). Purely a new
 * way of looking at numbers `useErp()` already computes — no new
 * Firestore fields, no new writes. `pct` is the completion ratio versus
 * the previous stage; `null` renders as "—" (an honest "not started yet"
 * for an early campaign) instead of a misleading 0%/NaN%.
 */
function FunnelStage({
  num,
  title,
  headline,
  unit,
  secondary,
  pct,
  description,
  onView,
}: {
  num: string;
  title: string;
  headline: string | number;
  unit?: string;
  secondary: string;
  pct: number | null;
  description: string;
  onView: () => void;
}) {
  const clampedPct = pct === null ? null : Math.max(0, Math.min(100, Math.round(pct * 100)));
  return (
    <div className="flex-1 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-primary/5 text-[10px] font-bold text-primary">
          {num}
        </span>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
      </div>
      <p className="mt-3 font-display text-2xl font-bold text-primary">
        {headline}
        {unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{secondary}</p>
      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
          {clampedPct !== null && (
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-leaf"
              style={{ width: `${clampedPct}%` }}
            />
          )}
        </div>
        <p className="mt-1 text-right text-[10px] font-semibold text-muted-foreground">
          {pct === null ? "—" : pctFormat(pct)}
        </p>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/80">{description}</p>
      <button onClick={onView} className="mt-3 text-xs font-semibold text-primary hover:underline">
        Voir le détail →
      </button>
    </div>
  );
}

function FunnelArrow() {
  return (
    <div className="hidden items-center justify-center px-1 text-xl text-muted-foreground/60 lg:flex">
      →
    </div>
  );
}

function ParcoursSection({ onNavigate }: { onNavigate: (id: SectionId) => void }) {
  const { state, computed } = useErp();
  const stockActuel = computed.stockPF.reduce((a, s) => a + s.stock, 0);
  const valeurStockFinis = computed.stockPF.reduce((a, s) => a + s.valeur, 0);
  const tauxTransformation = computed.kgAchetes
    ? computed.kgTransformes / computed.kgAchetes
    : null;
  const tauxVenteStock = computed.bouteillesProduites
    ? computed.bouteillesVendues / computed.bouteillesProduites
    : null;

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 05"
        title="Parcours production"
        subtitle="Le produit, de la réception à la vente, en un coup d'œil — aucune nouvelle saisie, uniquement les chiffres déjà calculés par les autres modules"
        responsable="Direction Générale"
      />
      <ExportBar section="parcours" />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        <FunnelStage
          num="01"
          title="Approvisionnement"
          headline={Math.round(computed.kgAchetes)}
          unit="kg"
          secondary={`${state.approvisionnements.length} réception(s)`}
          pct={null}
          description="Ananas reçu des producteurs, pesé à la livraison."
          onView={() => onNavigate("appro")}
        />
        <FunnelArrow />
        <FunnelStage
          num="02"
          title="Production"
          headline={computed.bouteillesProduites}
          unit="bt"
          secondary={`${state.productions.length} lot(s)`}
          pct={tauxTransformation}
          description="Ananas transformé en jus et conditionné en bouteilles — le taux est le kg transformé sur le kg reçu."
          onView={() => onNavigate("production")}
        />
        <FunnelArrow />
        <FunnelStage
          num="03"
          title="Stock"
          headline={stockActuel}
          unit="bt"
          secondary={`Valeur ${fcFormat(valeurStockFinis)}`}
          pct={null}
          description="Bouteilles produites non encore vendues (produites − vendues)."
          onView={() => onNavigate("stock")}
        />
        <FunnelArrow />
        <FunnelStage
          num="04"
          title="Commercialisation"
          headline={computed.bouteillesVendues}
          unit="bt"
          secondary={fcFormat(computed.ca)}
          pct={tauxVenteStock}
          description="Bouteilles vendues, tous canaux confondus — le taux est vendu sur produit."
          onView={() => onNavigate("commercialisation")}
        />
      </div>
    </div>
  );
}

function MarketingSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const [selectedAction, setSelectedAction] = useState<(typeof state.marketing)[number] | null>(
    null,
  );
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 06"
        title="Marketing & prospection"
        responsable="Chargée de Commercialisation"
      />
      <ExportBar section="marketing" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Budget engagé"
          realise={fcFormat(computed.coutMarketing)}
          description="Calculé automatiquement : somme du coût réel de toutes les actions marketing."
        />
        <KpiTile
          label="Contacts touchés"
          realise={computed.contactsTouches}
          description="Calculé automatiquement : somme des contacts touchés sur toutes les actions marketing."
        />
        <KpiTile
          label="Prospects générés"
          realise={computed.prospects}
          description="Calculé automatiquement : somme des prospects générés sur toutes les actions marketing."
        />
        <KpiTile
          label="ROI marketing"
          realise={pctFormat(computed.roiMarketing)}
          description="Calculé automatiquement : (ventes générées − coût réel) / coût réel, sur l'ensemble des actions."
        />
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
          onRowClick={(i) => setSelectedAction(state.marketing[i])}
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
            <DeleteButton
              onClick={(e) => {
                e.stopPropagation();
                removeRow("marketing", m.id);
              }}
            />,
          ])}
        />
      </Card>

      {selectedAction && (
        <RecordDetailModal
          title={selectedAction.numero}
          subtitle={selectedAction.date}
          onClose={() => setSelectedAction(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "marketing", selectedAction.id), patch);
            setSelectedAction(null);
          }}
          onDelete={() => {
            removeRow("marketing", selectedAction.id);
            setSelectedAction(null);
          }}
          fields={[
            {
              label: "ID action",
              value: selectedAction.numero,
              description: "Identifiant de l'action marketing.",
              edit: { key: "numero", type: "text", value: selectedAction.numero },
            },
            {
              label: "Date",
              value: selectedAction.date,
              description: "Date de l'action.",
              edit: { key: "date", type: "date", value: selectedAction.date },
            },
            {
              label: "Campagne",
              value: selectedAction.campagne,
              description: "Campagne marketing à laquelle rattacher cette action.",
              edit: { key: "campagne", type: "text", value: selectedAction.campagne },
            },
            {
              label: "Canal",
              value: selectedAction.canal,
              description: "Canal utilisé pour cette action.",
              edit: {
                key: "canal",
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
                value: selectedAction.canal,
              },
            },
            {
              label: "Cible",
              value: selectedAction.cible,
              description: "Public visé par cette action.",
              edit: { key: "cible", type: "text", value: selectedAction.cible },
            },
            {
              label: "Description",
              value: selectedAction.description || "—",
              description: "Détail libre de l'action.",
              edit: { key: "description", type: "text", value: selectedAction.description ?? "" },
            },
            {
              label: "Budget",
              value: fcFormat(selectedAction.budget),
              description: "Budget alloué à cette action, en FC.",
              edit: { key: "budget", type: "number", value: String(selectedAction.budget) },
            },
            {
              label: "Coût réel",
              value: fcFormat(selectedAction.coutReel),
              description: "Coût réellement dépensé, en FC.",
              edit: { key: "coutReel", type: "number", value: String(selectedAction.coutReel) },
            },
            {
              label: "Contacts touchés",
              value: selectedAction.contacts,
              description: "Nombre de personnes touchées par cette action.",
              edit: { key: "contacts", type: "number", value: String(selectedAction.contacts) },
            },
            {
              label: "Prospects générés",
              value: selectedAction.prospects,
              description: "Nombre de prospects générés par cette action.",
              edit: { key: "prospects", type: "number", value: String(selectedAction.prospects) },
            },
            {
              label: "Ventes générées",
              value: fcFormat(selectedAction.ventesGenerees),
              description: "Chiffre d'affaires attribué à cette action, saisi manuellement.",
              edit: {
                key: "ventesGenerees",
                type: "number",
                value: String(selectedAction.ventesGenerees),
              },
            },
            {
              label: "ROI",
              value: pctFormat(
                selectedAction.coutReel
                  ? (selectedAction.ventesGenerees - selectedAction.coutReel) /
                      selectedAction.coutReel
                  : 0,
              ),
              description: "Calculé automatiquement : (ventes générées − coût réel) / coût réel.",
            },
          ]}
        />
      )}
    </div>
  );
}

function FinancesSection() {
  const { state, computed, addRow, removeRow } = useErp();
  const [selectedCharge, setSelectedCharge] = useState<(typeof state.charges)[number] | null>(null);
  const [selectedRow, setSelectedRow] = useState<{
    card: "revenus" | "couts" | "resultat";
    label: string;
    value: string;
    lecture?: string;
  } | null>(null);
  const revenusRows = [
    {
      label: "Chiffre d'affaires brut",
      value: fcFormat(computed.ca),
      lecture: "Calculé automatiquement : somme des montants bruts de toutes les ventes.",
    },
    {
      label: "Encaissements",
      value: fcFormat(computed.encaissements),
      lecture:
        "Calculé automatiquement : somme des montants réellement encaissés sur toutes les ventes.",
    },
    {
      label: "Créances clients",
      value: fcFormat(computed.creances),
      lecture:
        "Calculé automatiquement : chiffre d'affaires − encaissements, ce qui reste dû par les clients.",
    },
  ];
  const coutsRows = [
    {
      label: "Achats ananas",
      value: fcFormat(computed.coutAchats),
      lecture:
        "Calculé automatiquement : somme des valeurs d'achat de toutes les réceptions (Approvisionnement).",
    },
    {
      label: "Transport et frais",
      value: fcFormat(computed.coutTransport),
      lecture:
        "Calculé automatiquement : somme du transport et autres frais de toutes les réceptions.",
    },
    {
      label: "Autres charges d'exploitation",
      value: fcFormat(computed.autresCharges),
      lecture:
        "Calculé automatiquement : somme des montants « Réalisé » des Charges fixes ci-dessus.",
    },
    {
      label: "Marketing",
      value: fcFormat(computed.coutMarketing),
      lecture: "Calculé automatiquement : somme des coûts réels de toutes les actions marketing.",
    },
    {
      label: "TOTAL COÛTS",
      value: fcFormat(computed.totalCouts),
      lecture: "Calculé automatiquement : somme de toutes les lignes ci-dessus.",
    },
  ];
  const resultatRows = [
    {
      label: "Résultat brut hors amortissement",
      value: fcFormat(computed.resultatBrut),
      lecture: "Calculé automatiquement : chiffre d'affaires − total des coûts.",
    },
    {
      label: "Marge brute",
      value: pctFormat(computed.margeBrute),
      lecture: "Calculé automatiquement : résultat brut / chiffre d'affaires.",
    },
    {
      label: "Rendement sur coûts",
      value: pctFormat(computed.rendementSurCouts),
      lecture: "Calculé automatiquement : résultat brut / total des coûts.",
    },
    {
      label: "Coût moyen / bouteille",
      value: fcFormat(computed.coutMoyenBouteille),
      lecture: "Calculé automatiquement : total des coûts / bouteilles produites.",
    },
    {
      label: "Prix moyen vendu",
      value: fcFormat(computed.prixMoyenVendu),
      lecture: "Calculé automatiquement : chiffre d'affaires / bouteilles vendues.",
    },
    {
      label: "Marge unitaire",
      value: fcFormat(computed.margeUnitaire),
      lecture: "Calculé automatiquement : prix moyen vendu − coût moyen par bouteille.",
    },
    {
      label: "Besoin cycle suivant",
      value: fcFormat(computed.totalCouts),
      lecture:
        "Calculé automatiquement : total des coûts — trésorerie minimum recommandée pour financer la prochaine campagne.",
    },
  ];
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 07"
        title="Finances de campagne"
        subtitle="Analyse hors amortissement"
        responsable="Direction Générale"
      />
      <ExportBar section="finances" />

      <Card
        title="Charges fixes"
        action={
          <EntryForm
            submitLabel="Nouvelle charge"
            fields={[
              { name: "rubrique", label: "Rubrique" },
              { name: "budget", label: "Budget (FC)", type: "number", default: 0 },
              { name: "realise", label: "Réalisé (FC)", type: "number", default: 0 },
            ]}
            onSubmit={(v) =>
              addRow("charges", {
                id: newId("CH"),
                rubrique: v.rubrique,
                budget: n(v.budget),
                realise: n(v.realise),
              })
            }
          />
        }
      >
        <Table
          onRowClick={(i) => setSelectedCharge(state.charges[i])}
          headers={["Rubrique", "Budget", "Réalisé", ""]}
          empty="Aucune charge fixe enregistrée."
          rows={state.charges.map((c) => [
            c.rubrique,
            fcFormat(c.budget),
            fcFormat(c.realise),
            <DeleteButton
              onClick={(e) => {
                e.stopPropagation();
                removeRow("charges", c.id);
              }}
            />,
          ])}
        />
      </Card>

      {selectedCharge && (
        <RecordDetailModal
          title={selectedCharge.rubrique}
          onClose={() => setSelectedCharge(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "charges", selectedCharge.id), patch);
            setSelectedCharge(null);
          }}
          onDelete={() => {
            removeRow("charges", selectedCharge.id);
            setSelectedCharge(null);
          }}
          fields={[
            {
              label: "Rubrique",
              value: selectedCharge.rubrique,
              description: "Intitulé de la charge fixe.",
              edit: { key: "rubrique", type: "text", value: selectedCharge.rubrique },
            },
            {
              label: "Budget",
              value: fcFormat(selectedCharge.budget),
              description: "Montant budgété pour cette charge, en FC.",
              edit: { key: "budget", type: "number", value: String(selectedCharge.budget) },
            },
            {
              label: "Réalisé",
              value: fcFormat(selectedCharge.realise),
              description:
                "Montant réellement dépensé, en FC — alimente « Autres charges d'exploitation » ci-dessous.",
              edit: { key: "realise", type: "number", value: String(selectedCharge.realise) },
            },
          ]}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Revenus">
          <Table
            onRowClick={(i) => setSelectedRow({ card: "revenus", ...revenusRows[i] })}
            headers={["Rubrique", "Montant"]}
            rows={revenusRows.map((r) => [r.label, r.value])}
          />
        </Card>
        <Card title="Coûts d'exploitation">
          <Table
            onRowClick={(i) => setSelectedRow({ card: "couts", ...coutsRows[i] })}
            headers={["Rubrique", "Réalisé"]}
            rows={coutsRows.map((r) => [r.label, r.value])}
          />
        </Card>
      </div>

      <Card title="Résultat & indicateurs unitaires">
        <Table
          onRowClick={(i) => setSelectedRow({ card: "resultat", ...resultatRows[i] })}
          headers={["Indicateur", "Valeur", "Lecture"]}
          rows={resultatRows.map((r) => [r.label, r.value, r.lecture])}
        />
      </Card>

      {selectedRow && (
        <RecordDetailModal
          title={selectedRow.label}
          onClose={() => setSelectedRow(null)}
          fields={[
            {
              label: selectedRow.card === "resultat" ? "Valeur" : "Montant",
              value: selectedRow.value,
              description: selectedRow.lecture,
            },
          ]}
        />
      )}
    </div>
  );
}

interface Invite {
  id: string;
  email: string;
  role: "admin" | "staff";
  menus: "all" | string[];
  poste?: StaffPoste;
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
  const [selectedInvite, setSelectedInvite] = useState<Invite | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [poste, setPoste] = useState<StaffPoste>("Personnalisé");
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
    const posteMenus = STAFF_POSTES.find((p) => p.value === poste)?.menus;
    try {
      await setDoc(inviteRef, {
        email: email.trim(),
        role,
        menus:
          role === "admin" || allMenus
            ? "all"
            : role === "staff" && poste !== "Personnalisé" && posteMenus
              ? posteMenus
              : menus,
        ...(role === "staff" ? { poste } : {}),
        used: false,
        createdBy: profile.uid,
        createdAt: new Date().toISOString(),
      });
      setEmail("");
      setMenus([]);
      setAllMenus(false);
      setPoste("Personnalisé");
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
          <p className="text-xs font-medium text-muted-foreground">Poste</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {STAFF_POSTES.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPoste(p.value)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  poste === p.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground"
                }`}
              >
                {p.value}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {poste === "Personnalisé"
              ? "Accès complet ; choisissez les sections visibles ci-dessous. Aucune restriction de données appliquée."
              : `Sections et données limitées à : ${STAFF_POSTES.find((p) => p.value === poste)?.menus.join(", ")}.`}
          </p>
        </div>
      )}

      {role === "staff" && poste === "Personnalisé" && (
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
          onRowClick={(i) => setSelectedInvite(invites[i])}
          headers={["E-mail", "Rôle", "Poste", "Sections", "Statut", "Lien"]}
          rows={invites.map((inv) => [
            inv.email,
            inv.role,
            inv.poste || "—",
            inv.menus === "all" ? "Toutes" : inv.menus.join(", ") || "—",
            inv.used ? (
              <span className="badge-status bg-success/15 text-success">Utilisée</span>
            ) : (
              <span className="badge-status bg-warning/20 text-warning">En attente</span>
            ),
            inv.used ? (
              "—"
            ) : (
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
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

      {selectedInvite && (
        <RecordDetailModal
          title={selectedInvite.email}
          subtitle={`Invitation créée le ${new Date(selectedInvite.createdAt).toLocaleDateString("fr-FR")}`}
          onClose={() => setSelectedInvite(null)}
          onDelete={
            selectedInvite.used
              ? undefined
              : () => {
                  revoke(selectedInvite);
                  setSelectedInvite(null);
                }
          }
          fields={[
            {
              label: "E-mail",
              value: selectedInvite.email,
              description:
                "L'adresse à laquelle le lien d'invitation doit être partagé — firestore.rules exige qu'elle corresponde exactement à l'e-mail utilisé pour créer le compte.",
            },
            {
              label: "Rôle",
              value: selectedInvite.role,
              description: "Rôle attribué au compte une fois l'invitation acceptée.",
            },
            {
              label: "Poste",
              value: selectedInvite.poste || "—",
              description:
                "Poste (sprint 17) — détermine à la fois le menu affiché et, pour les postes nommés, les collections Firestore réellement accessibles.",
            },
            {
              label: "Sections",
              value:
                selectedInvite.menus === "all" ? "Toutes" : selectedInvite.menus.join(", ") || "—",
              description:
                "Sections du dashboard visibles pour ce compte, dérivées du poste ou choisies à la main.",
            },
            {
              label: "Statut",
              value: selectedInvite.used ? "Utilisée" : "En attente",
              description: selectedInvite.used
                ? "Cette invitation a déjà été utilisée pour créer un compte — elle ne peut plus être révoquée ni réutilisée."
                : "Pas encore utilisée — peut être révoquée (supprimée) ci-dessous si elle n'est plus nécessaire.",
            },
          ]}
        />
      )}
    </Card>
  );
}

interface Boutique {
  uid: string;
  displayName: string;
  email: string;
  contactName?: string;
  phone?: string;
  address?: { ville: string; commune: string; quartier: string; repere?: string };
  idNumber?: string;
  verified?: boolean;
}

/**
 * Boutique verification (sprint 16) — an informational "AROM called and
 * confirmed this shop is real" flag, not a checkout gate. Partner data
 * collection already happens at onboarding (sprint 13); this just gives
 * admin something to act on afterward. `idNumber` (the CNI/RCCM collected
 * at signup) is now shown here too (sprint 18) — before, admin had nothing
 * to actually look at before clicking "Vérifié".
 */
function BoutiquesCard() {
  const [boutiques, setBoutiques] = useState<Boutique[]>([]);
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);
  const [selectedBoutique, setSelectedBoutique] = useState<Boutique | null>(null);

  useEffect(() => {
    const q = query(collection(db, "users"), where("role", "==", "partner"));
    return onSnapshot(
      q,
      (snap) =>
        setBoutiques(
          snap.docs
            .map((d) => ({ uid: d.id, ...(d.data() as Omit<Boutique, "uid">) }))
            // Unverified first — new signups are what admin needs to find,
            // not buried in an alphabetical list of everyone already checked.
            .sort((a, b) =>
              !!a.verified === !!b.verified
                ? a.displayName.localeCompare(b.displayName)
                : a.verified
                  ? 1
                  : -1,
            ),
        ),
      (err) => toast.error(`Synchronisation "boutiques" impossible : ${err.message}`),
    );
  }, []);

  const toggleVerified = (b: Boutique) =>
    updateDoc(doc(db, "users", b.uid), { verified: !b.verified }).catch((err) =>
      toast.error(`Mise à jour impossible : ${err.message}`),
    );

  const unverifiedCount = boutiques.filter((b) => !b.verified).length;
  const visible = unverifiedOnly ? boutiques.filter((b) => !b.verified) : boutiques;

  return (
    <Card
      title={`Boutiques partenaires${unverifiedCount > 0 ? ` (${unverifiedCount} à vérifier)` : ""}`}
      action={
        <button
          onClick={() => setUnverifiedOnly((v) => !v)}
          className={`rounded-lg border border-border px-3 py-2 text-xs font-semibold transition ${
            unverifiedOnly ? "bg-primary text-primary-foreground" : "text-muted-foreground"
          }`}
        >
          Non vérifiées seulement
        </button>
      }
    >
      <Table
        onRowClick={(i) => setSelectedBoutique(visible[i])}
        headers={["Boutique", "Responsable", "Contact", "Adresse", "N° CNI/RCCM", "Vérifié"]}
        empty="Aucune boutique inscrite pour l'instant."
        rows={visible.map((b) => [
          b.displayName,
          b.contactName || "—",
          <div className="text-xs">
            <p>{b.phone ? `+${b.phone}` : "—"}</p>
            <p className="text-muted-foreground">{b.email}</p>
          </div>,
          b.address ? `${b.address.quartier}, ${b.address.commune}, ${b.address.ville}` : "—",
          b.idNumber || "—",
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleVerified(b);
            }}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              b.verified ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
            }`}
          >
            {b.verified ? "Vérifié" : "Non vérifié"}
          </button>,
        ])}
      />

      {selectedBoutique && (
        <RecordDetailModal
          title={selectedBoutique.displayName}
          subtitle={selectedBoutique.email}
          onClose={() => setSelectedBoutique(null)}
          onSave={(patch) => {
            updateDoc(doc(db, "users", selectedBoutique.uid), patch);
            setSelectedBoutique(null);
          }}
          fields={[
            {
              label: "Boutique",
              value: selectedBoutique.displayName,
              description: "Nom de la boutique, choisi à l'inscription sur /storefront/signup.",
            },
            {
              label: "Responsable",
              value: selectedBoutique.contactName || "—",
              description:
                "Personne à contacter, collectée à l'étape « Contact » de l'inscription.",
              edit: {
                key: "contactName",
                type: "text",
                value: selectedBoutique.contactName ?? "",
              },
            },
            {
              label: "Téléphone",
              value: selectedBoutique.phone ? `+${selectedBoutique.phone}` : "—",
              description:
                "Numéro collecté à l'inscription — sert aussi de canal de confirmation KYC par téléphone (sprint 16).",
              edit: { key: "phone", type: "text", value: selectedBoutique.phone ?? "" },
            },
            {
              label: "Adresse",
              value: selectedBoutique.address
                ? `${selectedBoutique.address.quartier}, ${selectedBoutique.address.commune}, ${selectedBoutique.address.ville}`
                : "—",
              description:
                "Adresse structurée collectée à l'étape « Localisation » de l'inscription — modifiable uniquement par la boutique elle-même depuis /storefront/profile.",
            },
            {
              label: "N° CNI/RCCM",
              value: selectedBoutique.idNumber || "—",
              description:
                "Pièce d'identification optionnelle collectée à l'inscription (sprint 13), surfacée ici depuis sprint 18 pour appuyer la vérification.",
            },
            {
              label: "Vérifié",
              value: selectedBoutique.verified ? "Vérifié" : "Non vérifié",
              description:
                "Bascule via le bouton du tableau, pas ici — confirmation informationnelle par téléphone (sprint 16), ne bloque jamais la commande.",
            },
          ]}
        />
      )}
    </Card>
  );
}

interface StaffMember {
  uid: string;
  displayName: string;
  email: string;
  poste?: StaffPoste;
}

/**
 * Assign/change an existing staff member's poste (sprint 17) — the
 * invite flow only sets it at invite time, so accounts created before
 * this sprint (or via the CLI script) need a way to opt in afterward.
 * Picking a named poste also resets `menus` to match it, so the sidebar
 * stays consistent with what firestore.rules now actually enforces.
 */
function StaffCard() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);

  useEffect(() => {
    const q = query(collection(db, "users"), where("role", "==", "staff"));
    return onSnapshot(
      q,
      (snap) =>
        setStaff(
          snap.docs
            .map((d) => ({ uid: d.id, ...(d.data() as Omit<StaffMember, "uid">) }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        ),
      (err) => toast.error(`Synchronisation "équipe" impossible : ${err.message}`),
    );
  }, []);

  const setPosteFor = (s: StaffMember, value: string) => {
    const poste = value === "" ? undefined : (value as StaffPoste);
    const posteMenus = poste ? STAFF_POSTES.find((p) => p.value === poste)?.menus : undefined;
    updateDoc(doc(db, "users", s.uid), {
      poste: poste ?? deleteField(),
      // Only a named poste (not "Personnalisé", not clearing it) resets
      // menus automatically — those two cases keep whatever menus the
      // account already had, since there's no manual menu editor yet for
      // existing accounts.
      ...(poste && poste !== "Personnalisé" && posteMenus ? { menus: posteMenus } : {}),
    }).catch((err) => toast.error(`Mise à jour impossible : ${err.message}`));
  };

  return (
    <Card title="Équipe (staff)">
      <Table
        onRowClick={(i) => setSelectedStaff(staff[i])}
        headers={["Nom", "E-mail", "Poste"]}
        empty="Aucun compte staff pour l'instant."
        rows={staff.map((s) => [
          s.displayName,
          s.email,
          <select
            value={s.poste ?? ""}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setPosteFor(s, e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
          >
            <option value="">— Non assigné (accès complet) —</option>
            {STAFF_POSTES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.value}
              </option>
            ))}
          </select>,
        ])}
      />

      {selectedStaff && (
        <RecordDetailModal
          title={selectedStaff.displayName}
          subtitle={selectedStaff.email}
          onClose={() => setSelectedStaff(null)}
          fields={[
            {
              label: "Nom",
              value: selectedStaff.displayName,
              description: "Nom saisi par la personne elle-même en acceptant son invitation.",
            },
            {
              label: "E-mail",
              value: selectedStaff.email,
              description: "Identifiant de connexion de ce compte.",
            },
            {
              label: "Poste",
              value: selectedStaff.poste ?? "Non assigné (accès complet)",
              description:
                "Modifiable via le sélecteur du tableau, pas ici — un poste nommé restreint réellement, au niveau firestore.rules, les collections accessibles (sprint 17). Désactiver ce compte reste réservé au CLI pour l'instant (voir la feuille de route).",
            },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * Per-person bonus tracking (sprint 17) — replaces a single org-wide
 * "Prime"/"Commission" line with one row per staff member holding this
 * poste, computed from *their own* production.staffUid / vente.staffUid
 * entries. Anything logged before this sprint (or by someone without
 * this poste — admin, "Personnalisé" staff) has no matching staffUid;
 * shown as a separate "Non attribué" line so the total still reconciles
 * with the org-wide figure instead of silently dropping it.
 */
function ProductionBonusCard() {
  const { state, computed } = useErp();
  const p = state.parametres;
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [selectedRow, setSelectedRow] = useState<{ label: string; value: string } | null>(null);

  useEffect(() => {
    const q = query(collection(db, "users"), where("role", "==", "staff"));
    return onSnapshot(q, (snap) =>
      setStaff(
        snap.docs
          .map((d) => ({ uid: d.id, ...(d.data() as Omit<StaffMember, "uid">) }))
          .filter((s) => s.poste === "Directeur de Production"),
      ),
    );
  }, []);

  const rows = staff.map((s) => {
    const mine = computed.production.filter((r) => r.staffUid === s.uid);
    const valeur = mine.reduce((a, r) => a + r.valeurProduction, 0);
    return {
      ...s,
      bouteilles: mine.reduce((a, r) => a + r.totalBouteilles, 0),
      valeur,
      prime: valeur * p.tauxPrimeProduction,
    };
  });
  const attribue = rows.reduce((a, r) => a + r.valeur, 0);
  const nonAttribue = computed.valeurProduction - attribue;

  const objectifDescriptions: Record<string, string> = {
    Production:
      "Calculé automatiquement : bouteilles produites (tous formats) vs objectif de campagne défini dans Paramètres ERP.",
    "Rendement volume":
      "Calculé automatiquement : volume conditionné / volume de jus, moyenné sur tous les lots.",
    Pertes:
      "Calculé automatiquement : volume perdu / volume de jus, comparé au taux de pertes maximum toléré.",
  };
  const primeDescription =
    "Calculé automatiquement : primes par personne = valeur produite de leurs lots (staffUid) × taux de prime (Paramètres ERP). « Non attribué » regroupe les lots sans staffUid — antérieurs au sprint 17 ou saisis par un compte non scopé.";
  return (
    <Card title="Directeur de Production">
      <Table
        onRowClick={(i) =>
          setSelectedRow({
            label: ["Production", "Rendement volume", "Pertes"][i],
            value: String(
              [
                computed.bouteillesProduites,
                pctFormat(computed.rendementMoyen),
                pctFormat(computed.tauxPertes),
              ][i],
            ),
          })
        }
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
      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Prime par personne ({pctFormat(p.tauxPrimeProduction)} de la valeur produite)
      </p>
      <Table
        onRowClick={(i) => {
          const all = [
            ...rows.map((r) => ({ label: r.displayName, value: fcFormat(r.prime) })),
            ...(nonAttribue > 0.01
              ? [{ label: "Non attribué", value: fcFormat(nonAttribue * p.tauxPrimeProduction) }]
              : []),
          ];
          setSelectedRow(all[i]);
        }}
        headers={["Nom", "Bouteilles", "Valeur produite", "Prime"]}
        empty="Aucun Directeur de Production assigné — voir la carte Équipe ci-dessus."
        rows={[
          ...rows.map((r) => [r.displayName, r.bouteilles, fcFormat(r.valeur), fcFormat(r.prime)]),
          ...(nonAttribue > 0.01
            ? [
                [
                  "Non attribué",
                  "—",
                  fcFormat(nonAttribue),
                  fcFormat(nonAttribue * p.tauxPrimeProduction),
                ],
              ]
            : []),
        ]}
      />

      {selectedRow && (
        <RecordDetailModal
          title={selectedRow.label}
          onClose={() => setSelectedRow(null)}
          fields={[
            {
              label: "Valeur",
              value: selectedRow.value,
              description: objectifDescriptions[selectedRow.label] ?? primeDescription,
            },
          ]}
        />
      )}
    </Card>
  );
}

function CommercialBonusCard() {
  const { state, computed } = useErp();
  const p = state.parametres;
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [selectedRow, setSelectedRow] = useState<{ label: string; value: string } | null>(null);

  useEffect(() => {
    const q = query(collection(db, "users"), where("role", "==", "staff"));
    return onSnapshot(q, (snap) =>
      setStaff(
        snap.docs
          .map((d) => ({ uid: d.id, ...(d.data() as Omit<StaffMember, "uid">) }))
          .filter((s) => s.poste === "Chargée de Commercialisation"),
      ),
    );
  }, []);

  const rows = staff.map((s) => {
    const mine = computed.ventes.filter((v) => v.staffUid === s.uid);
    const encaisse = mine.reduce((a, v) => a + v.encaisse, 0);
    return {
      ...s,
      bouteilles: mine.reduce((a, v) => a + v.quantite, 0),
      encaisse,
      commission: encaisse * p.tauxCommission,
    };
  });
  const attribue = rows.reduce((a, r) => a + r.encaisse, 0);
  const nonAttribue = computed.encaissements - attribue;

  const objectifDescriptions: Record<string, string> = {
    Ventes:
      "Calculé automatiquement : bouteilles vendues (toutes ventes) vs objectif de campagne défini dans Paramètres ERP.",
    Clients: "Calculé automatiquement : nombre de clients distincts ayant acheté, vs objectif.",
    Encaissement: "Calculé automatiquement : encaissements / chiffre d'affaires brut.",
  };
  const commissionDescription =
    "Calculé automatiquement : commission par personne = encaissé sur leurs ventes (staffUid) × taux de commission (Paramètres ERP). « Non attribué » regroupe les ventes sans staffUid — antérieures au sprint 17 ou saisies par un compte non scopé.";
  return (
    <Card title="Chargée de Commercialisation">
      <Table
        onRowClick={(i) =>
          setSelectedRow({
            label: ["Ventes", "Clients", "Encaissement"][i],
            value: String(
              [
                computed.bouteillesVendues,
                computed.clientsActifs,
                pctFormat(computed.tauxEncaissement),
              ][i],
            ),
          })
        }
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
      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Commission par personne ({pctFormat(p.tauxCommission)} des encaissements)
      </p>
      <Table
        onRowClick={(i) => {
          const all = [
            ...rows.map((r) => ({ label: r.displayName, value: fcFormat(r.commission) })),
            ...(nonAttribue > 0.01
              ? [{ label: "Non attribué", value: fcFormat(nonAttribue * p.tauxCommission) }]
              : []),
          ];
          setSelectedRow(all[i]);
        }}
        headers={["Nom", "Bouteilles vendues", "Encaissé", "Commission"]}
        empty="Aucune Chargée de Commercialisation assignée — voir la carte Équipe ci-dessus."
        rows={[
          ...rows.map((r) => [
            r.displayName,
            r.bouteilles,
            fcFormat(r.encaisse),
            fcFormat(r.commission),
          ]),
          ...(nonAttribue > 0.01
            ? [
                [
                  "Non attribué",
                  "—",
                  fcFormat(nonAttribue),
                  fcFormat(nonAttribue * p.tauxCommission),
                ],
              ]
            : []),
        ]}
      />

      {selectedRow && (
        <RecordDetailModal
          title={selectedRow.label}
          onClose={() => setSelectedRow(null)}
          fields={[
            {
              label: "Valeur",
              value: selectedRow.value,
              description: objectifDescriptions[selectedRow.label] ?? commissionDescription,
            },
          ]}
        />
      )}
    </Card>
  );
}

function PersonnelSection({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const { computed } = useErp();
  const [showTotalDetail, setShowTotalDetail] = useState(false);
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 08"
        title="Primes & commissions"
        subtitle="Calcul automatique sur production conforme et encaissements, par personne"
        responsable="Direction Générale"
      />

      <Card title="Total primes campagne">
        <Table
          onRowClick={() => setShowTotalDetail(true)}
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

      {showTotalDetail && (
        <RecordDetailModal
          title="Total primes campagne"
          onClose={() => setShowTotalDetail(false)}
          fields={[
            {
              label: "Base production",
              value: fcFormat(computed.valeurProduction),
              description:
                "Calculé automatiquement : valeur totale des lots produits (Production) — base des primes de production.",
            },
            {
              label: "Base encaissements",
              value: fcFormat(computed.encaissements),
              description:
                "Calculé automatiquement : total des montants encaissés (Ventes) — base des commissions commerciales.",
            },
            {
              label: "Total primes",
              value: fcFormat(computed.totalPrimes),
              description:
                "Calculé automatiquement : primes de production + commissions commerciales, tous détails par personne dans les onglets « Primes production » / « Primes commercial » ci-dessous.",
            },
          ]}
        />
      )}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="invitations">Invitations</TabsTrigger>
          <TabsTrigger value="equipe">Équipe</TabsTrigger>
          <TabsTrigger value="boutiques">Boutiques partenaires</TabsTrigger>
          <TabsTrigger value="primes-production">Primes production</TabsTrigger>
          <TabsTrigger value="primes-commercial">Primes commercial</TabsTrigger>
        </TabsList>
        <TabsContent value="invitations">
          <InviteCard />
        </TabsContent>
        <TabsContent value="equipe">
          <StaffCard />
        </TabsContent>
        <TabsContent value="boutiques">
          <BoutiquesCard />
        </TabsContent>
        <TabsContent value="primes-production">
          <ProductionBonusCard />
        </TabsContent>
        <TabsContent value="primes-commercial">
          <CommercialBonusCard />
        </TabsContent>
      </Tabs>
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
      d: "Calculé automatiquement : kg transformés (Production) / kg achetés (Approvisionnement).",
    },
    {
      k: "Taux de vente",
      o: "100 %",
      r: pctFormat(
        computed.bouteillesProduites
          ? computed.bouteillesVendues / computed.bouteillesProduites
          : 0,
      ),
      d: "Calculé automatiquement : bouteilles vendues (Commercialisation) / bouteilles produites (Production).",
    },
    {
      k: "Taux d'encaissement",
      o: "100 %",
      r: pctFormat(computed.tauxEncaissement),
      d: "Calculé automatiquement : encaissements / chiffre d'affaires brut.",
    },
    {
      k: "Rendement matière",
      o: "> 95 %",
      r: pctFormat(computed.rendementMoyen),
      d: "Calculé automatiquement : volume conditionné / volume de jus, moyenné sur tous les lots.",
    },
    {
      k: "Pertes",
      o: `< ${pctFormat(p.tauxPertesMax)}`,
      r: pctFormat(computed.tauxPertes),
      d: "Calculé automatiquement : volume perdu / volume de jus, comparé au taux maximum toléré (Paramètres ERP).",
    },
    {
      k: "Clients actifs",
      o: String(p.objectifClients),
      r: String(computed.clientsActifs),
      d: "Calculé automatiquement : nombre de clients distincts ayant au moins une vente enregistrée.",
    },
    {
      k: "Marge brute",
      o: pctFormat(p.objectifMargeBrute),
      r: pctFormat(computed.margeBrute),
      d: "Calculé automatiquement : résultat brut / chiffre d'affaires.",
    },
    {
      k: "Coût moyen / bouteille",
      o: "-",
      r: fcFormat(computed.coutMoyenBouteille),
      d: "Calculé automatiquement : total des coûts d'exploitation / bouteilles produites.",
    },
    {
      k: "Créances à recouvrer",
      o: "0 FC",
      r: fcFormat(computed.creances),
      d: "Calculé automatiquement : chiffre d'affaires − encaissements.",
    },
  ];
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 09"
        title="Indicateurs stratégiques"
        subtitle="Calculés en temps réel à partir des modules ERP"
      />
      <ExportBar section="kpi" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <KpiTile key={i.k} label={i.k} objectif={i.o} realise={i.r} description={i.d} />
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
  const dateField = (label: string, key: keyof typeof p) => (
    <label className="text-xs font-medium text-muted-foreground">
      {label}
      <input
        type="date"
        value={String(p[key])}
        onChange={(e) => updateParametres({ [key]: e.target.value } as never)}
        className="mt-1 w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm text-foreground"
      />
    </label>
  );
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Module ERP 10"
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
        <div className="grid gap-4 sm:grid-cols-3">
          {dateField("Début production", "debutProduction")}
          {dateField("Fin production", "finProduction")}
          {dateField("Fin commercialisation", "finCommercialisation")}
        </div>
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
        eyebrow="Module ERP 11"
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
