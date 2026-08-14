import { createFileRoute, Link } from "@tanstack/react-router";
import heroAsset from "@/assets/arom-hero.asset.json";
import { CountUp } from "@/components/motion/CountUp";
import { Reveal } from "@/components/motion/Reveal";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { property: "og:image", content: heroAsset.url },
      { name: "twitter:image", content: heroAsset.url },
    ],
  }),
});

function Home() {
  return (
    <div className="min-h-screen overflow-x-clip">
      {/* NAV */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/75 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo-nav.png"
              alt="AROM"
              className="h-11 w-11 rounded-xl object-cover shadow-sm ring-1 ring-black/5"
            />
            <div>
              <p className="font-display text-lg font-bold leading-none text-primary">AROM</p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">
                Saveurs Naturelles
              </p>
            </div>
          </div>
          <nav className="hidden items-center gap-8 text-sm font-medium text-foreground/80 md:flex">
            <a href="#process" className="transition hover:text-primary">
              Le process
            </a>
            <a href="#engagement" className="transition hover:text-primary">
              Engagement
            </a>
            <a href="#media" className="transition hover:text-primary">
              Média
            </a>
            <a href="#social" className="transition hover:text-primary">
              Réseaux
            </a>
            <a href="#campagne" className="transition hover:text-primary">
              Campagne
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              to="/login"
              className="hidden text-sm font-semibold text-foreground/80 transition hover:text-primary lg:inline-flex"
            >
              Se connecter
            </Link>
            <Link
              to="/storefront/signup"
              className="hidden items-center gap-2 rounded-full border border-primary/20 bg-card px-5 py-2.5 text-sm font-semibold text-primary shadow-sm transition active:scale-95 lg:inline-flex"
            >
              Espace partenaire
            </Link>
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition active:scale-95"
            >
              Tableau de bord
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-16 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <span className="badge-status bg-gold/20 text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" /> Campagne N°001/2026
          </span>
          <h1 className="mt-6 text-5xl font-bold leading-[1.05] text-primary md:text-6xl lg:text-7xl">
            De la production <br />à la <span className="italic text-gold">transformation.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-foreground/70">
            AROM, le goût authentique de l'ananas, du Kasaï au monde. Pilotez la campagne mensuelle
            : approvisionnement, production, stock, commercialisation, marketing et finances.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 text-sm font-semibold text-primary-foreground shadow-xl shadow-primary/25 transition active:scale-95"
            >
              Ouvrir le tableau de bord
              <span aria-hidden>→</span>
            </Link>
            <a
              href="#process"
              className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card px-7 py-3.5 text-sm font-semibold text-primary shadow-sm transition active:scale-95"
            >
              Découvrir le process
            </a>
          </div>

          <dl className="mt-14 grid grid-cols-3 gap-6 border-t border-border pt-8">
            {[
              { value: 300, suffix: " kg", v: "Ananas / mois" },
              { value: 300, suffix: "", v: "Bouteilles" },
              { value: 25, suffix: "", v: "Clients cibles" },
            ].map((s) => (
              <div key={s.v}>
                <dt className="font-display text-3xl font-bold text-primary">
                  <CountUp value={s.value} format={(n) => `${Math.round(n)}${s.suffix}`} />
                </dt>
                <dd className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                  {s.v}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          <div className="absolute -inset-8 rounded-[3rem] bg-gradient-to-br from-gold/30 via-transparent to-primary/20 blur-3xl" />
          <div className="relative overflow-hidden rounded-[2rem] bg-card shadow-2xl ring-1 ring-black/5">
            <img
              src="/logo-hero.png"
              alt="Logo AROM"
              className="aspect-square w-full object-cover"
            />
          </div>
        </div>
      </section>

      {/* PROCESS */}
      <section id="process" className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
            Qualité · Fraîcheur · Traçabilité
          </p>
          <h2 className="mt-3 text-4xl font-bold text-primary md:text-5xl">
            Du champ à votre bouteille, avec passion.
          </h2>
        </Reveal>
        <ol className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[
            {
              n: "01",
              t: "Production",
              d: "Culture et récolte d'ananas mûrs par nos producteurs locaux.",
            },
            {
              n: "02",
              t: "Collecte & Tri",
              d: "Sélection rigoureuse pour ne garder que les meilleurs fruits.",
            },
            { n: "03", t: "Transport", d: "Acheminement sécurisé pour préserver la fraîcheur." },
            {
              n: "04",
              t: "Préparation",
              d: "Lavage, épluchage et découpe selon les normes d'hygiène.",
            },
            {
              n: "05",
              t: "Transformation",
              d: "Extraction du jus puis filtration pour une texture lisse et pure.",
            },
            {
              n: "06",
              t: "Conditionnement",
              d: "Mise en bouteille, scellage et étiquetage avec soin.",
            },
          ].map((s) => (
            <li
              key={s.n}
              className="group relative overflow-hidden rounded-3xl border border-border bg-card p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-xl"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary font-display text-sm font-bold text-primary-foreground">
                  {s.n}
                </span>
                <h3 className="text-lg font-semibold text-primary">{s.t}</h3>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-foreground/70">{s.d}</p>
              <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gold/10 transition group-hover:scale-125" />
            </li>
          ))}
        </ol>
      </section>

      {/* ENGAGEMENT */}
      <section id="engagement" className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="grid gap-8 rounded-3xl bg-primary p-10 text-primary-foreground md:grid-cols-[1fr_1.2fr] md:p-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
              Notre engagement
            </p>
            <h2 className="mt-3 font-display text-4xl font-bold leading-tight md:text-5xl">
              Plus qu'un jus,
              <br />
              <span className="italic text-gold">une valeur partagée.</span>
            </h2>
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              "100% Naturel",
              "Sans conservateurs",
              "Hygiène & Qualité",
              "Soutien aux producteurs locaux",
              "Traçabilité garantie",
              "Impact local positif",
            ].map((v) => (
              <li
                key={v}
                className="flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3 backdrop-blur-sm"
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-gold text-primary text-xs font-bold">
                  ✓
                </span>
                <span className="text-sm font-medium">{v}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* CAMPAGNE */}
      {/* MEDIA */}
      <section id="media" className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
              Média & Communication
            </p>
            <h2 className="mt-3 text-4xl font-bold text-primary md:text-5xl">
              Notre histoire en images.
            </h2>
            <p className="mt-3 max-w-xl text-foreground/70">
              Vidéos de production, témoignages clients et campagnes marketing, pour partager le
              savoir-faire AROM au-delà du Kasaï.
            </p>
          </div>
          <a
            href="#social"
            className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-card px-5 py-2.5 text-sm font-semibold text-primary shadow-sm transition active:scale-95"
          >
            Partager
            <span aria-hidden>→</span>
          </a>
        </Reveal>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          {/* Featured video */}
          <figure className="group relative min-w-0 overflow-hidden rounded-3xl bg-primary shadow-2xl ring-1 ring-black/5">
            <video
              className="aspect-video w-full object-cover"
              controls
              preload="metadata"
              poster={heroAsset.url}
            >
              <source src="" type="video/mp4" />
              Votre navigateur ne supporte pas la vidéo HTML5.
            </video>
            <figcaption className="flex items-center justify-between gap-4 bg-primary px-6 py-4 text-primary-foreground">
              <div>
                <p className="font-display text-lg font-semibold">Du champ à la bouteille</p>
                <p className="text-xs uppercase tracking-[0.2em] text-gold">
                  Reportage · Campagne 001/2026
                </p>
              </div>
              <span className="badge-status bg-gold/20 text-gold">
                <span className="h-1.5 w-1.5 rounded-full bg-gold" /> À la une
              </span>
            </figcaption>
          </figure>

          {/* Playlist */}
          <ul className="grid min-w-0 gap-4">
            {[
              { t: "Récolte & sélection des ananas", d: "1:42", tag: "Production" },
              { t: "Atelier de transformation", d: "2:15", tag: "Qualité" },
              { t: "Témoignage · Nos clients à Kinshasa", d: "0:58", tag: "Marketing" },
              { t: "Publicité AROM : 100% naturel", d: "0:30", tag: "Campagne" },
            ].map((v) => (
              <li key={v.t}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-4 rounded-3xl border border-border bg-card p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                >
                  <span className="relative grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-primary to-leaf">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-white/95 text-primary shadow-md transition group-hover:scale-110">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-primary">{v.t}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-full bg-gold/15 px-2 py-0.5 font-semibold text-primary">
                        {v.tag}
                      </span>
                      <span>{v.d}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* SOCIAL */}
      <section id="social" className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card via-card to-gold/10 p-10 md:p-14">
          <div className="grid gap-10 md:grid-cols-[1fr_1.3fr] md:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
                Au-delà de la région
              </p>
              <h2 className="mt-3 font-display text-4xl font-bold leading-tight text-primary md:text-5xl">
                Suivez AROM,
                <br />
                <span className="italic text-gold">partagez la saveur.</span>
              </h2>
              <p className="mt-4 max-w-md text-foreground/70">
                Rejoignez notre communauté et découvrez AROM depuis Kinshasa, Lubumbashi, l'Afrique
                et le monde. Chaque partage soutient nos producteurs locaux.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-6">
                <div>
                  <p className="font-display text-3xl font-bold text-primary">
                    <CountUp value={2.4} format={(n) => `+${n.toFixed(1)}k`} />
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Abonnés cumulés
                  </p>
                </div>
                <div>
                  <p className="font-display text-3xl font-bold text-primary">
                    <CountUp value={18} />
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Villes touchées
                  </p>
                </div>
              </div>
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  name: "Facebook",
                  handle: "AROM Jus d'ananas",
                  url: "https://facebook.com",
                  color: "#1877F2",
                  icon: (
                    <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H8v-2.9h2.4V9.8c0-2.4 1.4-3.7 3.6-3.7 1 0 2.1.2 2.1.2v2.3h-1.2c-1.2 0-1.5.7-1.5 1.5V12H16l-.4 2.9h-2.2v7A10 10 0 0 0 22 12z" />
                  ),
                },
                {
                  name: "Instagram",
                  handle: "@arom_juice",
                  url: "https://instagram.com",
                  color: "#E1306C",
                  icon: (
                    <>
                      <path d="M12 2.2c3.2 0 3.6 0 4.8.1 1.2.1 1.8.2 2.2.4.6.2 1 .5 1.4.9.4.4.7.9.9 1.4.2.4.4 1 .4 2.2.1 1.2.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 1.2-.2 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.9.7-1.4.9-.4.2-1 .4-2.2.4-1.2.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-1.2-.1-1.8-.2-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.9-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8c.1-1.2.2-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.9-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2zm0 3.3a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 10.7a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4zm6.7-11a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                    </>
                  ),
                },
                {
                  name: "WhatsApp",
                  handle: "+243 850 092 707",
                  url: "https://wa.me/243850092707",
                  color: "#25D366",
                  icon: (
                    <path d="M20.5 3.5A11 11 0 0 0 3.6 17.3L2 22l4.8-1.6a11 11 0 0 0 5.2 1.4h.1a11 11 0 0 0 8.4-18.3zm-8.4 16.9a9.1 9.1 0 0 1-4.7-1.3l-.3-.2-2.8 1 .9-2.8-.2-.3a9.1 9.1 0 1 1 7.1 3.6zm5-6.8c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1a7.5 7.5 0 0 1-3.7-3.2c-.3-.5.3-.5.8-1.5.1-.2 0-.4 0-.5 0-.1-.7-1.7-1-2.3-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.3 5.2 4.6 1.9.8 2.7.9 3.6.7.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4 0-.1-.2-.2-.5-.4z" />
                  ),
                },
                {
                  name: "TikTok",
                  handle: "@aromjuice",
                  url: "https://tiktok.com",
                  color: "#000000",
                  icon: (
                    <path d="M19.6 6.7a5.4 5.4 0 0 1-3.2-1.1 5.4 5.4 0 0 1-2.1-3.5H11v13.4a3.2 3.2 0 1 1-2.2-3v-3.4a6.5 6.5 0 1 0 5.6 6.4V9.3a8.7 8.7 0 0 0 5.2 1.7V7.6c-.1 0 0-.9 0-.9z" />
                  ),
                },
                {
                  name: "YouTube",
                  handle: "AROM Officiel",
                  url: "https://youtube.com",
                  color: "#FF0000",
                  icon: (
                    <path d="M23 12s0-3.6-.5-5.3a2.8 2.8 0 0 0-2-2C18.9 4.2 12 4.2 12 4.2s-6.9 0-8.5.5a2.8 2.8 0 0 0-2 2C1 8.4 1 12 1 12s0 3.6.5 5.3a2.8 2.8 0 0 0 2 2c1.6.5 8.5.5 8.5.5s6.9 0 8.5-.5a2.8 2.8 0 0 0 2-2C23 15.6 23 12 23 12zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z" />
                  ),
                },
                {
                  name: "LinkedIn",
                  handle: "AROM Saveurs",
                  url: "https://linkedin.com",
                  color: "#0A66C2",
                  icon: (
                    <path d="M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1 0-5zM3 9.5h4v11H3v-11zM10 9.5h3.8v1.5h.1c.5-.9 1.8-1.9 3.7-1.9 4 0 4.7 2.6 4.7 6v5.4h-4v-4.8c0-1.1 0-2.6-1.6-2.6s-1.9 1.3-1.9 2.5v4.9h-4v-11z" />
                  ),
                },
              ].map((s) => (
                <li key={s.name}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-4 rounded-3xl border border-border bg-card px-4 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                  >
                    <span
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-md"
                      style={{ backgroundColor: s.color }}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden
                      >
                        {s.icon}
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-primary">{s.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {s.handle}
                      </span>
                    </span>
                    <span
                      className="text-primary/50 transition group-hover:translate-x-1 group-hover:text-primary"
                      aria-hidden
                    >
                      →
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      <section id="campagne" className="mx-auto max-w-7xl px-6 pb-24">
        <Reveal className="grid gap-6 rounded-3xl border border-border bg-card p-10 md:grid-cols-[2fr_1fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold">
              Campagne N°001/2026
            </p>
            <h2 className="mt-2 text-3xl font-bold text-primary md:text-4xl">
              Prêt à piloter votre atelier ?
            </h2>
            <p className="mt-3 max-w-lg text-foreground/70">
              Le tableau de bord opérationnel réunit approvisionnement, production, stock, ventes,
              marketing, finances et performance du personnel, dans une seule vue.
            </p>
          </div>
          <Link
            to="/dashboard"
            className="grid place-items-center rounded-3xl bg-gradient-to-br from-primary to-leaf p-8 text-center text-primary-foreground shadow-xl transition hover:scale-[1.02] active:scale-[0.98]"
          >
            <div>
              <p className="font-display text-2xl font-bold">Accéder au tableau de bord</p>
              <p className="mt-2 text-sm text-primary-foreground/80">Direction Générale</p>
              <span className="mt-4 inline-block text-2xl">→</span>
            </div>
          </Link>
        </Reveal>
      </section>

      <footer className="border-t border-border bg-primary py-6 text-center text-xs uppercase tracking-[0.3em] text-primary-foreground">
        AROM · Local · Naturel · Responsable · Durable
      </footer>
    </div>
  );
}
