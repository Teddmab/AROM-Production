import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMombongoCheckout, createMombongoInvoice, signedMombongoPost } from "./mombongo";
import { getMombongoConfig } from "./mombongoConfig";
import { signHmac } from "./mombongoSigning";
import { getUsdToCdfRate } from "./exchangeRate";

/**
 * Covers the outbound side of the boundary the repo audit flagged as
 * currently unreachable (Mombongo's own API is returning 500/503) — these
 * tests mock the partner boundary itself (global fetch), so they don't
 * depend on Mombongo's availability at all, per the stabilization
 * instructions.
 */

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
const updateDocCalls: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
vi.mock("./mombongoSigning", () => ({ signHmac: vi.fn().mockResolvedValue("deadbeef") }));
vi.mock("./exchangeRate", () => ({
  getUsdToCdfRate: vi.fn(),
  convertFcToUsd: (amountFc: number, rate: number) => Math.round((amountFc / rate) * 100) / 100,
}));

vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` })),
  getDoc: vi.fn(async (ref: { path: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data };
  }),
  updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
    updateDocCalls.push({ path: ref.path, data });
  }),
}));

const FAKE_CONFIG = {
  baseUrl: "https://example.invalid",
  partnerId: "partner-1",
  inboundSigningSecret: "TOP_SECRET_INBOUND",
  outboundVerifySecret: "TOP_SECRET_OUTBOUND",
  active: true,
};

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      json: async () => body,
    }),
  );
}

beforeEach(() => {
  mockRegistry = {};
  updateDocCalls.length = 0;
  vi.mocked(getMombongoConfig).mockReset().mockResolvedValue(FAKE_CONFIG);
});

describe("signedMombongoPost", () => {
  it("signs the exact raw JSON body and includes partner id + signature headers", async () => {
    mockFetchOnce(200, { ok: true });
    await signedMombongoPost("/somePath", { a: 1 });
    expect(signHmac).toHaveBeenCalledWith(
      FAKE_CONFIG.inboundSigningSecret,
      JSON.stringify({ a: 1 }),
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      "x-partner-id": FAKE_CONFIG.partnerId,
      "x-partner-signature": "deadbeef",
    });
  });

  it("merges extraHeaders (e.g. contract v2's Idempotency-Key) without disturbing the standard ones", async () => {
    mockFetchOnce(200, { ok: true });
    await signedMombongoPost("/somePath", { a: 1 }, { "Idempotency-Key": "key-1" });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      "x-partner-id": FAKE_CONFIG.partnerId,
      "x-partner-signature": "deadbeef",
      "Idempotency-Key": "key-1",
    });
  });

  it("every other caller (no extraHeaders) is byte-for-byte unaffected", async () => {
    mockFetchOnce(200, { ok: true });
    await signedMombongoPost("/somePath", { a: 1 });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).sort()).toEqual(
      ["content-type", "x-partner-id", "x-partner-signature"].sort(),
    );
  });
});

describe("createMombongoInvoice", () => {
  it("returns not_found when the local producerInvoices doc doesn't exist", async () => {
    const result = await createMombongoInvoice({ producerInvoiceId: "missing" });
    expect(result.status).toBe("not_found");
  });

  it("sends the USD amount directly for a USD invoice, no conversion", async () => {
    mockRegistry["producerInvoices/inv1"] = {
      exists: true,
      data: { devise: "USD", montantTotal: 100, dateEcheance: "2026-10-01" },
    };
    mockFetchOnce(200, { status: "accepted", invoiceId: "mb1" });
    const result = await createMombongoInvoice({ producerInvoiceId: "inv1" });
    expect(result).toEqual({ status: "accepted", mombongoInvoiceId: "mb1" });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).amountUsd).toBe(100);
  });

  it("converts FC/CDF to USD using the configured rate before sending", async () => {
    mockRegistry["producerInvoices/inv2"] = {
      exists: true,
      data: { devise: "FC", montantTotal: 200000, dateEcheance: "2026-10-01" },
    };
    vi.mocked(getUsdToCdfRate).mockResolvedValue(2000);
    mockFetchOnce(200, { status: "accepted", invoiceId: "mb2" });
    await createMombongoInvoice({ producerInvoiceId: "inv2" });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).amountUsd).toBe(100);
  });

  it("fails closed with unsupported_currency for an unrecognized currency", async () => {
    mockRegistry["producerInvoices/inv3"] = {
      exists: true,
      data: { devise: "EUR", montantTotal: 10 },
    };
    const result = await createMombongoInvoice({ producerInvoiceId: "inv3" });
    expect(result.status).toBe("unsupported_currency");
  });

  it("maps a 503 (Mombongo's current live state) to a stable error result, not a throw", async () => {
    mockRegistry["producerInvoices/inv4"] = {
      exists: true,
      data: { devise: "USD", montantTotal: 10 },
    };
    mockFetchOnce(503, { message: "service not available yet" });
    const result = await createMombongoInvoice({ producerInvoiceId: "inv4" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.httpStatus).toBe(503);
  });

  it("maps a 500 to a stable error result", async () => {
    mockRegistry["producerInvoices/inv5"] = {
      exists: true,
      data: { devise: "USD", montantTotal: 10 },
    };
    mockFetchOnce(500, { message: "server encountered an error" });
    const result = await createMombongoInvoice({ producerInvoiceId: "inv5" });
    expect(result.status).toBe("error");
  });

  it("never includes a signing secret in its returned result", async () => {
    mockRegistry["producerInvoices/inv6"] = {
      exists: true,
      data: { devise: "USD", montantTotal: 10 },
    };
    mockFetchOnce(500, {});
    const result = await createMombongoInvoice({ producerInvoiceId: "inv6" });
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
  });
});

describe("createMombongoCheckout", () => {
  const input = {
    producerInvoiceId: "inv1",
    mombongoInvoiceId: "mb1",
    method: "mobile_money" as const,
    phone: "+243900000000",
    operator: "airtel" as const,
  };

  it("maps 409 to already_in_progress", async () => {
    mockFetchOnce(409, {});
    const result = await createMombongoCheckout(input);
    expect(result.status).toBe("already_in_progress");
    expect(updateDocCalls).toHaveLength(0);
  });

  it("maps 404 to not_found", async () => {
    mockFetchOnce(404, {});
    expect((await createMombongoCheckout(input)).status).toBe("not_found");
  });

  it("maps 502 to provider_error", async () => {
    mockFetchOnce(502, {});
    expect((await createMombongoCheckout(input)).status).toBe("provider_error");
  });

  it("on success, writes paiement_en_attente + mombongoCheckout to the producerInvoices doc", async () => {
    mockFetchOnce(200, {
      status: "checkout_created",
      providerRef: "pr1",
      depositStatus: "pending",
    });
    const result = await createMombongoCheckout(input);
    expect(result).toMatchObject({ status: "checkout_created", providerRef: "pr1" });
    expect(updateDocCalls).toHaveLength(1);
    expect(updateDocCalls[0].path).toBe("producerInvoices/inv1");
    expect(updateDocCalls[0].data.statut).toBe("paiement_en_attente");
    expect(updateDocCalls[0].data.mombongoInvoiceId).toBe("mb1");
  });
});
