import { describe, expect, it } from "vitest";
import { hashSha256Hex, signHmac, verifyHmac } from "./mombongoSigning";

describe("mombongoSigning", () => {
  it("round-trips: a signature produced by signHmac verifies against the same secret and body", async () => {
    const sig = await signHmac("secret-a", '{"a":1}');
    expect(await verifyHmac("secret-a", '{"a":1}', sig)).toBe(true);
  });

  it("rejects a signature verified against a different body (tamper detection)", async () => {
    const sig = await signHmac("secret-a", '{"a":1}');
    expect(await verifyHmac("secret-a", '{"a":2}', sig)).toBe(false);
  });

  it("rejects a signature verified against a different secret", async () => {
    const sig = await signHmac("secret-a", '{"a":1}');
    expect(await verifyHmac("secret-b", '{"a":1}', sig)).toBe(false);
  });

  it("rejects a missing signature", async () => {
    expect(await verifyHmac("secret-a", '{"a":1}', null)).toBe(false);
    expect(await verifyHmac("secret-a", '{"a":1}', undefined)).toBe(false);
    expect(await verifyHmac("secret-a", '{"a":1}', "")).toBe(false);
  });

  it("rejects a malformed (non-hex, odd-length) signature without throwing", async () => {
    expect(await verifyHmac("secret-a", '{"a":1}', "not-hex!!")).toBe(false);
    expect(await verifyHmac("secret-a", '{"a":1}', "abc")).toBe(false);
  });
});

describe("hashSha256Hex", () => {
  it("is deterministic: the same input always produces the same hash", async () => {
    const a = await hashSha256Hex("listing_701");
    const b = await hashSha256Hex("listing_701");
    expect(a).toBe(b);
  });

  it("always produces a 64-char lowercase hex string, safe as a single Firestore path segment, for any input shape", async () => {
    const inputs = [
      "listing_701",
      "a/b/c", // slashes — the exact thing raw external ids can't safely be used as a doc id for
      "  listing with spaces  ",
      "листинг_ідентифікатор_юнікод_🍍", // unicode incl. an emoji
      "x".repeat(5000), // pathologically long id
      "", // empty string
    ];
    for (const input of inputs) {
      const hash = await hashSha256Hex(input);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("treats case differences as genuinely different inputs — no implicit normalization", async () => {
    const lower = await hashSha256Hex("listing_701");
    const upper = await hashSha256Hex("LISTING_701");
    expect(lower).not.toBe(upper);
  });

  it("treats leading/trailing whitespace as genuinely different from the trimmed value — no implicit normalization", async () => {
    const plain = await hashSha256Hex("listing_701");
    const padded = await hashSha256Hex(" listing_701 ");
    expect(plain).not.toBe(padded);
  });

  it("produces different hashes for different inputs (no trivial collisions across realistic values)", async () => {
    const a = await hashSha256Hex("listing_701");
    const b = await hashSha256Hex("listing_702");
    expect(a).not.toBe(b);
  });
});
