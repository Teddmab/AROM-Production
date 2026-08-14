import type { OAuthProviderName } from "@/lib/firebase/auth";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.6H24v9h11.8c-.5 2.7-2.1 5.1-4.4 6.6v5.4h7.1c4.2-3.8 6.6-9.5 6.6-16.4z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.6-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.1H4.3v5.7C7.9 41.1 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.6 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.3C2.8 17 2 20.4 2 24s.8 7 2.3 9.9l7.3-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.7c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C34.9 4.1 30 2 24 2 15.4 2 7.9 6.9 4.3 14.1l7.3 5.7c1.7-5.2 6.6-9.1 12.4-9.1z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H8v-2.9h2.4V9.8c0-2.4 1.4-3.7 3.6-3.7 1 0 2.1.2 2.1.2v2.3h-1.2c-1.2 0-1.5.7-1.5 1.5V12H16l-.4 2.9h-2.2v7A10 10 0 0 0 22 12z" />
    </svg>
  );
}

export function OAuthButtons({
  onSelect,
  busy,
}: {
  onSelect: (provider: OAuthProviderName) => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onSelect("google")}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-card py-3.5 text-[15px] font-semibold text-foreground shadow-sm ring-1 ring-black/5 transition active:scale-[0.98] disabled:opacity-60"
      >
        <GoogleIcon />
        Continuer avec Google
      </button>
      <button
        type="button"
        onClick={() => onSelect("facebook")}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-[#1877F2] py-3.5 text-[15px] font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-60"
      >
        <FacebookIcon />
        Continuer avec Facebook
      </button>
    </div>
  );
}
