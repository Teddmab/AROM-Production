import { Megaphone } from "lucide-react";

export interface Promo {
  active: boolean;
  headline: string;
  description?: string;
  productId?: string;
  startDate?: string;
  endDate?: string;
}

export function isPromoLive(promo: Promo | null): promo is Promo {
  if (!promo || !promo.active || !promo.headline) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (promo.startDate && today < promo.startDate) return false;
  if (promo.endDate && today > promo.endDate) return false;
  return true;
}

export function PromoBanner({
  promo,
  onProductClick,
}: {
  promo: Promo;
  onProductClick: (productId: string) => void;
}) {
  const clickable = Boolean(promo.productId);

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => promo.productId && onProductClick(promo.productId)}
      className={`mb-4 flex w-full items-start gap-3 rounded-2xl bg-gradient-to-br from-primary to-primary/85 px-4 py-3.5 text-left shadow-lg shadow-primary/25 transition ${clickable ? "active:scale-[0.98]" : ""}`}
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/15 text-white">
        <Megaphone className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-primary-foreground">
          {promo.headline}
        </span>
        {promo.description && (
          <span className="mt-0.5 block text-[13px] text-primary-foreground/85">
            {promo.description}
          </span>
        )}
      </span>
    </button>
  );
}
