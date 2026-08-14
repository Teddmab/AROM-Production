import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft } from "lucide-react";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { useAuth, type OAuthProviderName } from "@/lib/firebase/auth";
import { AROM_DEPOT_NAME, DRC_VILLES } from "@/lib/storefront/depot";

function authErrorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
}

export const Route = createFileRoute("/storefront/signup")({
  component: SignupRoute,
  head: () => ({
    meta: [{ title: "Créer un compte partenaire - AROM" }],
  }),
});

const TOTAL_STEPS = 5;

const STEP_COPY: Record<number, { title: string; subtitle: string }> = {
  1: { title: "Créer un compte", subtitle: "Boutique partenaire AROM" },
  2: { title: "Qui contacter ?", subtitle: "Pour confirmer vos commandes et la livraison." },
  3: {
    title: "Où livrer ?",
    subtitle: "Cela nous aide à organiser la livraison depuis notre dépôt.",
  },
  4: {
    title: "Vérification",
    subtitle: "Facultatif, mais aide AROM à confirmer votre boutique.",
  },
  5: { title: "Vérifiez vos informations", subtitle: "Dernière étape avant de commencer." },
};

function ProgressBar({ step }: { step: number }) {
  return (
    <div className="mb-2">
      <p className="text-center text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        Étape {step} sur {TOTAL_STEPS}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
        />
      </div>
    </div>
  );
}

function SignupRoute() {
  const {
    signUpPartner,
    signUpPartnerWithProvider,
    completePartnerOnboarding,
    user,
    profile,
    loading,
  } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — account
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Step 2 — contact
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("243");

  // Step 3 — location
  const [ville, setVille] = useState<string>(DRC_VILLES[0]);
  const [villeAutre, setVilleAutre] = useState("");
  const [commune, setCommune] = useState("");
  const [quartier, setQuartier] = useState("");
  const [repere, setRepere] = useState("");

  // Step 4 — verification (optional)
  const [idNumber, setIdNumber] = useState("");

  useEffect(() => {
    if (loading || !user || !profile) return;
    if (profile.active && (profile.role !== "partner" || profile.onboardingComplete)) {
      navigate({ to: profile.role === "partner" ? "/storefront" : "/dashboard" });
      return;
    }
    if (profile.role === "partner" && !profile.onboardingComplete) {
      setDisplayName(profile.displayName);
      setEmail(profile.email);
      setStep((s) => (s < 2 ? 2 : s));
    }
  }, [loading, user, profile, navigate]);

  const goBack = () => {
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  };

  const handleSubmitAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signUpPartner(email, password, displayName);
      setStep(2);
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("email-already-in-use")
          ? "Un compte existe déjà avec cet e-mail."
          : "Impossible de créer le compte. Vérifiez les informations saisies.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async (provider: OAuthProviderName) => {
    setBusy(true);
    setError(null);
    try {
      await signUpPartnerWithProvider(provider);
      // Resume logic lives in the effect above, driven by the profile listener.
    } catch (err) {
      const code = authErrorCode(err);
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // user changed their mind — not an error worth surfacing
      } else if (code === "auth/account-exists-with-different-credential") {
        setError("Un compte existe déjà avec cet e-mail via un autre mode de connexion.");
      } else {
        setError(
          err instanceof Error && err.message ? err.message : "Impossible de créer le compte.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleContactNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactName.trim()) {
      setError("Indiquez le nom du responsable de la boutique.");
      return;
    }
    if (!/^\d{9,12}$/.test(phone)) {
      setError("Numéro de téléphone invalide (indicatif pays inclus, sans le 0 initial).");
      return;
    }
    setError(null);
    setStep(3);
  };

  const handleLocationNext = (e: React.FormEvent) => {
    e.preventDefault();
    const finalVille = ville === "Autre" ? villeAutre.trim() : ville;
    if (!finalVille || !commune.trim() || !quartier.trim()) {
      setError("Complétez la ville, la commune et le quartier.");
      return;
    }
    setError(null);
    setStep(4);
  };

  const handleVerificationNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStep(5);
  };

  const handleFinish = async () => {
    setBusy(true);
    setError(null);
    try {
      await completePartnerOnboarding({
        contactName,
        phone,
        address: {
          ville: ville === "Autre" ? villeAutre.trim() : ville,
          commune: commune.trim(),
          quartier: quartier.trim(),
          repere: repere.trim() || undefined,
        },
        idNumber: idNumber.trim() || undefined,
      });
      toast.success("Compte créé - bienvenue sur la boutique AROM.");
      navigate({ to: "/storefront" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de finaliser l'inscription. Réessayez.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = STEP_COPY[step];
  const finalVille = ville === "Autre" ? villeAutre : ville;

  return (
    <div className="grid min-h-screen place-items-center bg-background px-5 py-12">
      <div className="w-full max-w-95">
        <div className="flex flex-col items-center gap-4 text-center">
          {step === 1 ? (
            <Link to="/" aria-label="Retour à l'accueil">
              <img
                src="/logo-nav.png"
                alt="AROM"
                className="h-20 w-20 rounded-[22px] object-cover shadow-lg shadow-primary/15 ring-1 ring-black/5 transition active:scale-95"
              />
            </Link>
          ) : (
            <button
              type="button"
              onClick={goBack}
              aria-label="Étape précédente"
              className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-secondary-foreground transition active:scale-90"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
          )}
          <div>
            <h1 className="font-display text-[28px] font-bold leading-tight text-primary">
              {copy.title}
            </h1>
            <p className="mt-1 text-[15px] text-muted-foreground">{copy.subtitle}</p>
          </div>
        </div>

        <div className="mt-6">
          <ProgressBar step={step} />
        </div>

        {step === 1 && (
          <>
            <div className="mt-6">
              <OAuthButtons onSelect={handleOAuth} busy={busy} />
            </div>
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[12px] font-medium text-muted-foreground">ou avec e-mail</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <form onSubmit={handleSubmitAccount} className="space-y-3">
              <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
                <input
                  required
                  placeholder="Nom / Raison sociale"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
                <div className="h-px bg-border/70" />
                <input
                  type="email"
                  required
                  autoComplete="username"
                  placeholder="E-mail"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
                <div className="h-px bg-border/70" />
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="Mot de passe (8 caractères min.)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
              </div>
              {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98] disabled:opacity-60"
              >
                {busy ? "Création…" : "Continuer"}
              </button>
            </form>
            <p className="mt-8 text-center text-[13px] text-muted-foreground">
              Déjà un compte ?{" "}
              <Link to="/login" className="font-semibold text-primary">
                Se connecter
              </Link>
            </p>
          </>
        )}

        {step === 2 && (
          <form onSubmit={handleContactNext} className="mt-6 space-y-3">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <input
                required
                placeholder="Nom du responsable"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
              <div className="h-px bg-border/70" />
              <input
                type="tel"
                inputMode="numeric"
                required
                placeholder="Téléphone (ex. 243812345678)"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ""))}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
            {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
            >
              Continuer
            </button>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={handleLocationNext} className="mt-6 space-y-3">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <select
                value={ville}
                onChange={(e) => setVille(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground focus:outline-none"
              >
                {DRC_VILLES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              {ville === "Autre" && (
                <>
                  <div className="h-px bg-border/70" />
                  <input
                    required
                    placeholder="Précisez la ville"
                    value={villeAutre}
                    onChange={(e) => setVilleAutre(e.target.value)}
                    className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                  />
                </>
              )}
              <div className="h-px bg-border/70" />
              <input
                required
                placeholder="Commune"
                value={commune}
                onChange={(e) => setCommune(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
              <div className="h-px bg-border/70" />
              <input
                required
                placeholder="Quartier"
                value={quartier}
                onChange={(e) => setQuartier(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
              <div className="h-px bg-border/70" />
              <input
                placeholder="Point de repère (optionnel)"
                value={repere}
                onChange={(e) => setRepere(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
            {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
            >
              Continuer
            </button>
          </form>
        )}

        {step === 4 && (
          <form onSubmit={handleVerificationNext} className="mt-6 space-y-3">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <input
                placeholder="Numéro CNI ou RCCM (optionnel)"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
            <p className="px-1 text-[13px] text-muted-foreground">
              Nous aide à vérifier votre boutique. Vous pouvez laisser ce champ vide et le compléter
              plus tard.
            </p>
            {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
            >
              Continuer
            </button>
          </form>
        )}

        {step === 5 && (
          <div className="mt-6 space-y-4">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <div className="space-y-1 px-4 py-3.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Boutique
                </p>
                <p className="text-[15px] text-foreground">{displayName}</p>
                <p className="text-[13px] text-muted-foreground">{email}</p>
              </div>
              <div className="h-px bg-border/70" />
              <div className="space-y-1 px-4 py-3.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Contact
                </p>
                <p className="text-[15px] text-foreground">{contactName}</p>
                <p className="text-[13px] text-muted-foreground">+{phone}</p>
              </div>
              <div className="h-px bg-border/70" />
              <div className="space-y-1 px-4 py-3.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Livraison
                </p>
                <p className="text-[15px] text-foreground">
                  {quartier}, {commune}, {finalVille}
                </p>
                {repere && <p className="text-[13px] text-muted-foreground">{repere}</p>}
              </div>
              {idNumber && (
                <>
                  <div className="h-px bg-border/70" />
                  <div className="space-y-1 px-4 py-3.5">
                    <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Identification
                    </p>
                    <p className="text-[15px] text-foreground">{idNumber}</p>
                  </div>
                </>
              )}
            </div>

            <div className="rounded-2xl bg-gold/10 px-4 py-3.5 text-[13px] text-primary">
              Vos commandes seront livrées depuis : <strong>{AROM_DEPOT_NAME}</strong>
            </div>

            {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
            <button
              onClick={handleFinish}
              disabled={busy}
              className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? "Finalisation…" : "Confirmer et terminer"}
            </button>
          </div>
        )}

        {step === 1 && (
          <p className="mt-3 text-center text-[13px] text-muted-foreground">
            <Link to="/" className="font-medium text-primary">
              ← Retour à l'accueil
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
