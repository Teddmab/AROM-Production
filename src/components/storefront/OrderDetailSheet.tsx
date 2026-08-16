import { X } from "lucide-react";
import { fcFormat, formatDateOnly } from "@/lib/erp/model";

interface OrderPayment {
  method: "pawapay" | "cash_on_delivery";
  status: "pending" | "completed";
}

interface OrderDetail {
  id: string;
  status: "pending" | "confirmed" | "fulfilled" | "cancelled";
  total: number;
  createdAt: string;
  fulfilledAt?: string;
  deliveryDate?: string;
  items: { productId: string; name: string; quantity: number; unitPrice: number; format: string }[];
  payment?: OrderPayment;
}

const STATUS_STYLES: Record<OrderDetail["status"], { label: string; className: string }> = {
  pending: { label: "En attente", className: "bg-muted text-muted-foreground" },
  confirmed: { label: "Confirmée", className: "bg-gold/20 text-primary" },
  fulfilled: { label: "Livrée", className: "bg-success/15 text-success" },
  cancelled: { label: "Annulée", className: "bg-destructive/10 text-destructive" },
};

function deliveryEstimate(order: OrderDetail): string {
  switch (order.status) {
    case "pending":
      return "En attente de confirmation par AROM.";
    case "confirmed":
      return order.deliveryDate
        ? `Livraison prévue le ${formatDateOnly(order.deliveryDate)}.`
        : "Confirmée — date de livraison à venir.";
    case "fulfilled":
      return order.fulfilledAt
        ? `Livrée le ${new Date(order.fulfilledAt).toLocaleDateString("fr-FR")}.`
        : "Livrée.";
    case "cancelled":
      return "Cette commande a été annulée.";
  }
}

function paymentSummary(order: OrderDetail): { label: string; emphasis: boolean } {
  if (!order.payment) return { label: fcFormat(order.total), emphasis: false };
  if (order.payment.method === "pawapay") {
    return {
      label:
        order.payment.status === "completed"
          ? `Payé par mobile money — ${fcFormat(order.total)}`
          : `Mobile money en attente — ${fcFormat(order.total)}`,
      emphasis: order.payment.status === "completed",
    };
  }
  return { label: `${fcFormat(order.total)} à payer à la livraison`, emphasis: true };
}

export function OrderDetailSheet({
  order,
  onClose,
}: {
  order: OrderDetail | null;
  onClose: () => void;
}) {
  if (!order) return null;
  const payment = paymentSummary(order);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-3xl bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <h2 className="font-display text-[19px] font-bold text-primary">
            Commande du {new Date(order.createdAt).toLocaleDateString("fr-FR")}
          </h2>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-secondary-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-5 py-5">
          <span
            className={`inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold ${STATUS_STYLES[order.status].className}`}
          >
            {STATUS_STYLES[order.status].label}
          </span>
          <p className="mt-2 text-[14px] text-muted-foreground">{deliveryEstimate(order)}</p>

          <div className="mt-4 overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-black/5">
            <ul className="divide-y divide-border/70">
              {order.items.map((i) => (
                <li key={i.productId} className="flex justify-between px-4 py-3 text-[14px]">
                  <span className="text-foreground">
                    {i.quantity} × {i.name}
                    <span className="text-muted-foreground"> ({i.format})</span>
                  </span>
                  <span className="font-medium text-foreground">
                    {fcFormat(i.quantity * i.unitPrice)}
                  </span>
                </li>
              ))}
            </ul>
            <div
              className={`flex items-center justify-between border-t border-border px-4 py-3.5 ${
                payment.emphasis ? "bg-gold/10" : ""
              }`}
            >
              <span className="font-semibold text-primary">Montant</span>
              <span className="font-display text-[15px] font-bold text-primary">
                {payment.label}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
