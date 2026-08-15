import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { useAuth, type OAuthProviderName } from "@/lib/firebase/auth";

function authErrorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
}

export const Route = createFileRoute("/login")({
  component: LoginRoute,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = typeof search.redirect === "string" ? search.redirect : undefined;
    return redirect ? { redirect } : {};
  },
  head: () => ({
    meta: [{ title: "Connexion - AROM" }],
  }),
});

function LoginRoute() {
  const { signIn, signInWithProvider, resetPassword, user, profile, loading, signOutUser } =
    useAuth();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "reset">("login");
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    if (loading || !user) return;
    if (!profile) {
      signOutUser();
      setError("Aucun profil n'est associé à ce compte. Contactez un administrateur AROM.");
      return;
    }
    if (!profile.active) {
      signOutUser();
      setError("Ce compte a été désactivé. Contactez un administrateur AROM.");
      return;
    }
    navigate({ to: profile.role === "partner" ? "/storefront" : redirect || "/dashboard" });
  }, [loading, user, profile, redirect, navigate, signOutUser]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      toast.success("Connexion réussie.");
    } catch {
      setError("Identifiants invalides. Vérifiez votre e-mail et mot de passe.");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPassword(email);
    } catch {
      // Same message on success or failure — don't reveal whether an
      // account exists for this e-mail.
    } finally {
      setBusy(false);
      setResetSent(true);
    }
  };

  const handleOAuth = async (provider: OAuthProviderName) => {
    setBusy(true);
    setError(null);
    try {
      await signInWithProvider(provider);
      toast.success("Connexion réussie.");
    } catch (err) {
      const code = authErrorCode(err);
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // user changed their mind — not an error worth surfacing
      } else if (code === "auth/account-exists-with-different-credential") {
        setError("Un compte existe déjà avec cet e-mail via un autre mode de connexion.");
      } else {
        setError("Connexion impossible. Réessayez.");
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
              Se connecter
            </h1>
            <p className="mt-1 text-[15px] text-muted-foreground">Espace connecté AROM</p>
          </div>
        </div>

        {mode === "login" && (
          <>
            <div className="mt-8">
              <OAuthButtons onSelect={handleOAuth} busy={busy} />
            </div>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[12px] font-medium text-muted-foreground">ou avec e-mail</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </>
        )}
        {mode !== "login" && <div className="mt-8" />}

        {mode === "login" ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
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
                autoComplete="current-password"
                placeholder="Mot de passe"
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
              {busy ? "Connexion…" : "Se connecter"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode("reset");
                setResetSent(false);
                setError(null);
              }}
              className="w-full text-center text-[13px] font-medium text-primary"
            >
              Mot de passe oublié ?
            </button>
          </form>
        ) : resetSent ? (
          <div className="space-y-4 rounded-2xl bg-card p-5 text-center shadow-sm ring-1 ring-black/5">
            <p className="text-[14px] text-foreground">
              Si un compte existe avec l'adresse <span className="font-semibold">{email}</span>, un
              lien de réinitialisation vient d'être envoyé.
            </p>
            <button
              type="button"
              onClick={() => setMode("login")}
              className="text-[13px] font-semibold text-primary"
            >
              ← Retour à la connexion
            </button>
          </div>
        ) : (
          <form onSubmit={handleReset} className="space-y-3">
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <input
                type="email"
                required
                autoComplete="username"
                placeholder="E-mail"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? "Envoi…" : "Envoyer le lien de réinitialisation"}
            </button>

            <button
              type="button"
              onClick={() => setMode("login")}
              className="w-full text-center text-[13px] font-medium text-muted-foreground"
            >
              ← Retour à la connexion
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-[13px] text-muted-foreground">
          Partenaire acheteur ?{" "}
          <Link to="/storefront/signup" className="font-semibold text-primary">
            Créer un compte boutique
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
