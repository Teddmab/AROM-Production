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
  it("is deterministic for the same input", async () => {
    expect(await hashSha256Hex("listing_701")).toBe(await hashSha256Hex("listing_701"));
  });

  it("produces a 64-char lowercase hex string — safe as both a Firestore doc id and Mombongo's Idempotency-Key (1-200 chars, no '/')", async () => {
    const hash = await hashSha256Hex("listing_701");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is case- and whitespace-sensitive (no normalization)", async () => {
    const a = await hashSha256Hex("listing_701");
    const b = await hashSha256Hex("LISTING_701");
    const c = await hashSha256Hex("listing_701 ");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("handles a listingId containing '/' safely (no doc-id-unsafe characters in the output)", async () => {
    const hash = await hashSha256Hex("listing/with/slashes");
    expect(hash).not.toContain("/");
  });

  it("distinct inputs produce distinct hashes", async () => {
    expect(await hashSha256Hex("a")).not.toBe(await hashSha256Hex("b"));
  });
});
