import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { toast } from "sonner";
import logoAsset from "@/assets/arom-logo.asset.json";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/firebase/auth";
import { RequireRole } from "@/lib/firebase/require-role";
import { fcFormat } from "@/lib/erp/model";

export const Route = createFileRoute("/storefront/")({
  component: StorefrontRoute,
  head: () => ({
    meta: [{ title: "Boutique partenaire — AROM" }],
  }),
});

interface Product {
  id: string;
  name: string;
  format: string;
  price: number;
  active: boolean;
}

interface Order {
  id: string;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  total: number;
  createdAt: string;
  items: { productId: string; name: string; quantity: number; unitPrice: number; format: string }[];
}

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
      toast.success("Commande envoyée — AROM la confirmera prochainement.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Commande impossible.");
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-3">
            <img
              src={logoAsset.url}
              alt="AROM"
              className="h-10 w-10 rounded-full object-cover ring-2 ring-gold/40"
            />
            <div className="leading-tight">
              <p className="font-display text-lg font-bold text-primary">AROM</p>
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-gold">
                Boutique partenaire
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right leading-tight">
              <p className="text-xs font-semibold text-primary">
                {profile?.displayName || profile?.email}
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Partenaire
              </p>
            </div>
            <button
              onClick={() => signOutUser()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:text-primary"
            >
              Déconnexion
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-10 px-6 py-10">
        <section>
          <h1 className="font-display text-2xl font-bold text-primary">Catalogue</h1>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <div key={p.id} className="rounded-2xl border border-border bg-card p-5">
                <p className="font-display text-lg font-semibold text-primary">{p.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{fcFormat(p.price)} / unité</p>
                <div className="mt-4 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={cart[p.id] ?? 0}
                    onChange={(e) => setQty(p.id, Number(e.target.value) || 0)}
                    className="w-20 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
                  />
                  <span className="text-xs text-muted-foreground">bouteilles</span>
                </div>
              </div>
            ))}
            {products.length === 0 && (
              <p className="text-sm text-muted-foreground">Catalogue en préparation.</p>
            )}
          </div>
        </section>

        {cartItems.length > 0 && (
          <section className="rounded-2xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-primary">Panier</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {cartItems.map((i) => (
                <li key={i.productId} className="flex items-center justify-between">
                  <span>
                    {i.quantity} × {i.name}
                  </span>
                  <span className="font-medium">{fcFormat(i.quantity * i.unitPrice)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
              <span className="font-semibold text-primary">Total</span>
              <span className="font-display text-xl font-bold text-primary">{fcFormat(total)}</span>
            </div>
            <button
              onClick={placeOrder}
              disabled={placing}
              className="mt-4 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {placing ? "Envoi…" : "Envoyer la commande"}
            </button>
          </section>
        )}

        <section>
          <h2 className="font-display text-lg font-semibold text-primary">Mes commandes</h2>
          <div className="mt-4 space-y-3">
            {orders.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucune commande pour l'instant.</p>
            )}
            {orders.map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between rounded-xl border border-border bg-card p-4 text-sm"
              >
                <div>
                  <p className="font-medium text-primary">
                    {new Date(o.createdAt).toLocaleDateString("fr-FR")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-primary">{fcFormat(o.total)}</p>
                  <p className="text-xs capitalize text-muted-foreground">{o.status}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
