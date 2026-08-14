import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft } from "lucide-react";
import { useAuth } from "@/lib/firebase/auth";
import { RequireRole } from "@/lib/firebase/require-role";
import { DRC_VILLES } from "@/lib/storefront/depot";

export const Route = createFileRoute("/storefront/profile")({
  component: ProfileRoute,
  head: () => ({
    meta: [{ title: "Mon profil - AROM" }],
  }),
});

function ProfileRoute() {
  return (
    <RequireRole roles={["partner"]}>
      <Profile />
    </RequireRole>
  );
}

function Profile() {
  const { profile, updatePartnerProfile } = useAuth();
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [ville, setVille] = useState<string>(DRC_VILLES[0]);
  const [villeAutre, setVilleAutre] = useState("");
  const [commune, setCommune] = useState("");
  const [quartier, setQuartier] = useState("");
  const [repere, setRepere] = useState("");
  const [idNumber, setIdNumber] = useState("");

  useEffect(() => {
    if (profile?.onboardingComplete === false) {
      navigate({ to: "/storefront/signup" });
    }
  }, [profile, navigate]);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.displayName);
    setContactName(profile.contactName ?? "");
    setPhone(profile.phone ?? "");
    if (profile.address) {
      const knownVille = (DRC_VILLES as readonly string[]).includes(profile.address.ville);
      setVille(knownVille ? profile.address.ville : "Autre");
      setVilleAutre(knownVille ? "" : profile.address.ville);
      setCommune(profile.address.commune);
      setQuartier(profile.address.quartier);
      setRepere(profile.address.repere ?? "");
    }
    setIdNumber(profile.idNumber ?? "");
  }, [profile]);

  if (!profile) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalVille = ville === "Autre" ? villeAutre.trim() : ville;
    if (!displayName.trim() || !contactName.trim()) {
      setError("Le nom de la boutique et le nom du responsable sont requis.");
      return;
    }
    if (!/^\d{9,12}$/.test(phone)) {
      setError("Numéro de téléphone invalide (indicatif pays inclus, sans le 0 initial).");
      return;
    }
    if (!finalVille || !commune.trim() || !quartier.trim()) {
      setError("Complétez la ville, la commune et le quartier.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updatePartnerProfile({
        displayName: displayName.trim(),
        contactName: contactName.trim(),
        phone,
        address: {
          ville: finalVille,
          commune: commune.trim(),
          quartier: quartier.trim(),
          repere: repere.trim() || undefined,
        },
        idNumber: idNumber.trim() || undefined,
      });
      toast.success("Profil mis à jour.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mise à jour impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-background/75 px-5 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <button
          onClick={() => navigate({ to: "/storefront" })}
          aria-label="Retour à la boutique"
          className="grid h-9 w-9 place-items-center rounded-full bg-secondary text-secondary-foreground transition active:scale-90"
        >
          <ChevronLeft className="h-4.5 w-4.5" aria-hidden />
        </button>
        <h1 className="font-display text-[19px] font-bold text-primary">Mon profil</h1>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 px-5 pb-16 pt-5">
        <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
          <div className="px-4 py-3.5">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              Compte
            </p>
            <p className="mt-1 text-[15px] text-foreground">{profile.email}</p>
          </div>
          {profile.pointDeVente && (
            <>
              <div className="h-px bg-border/70" />
              <div className="px-4 py-3.5">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Point de vente
                </p>
                <p className="mt-1 text-[15px] text-foreground">{profile.pointDeVente}</p>
              </div>
            </>
          )}
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          <div>
            <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
              Boutique
            </p>
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <input
                required
                placeholder="Nom / Raison sociale"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
              Contact
            </p>
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
          </div>

          <div>
            <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
              Livraison
            </p>
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
          </div>

          <div>
            <p className="mb-2 px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
              Identification
            </p>
            <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
              <input
                placeholder="Numéro CNI ou RCCM (optionnel)"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
          </div>

          {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? "Enregistrement…" : "Enregistrer"}
          </button>
        </form>

        <p className="text-center text-[13px] text-muted-foreground">
          <Link to="/storefront" className="font-medium text-primary">
            ← Retour à la boutique
          </Link>
        </p>
      </main>
    </div>
  );
}
