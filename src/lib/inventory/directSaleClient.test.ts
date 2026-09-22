import { beforeEach, describe, expect, it, vi } from "vitest";
import { directSaleErrorMessage, submitDirectSale } from "./directSaleClient";

const mockGetIdToken = vi.fn();
let mockCurrentUser: { getIdToken: () => Promise<string> } | null = { getIdToken: mockGetIdToken };

vi.mock("@/lib/firebase/config", () => ({
  get auth() {
    return { currentUser: mockCurrentUser };
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown) {
  return { json: async () => body };
}

const REQUEST = {
  saleId: "VTE-DS-abc-123",
  format: "500 ml",
  quantity: 5,
  prixUnitaire: 5000,
  commerciale: "Alice",
};

beforeEach(() => {
  mockFetch.mockReset();
  mockGetIdToken.mockReset().mockResolvedValue("id-token-123");
  mockCurrentUser = { getIdToken: mockGetIdToken };
});

describe("submitDirectSale", () => {
  it("POSTs to /api/inventory/direct-sale with the caller's own ID token and the full request body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success", alreadyApplied: false }));

    const result = await submitDirectSale(REQUEST);

    expect(result).toEqual({ status: "success", alreadyApplied: false });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/inventory/direct-sale");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer id-token-123" }),
      body: JSON.stringify(REQUEST),
    });
  });

  it("passes the outcome straight through for the caller to interpret (success, invalid_items, insufficient_stock, conflict, error)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "conflict", reason: "sale_id_reused_with_different_request" }),
    );
    expect(await submitDirectSale(REQUEST)).toEqual({
      status: "conflict",
      reason: "sale_id_reused_with_different_request",
    });
  });

  it("reports a network/transport failure as an error outcome, never throwing and never falling back to a direct write", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network request failed"));
    expect(await submitDirectSale(REQUEST)).toEqual({ status: "error", reason: "network_error" });
  });

  it("never calls fetch when no user is signed in", async () => {
    mockCurrentUser = null;
    const result = await submitDirectSale(REQUEST);
    expect(result).toEqual({ status: "error", reason: "not_signed_in" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("directSaleErrorMessage", () => {
  it("translates insufficient_stock with the real shortfall detail", () => {
    const msg = directSaleErrorMessage({
      status: "insufficient_stock",
      shortfalls: [{ format: "500ml", requested: 5, available: 2 }],
    });
    expect(msg).toBe(
      "Stock insuffisant pour cette vente (500ml : 2 disponible(s) sur 5 demandé(s)).",
    );
  });

  it("translates conflict distinctly from insufficient_stock", () => {
    expect(directSaleErrorMessage({ status: "conflict" })).toMatch(/existe déjà/);
  });

  it("translates a not-signed-in error distinctly from a generic one", () => {
    expect(directSaleErrorMessage({ status: "error", reason: "not_signed_in" })).toMatch(
      /connecté/,
    );
    expect(directSaleErrorMessage({ status: "error", reason: "network_error" })).toBe(
      "Une erreur est survenue. Réessayez.",
    );
  });
});
