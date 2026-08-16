import { Minus, Plus, X } from "lucide-react";
import { fcFormat } from "@/lib/erp/model";

interface Product {
  id: string;
  name: string;
  format: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

export function ProductDetailSheet({
  product,
  quantity,
  onClose,
  onSetQty,
}: {
  product: Product | null;
  quantity: number;
  onClose: () => void;
  onSetQty: (qty: number) => void;
}) {
  if (!product) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-3xl bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="h-56 w-full rounded-t-3xl object-cover"
            />
          ) : (
            <div className="grid h-56 w-full place-items-center rounded-t-3xl bg-secondary text-[13px] font-medium text-muted-foreground">
              AROM
            </div>
          )}
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white backdrop-blur-sm"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-5">
          <h2 className="font-display text-[22px] font-bold text-primary">{product.name}</h2>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {product.format} · {fcFormat(product.price)} / bouteille
          </p>
          {product.description && (
            <p className="mt-4 text-[14px] leading-relaxed text-foreground">
              {product.description}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between rounded-2xl bg-card p-3 shadow-sm ring-1 ring-black/5">
            <span className="pl-2 text-[15px] font-medium text-foreground">Quantité</span>
            <div className="flex items-center gap-4 rounded-full bg-secondary px-1.5 py-1.5">
              <button
                type="button"
                onClick={() => onSetQty(Math.max(0, quantity - 1))}
                disabled={quantity <= 0}
                aria-label={`Retirer ${product.name}`}
                className="grid h-8 w-8 place-items-center rounded-full bg-card text-primary shadow-sm transition active:scale-90 disabled:opacity-40"
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <span className="w-5 text-center text-[16px] font-semibold tabular-nums text-foreground">
                {quantity}
              </span>
              <button
                type="button"
                onClick={() => onSetQty(quantity + 1)}
                aria-label={`Ajouter ${product.name}`}
                className="grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm transition active:scale-90"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
