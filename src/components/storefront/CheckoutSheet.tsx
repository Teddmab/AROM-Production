import { useState } from "react";
import { addDoc, collection } from "firebase/firestore";
import { CheckCircle2, ChevronLeft, Smartphone, Truck, X } from "lucide-react";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/firebase/auth";
import { fcFormat } from "@/lib/erp/model";
import {
  PAWAPAY_PROVIDERS,
  checkPawapayDepositStatus,
  initiatePawapayDeposit,
  type PawapayProvider,
} from "@/lib/payments/pawapay";

interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  format: string;
}

type Step = "method" | "mobile-money" | "processing" | "success" | "error";

async function pollUntilSettled(depositId: string, maxAttempts = 8, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await checkPawapayDepositStatus({ data: { depositId } });
    if (res.data.status === "COMPLETED" || res.data.status === "FAILED") return res.data.status;
  }
  return "TIMEOUT" as const;
}

export function CheckoutSheet({
  open,
  onClose,
  cartItems,
  total,
  onOrderPlaced,
}: {
  open: boolean;
  onClose: () => void;
  cartItems: CartItem[];
  total: number;
  onOrderPlaced: () => void;
}) {
  const { profile } = useAuth();
  const [step, setStep] = useState<Step>("method");
  const [phoneNumber, setPhoneNumber] = useState("243");
  const [provider, setProvider] = useState<PawapayProvider>("VODACOM_MPESA_COD");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setStep("method");
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const createOrder = async (payment: Record<string, unknown>) => {
    if (!profile) return;
    await addDoc(collection(db, "orders"), {
      partnerId: profile.uid,
      partnerName: profile.displayName || profile.email,
      items: cartItems,
      total,
      status: "pending",
      createdAt: new Date().toISOString(),
      payment,
    });
  };

  const payCashOnDelivery = async () => {
    setStep("processing");
    try {
      await createOrder({ method: "cash_on_delivery", status: "pending" });
      setStep("success");
    } catch {
      setError("Commande impossible. Réessayez.");
      setStep("error");
    }
  };

  const payMobileMoney = async () => {
    if (!/^\d{9,12}$/.test(phoneNumber)) {
      setError("Numéro de téléphone invalide (indicatif pays inclus, sans le 0 initial).");
      return;
    }
    setError(null);
    setStep("processing");
    const depositId = crypto.randomUUID();
    try {
      const initResult = await initiatePawapayDeposit({
        data: { depositId, phoneNumber, provider, amount: total, currency: "CDF" },
      });
      if (initResult.status === "REJECTED") {
        setError(initResult.failureMessage);
        setStep("mobile-money");
        return;
      }
      const finalStatus = await pollUntilSettled(depositId);
      if (finalStatus === "COMPLETED") {
        await createOrder({
          method: "pawapay",
          status: "completed",
          depositId,
          provider,
          amount: total,
          currency: "CDF",
          updatedAt: new Date().toISOString(),
        });
        setStep("success");
      } else {
        setError(
          "Le paiement n'a pas pu être confirmé. Réessayez, ou choisissez le paiement à la livraison.",
        );
        setStep("mobile-money");
      }
    } catch {
      setError("Une erreur est survenue. Réessayez.");
      setStep("mobile-money");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-3xl bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div className="flex items-center gap-2">
            {step === "mobile-money" && (
              <button
                onClick={() => setStep("method")}
                aria-label="Retour"
                className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-secondary-foreground"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
            )}
            <h2 className="font-display text-[19px] font-bold text-primary">
              {step === "success" ? "Commande envoyée" : "Paiement"}
            </h2>
          </div>
          <button
            onClick={handleClose}
            aria-label="Fermer"
            className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-secondary-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-5 py-5">
          {(step === "method" || step === "mobile-money") && (
            <div className="mb-5 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-black/5">
              <ul className="space-y-1.5 text-[14px]">
                {cartItems.map((i) => (
                  <li key={i.productId} className="flex justify-between text-foreground">
                    <span>
                      {i.quantity} × {i.name}
                    </span>
                    <span className="font-medium">{fcFormat(i.quantity * i.unitPrice)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex justify-between border-t border-border pt-3">
                <span className="font-semibold text-primary">Total</span>
                <span className="font-display text-lg font-bold text-primary">
                  {fcFormat(total)}
                </span>
              </div>
            </div>
          )}

          {step === "method" && (
            <div className="space-y-3">
              <button
                onClick={() => setStep("mobile-money")}
                className="flex w-full items-center gap-3.5 rounded-2xl bg-card p-4 text-left shadow-sm ring-1 ring-black/5 transition active:scale-[0.98]"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Smartphone className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-foreground">
                    Mobile money
                  </span>
                  <span className="block text-[13px] text-muted-foreground">
                    Vodacom M-Pesa, Airtel Money, Orange Money
                  </span>
                </span>
              </button>
              <button
                onClick={payCashOnDelivery}
                className="flex w-full items-center gap-3.5 rounded-2xl bg-card p-4 text-left shadow-sm ring-1 ring-black/5 transition active:scale-[0.98]"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gold/15 text-primary">
                  <Truck className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-foreground">
                    Paiement à la livraison
                  </span>
                  <span className="block text-[13px] text-muted-foreground">
                    Réglez en espèces à la réception
                  </span>
                </span>
              </button>
            </div>
          )}

          {step === "mobile-money" && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as PawapayProvider)}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground focus:outline-none"
                >
                  {PAWAPAY_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <div className="h-px bg-border/70" />
                <input
                  type="tel"
                  inputMode="numeric"
                  placeholder="Numéro (ex. 243812345678)"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d]/g, ""))}
                  className="w-full bg-transparent px-4 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
              </div>
              {error && <p className="px-1 text-[13px] font-medium text-destructive">{error}</p>}
              <button
                onClick={payMobileMoney}
                className="w-full rounded-2xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
              >
                Payer {fcFormat(total)}
              </button>
            </div>
          )}

          {step === "processing" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary" />
              <p className="text-[15px] font-medium text-foreground">Traitement en cours…</p>
              <p className="text-[13px] text-muted-foreground">Ne fermez pas cette fenêtre.</p>
            </div>
          )}

          {step === "success" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
                <CheckCircle2 className="h-8 w-8" aria-hidden />
              </span>
              <p className="text-[15px] font-medium text-foreground">
                Commande envoyée — AROM la confirmera prochainement.
              </p>
              <button
                onClick={() => {
                  reset();
                  onOrderPlaced();
                }}
                className="mt-2 rounded-2xl bg-primary px-6 py-3 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
              >
                Voir mes commandes
              </button>
            </div>
          )}

          {step === "error" && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[15px] font-medium text-destructive">{error}</p>
              <button
                onClick={() => setStep("method")}
                className="mt-2 rounded-2xl bg-primary px-6 py-3 text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-[0.98]"
              >
                Réessayer
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
