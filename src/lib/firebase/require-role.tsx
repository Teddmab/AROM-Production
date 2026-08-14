import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth, type Role } from "./auth";

function homeFor(role: Role): string {
  return role === "partner" ? "/storefront" : "/dashboard";
}

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, profile, loading, signOutUser } = useAuth();
  const navigate = useNavigate();

  const noProfile = !loading && !!user && !profile;
  const deactivated = !!profile && !profile.active;
  const wrongRole = !!profile && profile.active && !roles.includes(profile.role);
  const authorized = !!user && !!profile && profile.active && roles.includes(profile.role);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", search: { redirect: window.location.pathname } });
      return;
    }
    // Deactivated/no-profile accounts are shown an explanation below instead
    // of being redirected — bouncing them to /login would just send them
    // straight back here (or to /storefront for a deactivated partner,
    // which *is* here), looping forever instead of explaining what happened.
    if (profile && wrongRole) {
      navigate({ to: homeFor(profile.role) });
    }
  }, [loading, user, profile, wrongRole, navigate]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Chargement…</p>
      </div>
    );
  }

  if (noProfile || deactivated) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-lg">
          <h1 className="font-display text-lg font-bold text-primary">Accès indisponible</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {deactivated
              ? "Ce compte a été désactivé. Contactez un administrateur AROM."
              : "Aucun profil n'est associé à ce compte. Contactez un administrateur AROM."}
          </p>
          <button
            onClick={() => signOutUser()}
            className="mt-6 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Se déconnecter
          </button>
        </div>
      </div>
    );
  }

  if (!authorized || wrongRole) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Redirection…</p>
      </div>
    );
  }

  return <>{children}</>;
}
