import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import logoAsset from "@/assets/arom-logo.asset.json";
import { useAuth } from "@/lib/firebase/auth";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = typeof search.redirect === "string" ? search.redirect : undefined;
    return redirect ? { redirect } : {};
  },
  head: () => ({
    meta: [{ title: "Connexion — AROM" }],
  }),
});

function LoginRoute() {
  const { signIn, user, profile } = useAuth();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user && profile) {
    navigate({ to: profile.role === "partner" ? "/storefront" : redirect || "/dashboard" });
  }

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

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-lg">
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src={logoAsset.url}
            alt="AROM"
            className="h-14 w-14 rounded-full object-cover ring-2 ring-gold/40"
          />
          <div>
            <p className="font-display text-lg font-bold text-primary">AROM</p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold">
              Espace connecté
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-xs font-medium text-muted-foreground">
            E-mail
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Mot de passe
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          {error && <p className="text-xs font-medium text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Connexion…" : "Se connecter"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Partenaire acheteur ?{" "}
          <Link to="/storefront/signup" className="font-semibold text-primary hover:underline">
            Créer un compte boutique
          </Link>
        </p>
      </div>
    </div>
  );
}
