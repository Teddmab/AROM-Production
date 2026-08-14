import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { toast } from "sonner";
import { LogOut, Minus, Plus, ShoppingBag } from "lucide-react";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/firebase/auth";
import { RequireRole } from "@/lib/firebase/require-role";
import { fcFormat } from "@/lib/erp/model";

export const Route = createFileRoute("/storefront/")({
  component: StorefrontRoute,
  head: () => ({
    meta: [{ title: "Boutique partenaire - AROM" }],
  }),
});

interface Product {
  id: string;
  name: string;
  format: string;
  price: number;
  active: boolean;
  imageUrl?: string;
}

interface Order {
  id: string;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  total: number;
  createdAt: string;
  items: { productId: string; name: string; quantity: number; unitPrice: number; format: string }[];
}

const STATUS_STYLES: Record<Order["status"], { label: string; className: string }> = {
  pending: { label: "En attente", className: "bg-muted text-muted-foreground" },
  confirmed: { label: "Confirmée", className: "bg-gold/20 text-primary" },
  fulfilled: { label: "Livrée", className: "bg-success/15 text-success" },
  cancelled: { label: "Annulée", className: "bg-destructive/10 text-destructive" },
};

function StorefrontRoute() {
  return (
    <RequireRole roles={["partner"]}>
      <Storefront />
    </RequireRole>
  );
}

function Storefront() {
  const { profile, signOutUser } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    return onSnapshot(collection(db, "products"), (snap) => {
      setProducts(snap.docs.map((d) => d.data() as Product).filter((p) => p.active));
    });
  }, []);

  useEffect(() => {
    if (!profile) return;
    const q = query(
      collection(db, "orders"),
      where("partnerId", "==", profile.uid),
      orderBy("createdAt", "desc"),
    );
    return onSnapshot(q, (snap) =>
      setOrders(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, "id">) }))),
    );
  }, [profile]);

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([productId, quantity]) => {
          const product = products.find((p) => p.id === productId);
          return product
            ? {
                productId,
                name: product.name,
                quantity,
                unitPrice: product.price,
                format: product.format,
              }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [cart, products],
  );

  const total = cartItems.reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const itemCount = cartItems.reduce((a, i) => a + i.quantity, 0);

  const setQty = (id: string, qty: number) => setCart((c) => ({ ...c, [id]: Math.max(0, qty) }));

  const placeOrder = async () => {
    if (!profile || cartItems.length === 0) return;
    setPlacing(true);
    try {
      await addDoc(collection(db, "orders"), {
        partnerId: profile.uid,
        partnerName: profile.displayName || profile.email,
        items: cartItems,
        total,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      setCart({});
      toast.success("Commande envoyée, AROM la confirmera prochainement.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Commande impossible.");
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/75 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo-nav.png"
              alt="AROM"
              className="h-9 w-9 rounded-[10px] object-cover ring-1 ring-black/5"
            />
            <p className="font-display text-[17px] font-bold text-primary">Boutique AROM</p>
          </div>
          <button
            onClick={() => signOutUser()}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-3.5 py-2 text-[13px] font-semibold text-secondary-foreground transition active:scale-95"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            Sortir
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-8 px-5 pb-32 pt-2">
        <section>
          <h1 className="pt-4 font-display text-[34px] font-bold leading-tight tracking-tight text-primary">
            Catalogue
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {profile?.displayName || profile?.email}
          </p>

          <div className="mt-5 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
            {products.map((p, i) => (
              <div key={p.id}>
                {i > 0 && <div className="h-px bg-border/70" />}
                <div className="flex items-center gap-3.5 px-4 py-3.5">
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt={p.name}
                      className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-black/5"
                    />
                  ) : (
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-secondary text-[10px] font-medium text-muted-foreground">
                      AROM
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold text-foreground">{p.name}</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {fcFormat(p.price)} / bouteille
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 rounded-full bg-secondary px-1 py-1">
                    <button
                      type="button"
                      onClick={() => setQty(p.id, (cart[p.id] ?? 0) - 1)}
                      disabled={(cart[p.id] ?? 0) <= 0}
                      aria-label={`Retirer ${p.name}`}
                      className="grid h-7 w-7 place-items-center rounded-full bg-card text-primary shadow-sm transition active:scale-90 disabled:opacity-40"
                    >
                      <Minus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <span className="w-4 text-center text-[15px] font-semibold tabular-nums text-foreground">
                      {cart[p.id] ?? 0}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQty(p.id, (cart[p.id] ?? 0) + 1)}
                      aria-label={`Ajouter ${p.name}`}
                      className="grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm transition active:scale-90"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {products.length === 0 && (
              <p className="px-4 py-6 text-center text-[15px] text-muted-foreground">
                Catalogue en préparation.
              </p>
            )}
          </div>
        </section>

        <section>
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mes commandes
          </h2>
          <div className="mt-2 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
            {orders.length === 0 && (
              <p className="px-4 py-6 text-center text-[15px] text-muted-foreground">
                Aucune commande pour l'instant.
              </p>
            )}
            {orders.map((o, i) => (
              <div key={o.id}>
                {i > 0 && <div className="h-px bg-border/70" />}
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-[15px] font-medium text-foreground">
                      {new Date(o.createdAt).toLocaleDateString("fr-FR")}
                    </p>
                    <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                      {o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[15px] font-semibold text-foreground">{fcFormat(o.total)}</p>
                    <span
                      className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[o.status].className}`}
                    >
                      {STATUS_STYLES[o.status].label}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {cartItems.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/85 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
                <ShoppingBag className="h-4.5 w-4.5" aria-hidden />
              </span>
              <div className="leading-tight">
                <p className="text-[13px] text-muted-foreground">
                  {itemCount} bouteille{itemCount > 1 ? "s" : ""}
                </p>
                <p className="font-display text-[17px] font-bold text-primary">{fcFormat(total)}</p>
              </div>
            </div>
            <button
              onClick={placeOrder}
              disabled={placing}
              className="rounded-full bg-primary px-6 py-3 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.97] disabled:opacity-60"
            >
              {placing ? "Envoi…" : "Commander"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
