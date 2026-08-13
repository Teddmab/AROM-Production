import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import logoAsset from "@/assets/arom-logo.asset.json";
import { useAuth } from "@/lib/firebase/auth";

export const Route = createFileRoute("/storefront/signup")({
  component: SignupRoute,
  head: () => ({
    meta: [{ title: "Créer un compte partenaire — AROM" }],
  }),
});

function SignupRoute() {
  const { signUpPartner } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      toast.success("Compte créé — bienvenue sur la boutique AROM.");
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
              Compte boutique partenaire
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-xs font-medium text-muted-foreground">
            Nom / Raison sociale
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
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
              minLength={8}
              autoComplete="new-password"
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
            {busy ? "Création…" : "Créer mon compte"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Déjà un compte ?{" "}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
