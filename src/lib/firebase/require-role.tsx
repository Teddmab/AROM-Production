import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth, type Role } from "./auth";

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();

  const authorized = !!user && !!profile && profile.active && roles.includes(profile.role);
  const denied = !loading && (!user || (profile && !authorized));

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", search: { redirect: window.location.pathname } });
      return;
    }
    if (profile && !authorized) {
      navigate({ to: profile.role === "partner" ? "/storefront" : "/login" });
    }
  }, [loading, user, profile, authorized, navigate]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Chargement…</p>
      </div>
    );
  }

  if (denied || !authorized) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Redirection…</p>
      </div>
    );
  }

  return <>{children}</>;
}
