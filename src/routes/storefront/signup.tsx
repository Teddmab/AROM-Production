import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { useAuth, type OAuthProviderName } from "@/lib/firebase/auth";

function authErrorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
}

export const Route = createFileRoute("/storefront/signup")({
  component: SignupRoute,
  head: () => ({
    meta: [{ title: "Créer un compte partenaire - AROM" }],
  }),
});

function SignupRoute() {
  const { signUpPartner, signUpPartnerWithProvider, user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already signed in with a real account — submitting this form would
    // silently sign that session out and create a brand-new partner
    // account instead, so send them to where they already belong.
    if (!loading && user && profile?.active) {
      navigate({ to: profile.role === "partner" ? "/storefront" : "/dashboard" });
    }
  }, [loading, user, profile, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signUpPartner(email, password, displayName);
      toast.success("Compte créé - bienvenue sur la boutique AROM.");
      navigate({ to: "/storefront" });
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
      toast.success("Bienvenue sur la boutique AROM.");
      navigate({ to: "/storefront" });
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

  return (
    <div className="grid min-h-screen place-items-center bg-background px-5 py-12">
      <div className="w-full max-w-95">
        <div className="flex flex-col items-center gap-4 text-center">
          <Link to="/" aria-label="Retour à l'accueil">
            <img
              src="/logo-nav.png"
              alt="AROM"
              className="h-20 w-20 rounded-[22px] object-cover shadow-lg shadow-primary/15 ring-1 ring-black/5 transition active:scale-95"
            />
          </Link>
          <div>
            <h1 className="font-display text-[28px] font-bold leading-tight text-primary">
              Créer un compte
            </h1>
            <p className="mt-1 text-[15px] text-muted-foreground">Boutique partenaire AROM</p>
          </div>
        </div>

        <div className="mt-8">
          <OAuthButtons onSelect={handleOAuth} busy={busy} />
        </div>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[12px] font-medium text-muted-foreground">ou avec e-mail</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
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
            {busy ? "Création…" : "Créer mon compte"}
          </button>
        </form>

        <p className="mt-8 text-center text-[13px] text-muted-foreground">
          Déjà un compte ?{" "}
          <Link to="/login" className="font-semibold text-primary">
            Se connecter
          </Link>
        </p>
        <p className="mt-3 text-center text-[13px] text-muted-foreground">
          <Link to="/" className="font-medium text-primary">
            ← Retour à l'accueil
          </Link>
        </p>
      </div>
    </div>
  );
}
