import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
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
    <div className="grid min-h-screen place-items-center bg-background px-5 py-12">
      <div className="w-full max-w-95">
        <div className="flex flex-col items-center gap-4 text-center">
          <img
            src="/logo-nav.png"
            alt="AROM"
            className="h-20 w-20 rounded-[22px] object-cover shadow-lg shadow-primary/15 ring-1 ring-black/5"
          />
          <div>
            <h1 className="font-display text-[28px] font-bold leading-tight text-primary">
              Se connecter
            </h1>
            <p className="mt-1 text-[15px] text-muted-foreground">Espace connecté AROM</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-3">
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
        </form>

        <p className="mt-8 text-center text-[13px] text-muted-foreground">
          Partenaire acheteur ?{" "}
          <Link to="/storefront/signup" className="font-semibold text-primary">
            Créer un compte boutique
          </Link>
        </p>
      </div>
    </div>
  );
}
