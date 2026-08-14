import { createServerFn } from "@tanstack/react-start";

/**
 * PawaPay integration — stub phase (see AROM-Documentation
 * sprints/08-pawapay-payment-stub.md). The request/response shapes here
 * match PawaPay's real v2 API exactly (fetched from docs.pawapay.io), so
 * swapping the stub bodies below for real `fetch()` calls to
 * api.sandbox.pawapay.io — with a Bearer token from an env var, never
 * sent to the client — is the only change needed once credentials exist.
 * These run as TanStack Start server functions: the code in `.handler()`
 * never ships to the browser.
 */

export type PawapayProvider = "VODACOM_MPESA_COD" | "AIRTEL_COD" | "ORANGE_COD";

export const PAWAPAY_PROVIDERS: { value: PawapayProvider; label: string }[] = [
  { value: "VODACOM_MPESA_COD", label: "Vodacom M-Pesa" },
  { value: "AIRTEL_COD", label: "Airtel Money" },
  { value: "ORANGE_COD", label: "Orange Money" },
];

interface InitiateDepositInput {
  depositId: string;
  phoneNumber: string;
  provider: PawapayProvider;
  amount: number;
  currency: "CDF";
}

type InitiateDepositResult =
  | { status: "ACCEPTED"; depositId: string; created: string }
  | { status: "REJECTED"; failureCode: string; failureMessage: string };

const PHONE_RE = /^\d{9,12}$/;

export const initiatePawapayDeposit = createServerFn({ method: "POST" })
  .validator((input: InitiateDepositInput) => input)
  .handler(async ({ data }): Promise<InitiateDepositResult> => {
    // Real implementation: POST https://api.sandbox.pawapay.io/v2/deposits
    // with { depositId, payer: { type: "MMO", accountDetails: { phoneNumber, provider } },
    // amount: String(amount), currency, clientReferenceId }, Bearer token
    // from a server-only env var. Response is a synchronous ack only —
    // ACCEPTED/DUPLICATE_IGNORED/REJECTED, never the final payment result.
    if (!PHONE_RE.test(data.phoneNumber)) {
      return {
        status: "REJECTED",
        failureCode: "INVALID_PHONE_NUMBER",
        failureMessage: "Numéro de téléphone invalide.",
      };
    }
    if (data.amount <= 0) {
      return {
        status: "REJECTED",
        failureCode: "INVALID_AMOUNT",
        failureMessage: "Montant invalide.",
      };
    }
    return { status: "ACCEPTED", depositId: data.depositId, created: new Date().toISOString() };
  });

type DepositStatus = "ACCEPTED" | "PROCESSING" | "IN_RECONCILIATION" | "COMPLETED" | "FAILED";

interface CheckStatusResult {
  status: "FOUND";
  data: {
    depositId: string;
    status: DepositStatus;
  };
}

export const checkPawapayDepositStatus = createServerFn({ method: "GET" })
  .validator((input: { depositId: string }) => input)
  .handler(async ({ data }): Promise<CheckStatusResult> => {
    // Real implementation: GET https://api.sandbox.pawapay.io/v2/deposits/{depositId},
    // same Bearer token. Real status sequence is
    // ACCEPTED -> PROCESSING -> IN_RECONCILIATION -> COMPLETED|FAILED.
    // Stubbed as an unconditional success — there's no real payment
    // rail behind this yet, so there's nothing to actually poll. The
    // client still does real polling (see storefront/index.tsx) so the
    // UI behaves identically once this is swapped for the real call.
    return { status: "FOUND", data: { depositId: data.depositId, status: "COMPLETED" } };
  });
