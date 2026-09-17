import { describe, expect, it } from "vitest";
import { signHmac, verifyHmac } from "./mombongoSigning";

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
