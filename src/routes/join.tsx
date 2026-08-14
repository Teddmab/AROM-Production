import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth, type Invite } from "@/lib/firebase/auth";

export const Route = createFileRoute("/join")({
  component: JoinRoute,
  validateSearch: (search: Record<string, unknown>): { invite?: string } => {
    const invite = typeof search.invite === "string" ? search.invite : undefined;
    return invite ? { invite } : {};
  },
  head: () => ({
    meta: [{ title: "Rejoindre l'équipe AROM" }],
  }),
});

const ROLE_LABELS: Record<Invite["role"], string> = {
  admin: "Administrateur",
  staff: "Membre de l'équipe",
};

function JoinRoute() {
  const { user, profile, loading, getInvite, redeemInvite } = useAuth();
  const navigate = useNavigate();
  const { invite: inviteId } = Route.useSearch();

  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already signed in — redeeming would create a second account instead
    // of using the one they're on, so send them where they already belong.
    if (!loading && user && profile?.active) {
      navigate({ to: profile.role === "partner" ? "/storefront" : "/dashboard" });
    }
  }, [loading, user, profile, navigate]);

  useEffect(() => {
    if (!inviteId) {
      setInvite(null);
      return;
    }
    getInvite(inviteId)
      .then((inv) => setInvite(inv && !inv.used ? inv : null))
      .catch(() => setInvite(null));
  }, [inviteId, getInvite]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteId) return;
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await redeemInvite(inviteId, password, displayName);
      toast.success("Compte créé - bienvenue dans l'équipe AROM.");
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("email-already-in-use")
          ? "Un compte existe déjà avec cet e-mail. Essayez de vous connecter."
          : "Impossible de créer le compte. Cette invitation n'est peut-être plus valide.",
      );
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
              Rejoindre l'équipe
            </h1>
            <p className="mt-1 text-[15px] text-muted-foreground">Accès interne AROM</p>
          </div>
        </div>

        {invite === undefined && (
          <p className="mt-8 text-center text-[15px] text-muted-foreground">Vérification…</p>
        )}

        {invite === null && (
          <div className="mt-8 rounded-2xl bg-card p-5 text-center shadow-sm ring-1 ring-black/5">
            <p className="text-[15px] font-medium text-foreground">
              Ce lien d'invitation n'est plus valide.
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Il a peut-être déjà été utilisé, ou le lien est incomplet. Demandez une nouvelle
              invitation à un administrateur AROM.
            </p>
            <Link to="/login" className="mt-4 inline-block text-[13px] font-semibold text-primary">
              ← Retour à la connexion
            </Link>
          </div>
        )}

        {invite && (
          <>
            <div className="mt-8 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <div className="px-4 py-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Invitation pour
                </p>
                <p className="mt-0.5 text-[15px] font-semibold text-foreground">{invite.email}</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {ROLE_LABELS[invite.role]}
                  {invite.role === "staff" && invite.menus !== "all" && invite.menus.length > 0
                    ? ` · ${invite.menus.join(", ")}`
                    : ""}
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
                <input
                  required
                  placeholder="Votre nom complet"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
                <div className="h-px bg-border/70" />
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="Choisissez un mot de passe (8 caractères min.)"
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
          </>
        )}

        <p className="mt-8 text-center text-[13px] text-muted-foreground">
          <Link to="/" className="font-medium text-primary">
            ← Retour à l'accueil
          </Link>
        </p>
      </div>
    </div>
  );
}
