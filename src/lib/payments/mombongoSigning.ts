/**
 * HMAC-SHA256 signing/verification shared by mombongo.ts (outbound calls
 * to Mombongo) and routes/api/webhooks/mombongo.ts (their inbound
 * callback) — matches their published contract's §2 exactly: hex
 * HMAC-SHA256 of the *exact raw bytes* sent/received, never a
 * re-serialized copy. Uses Web Crypto (`crypto.subtle`), not Node's
 * `crypto` module — this runs inside the Cloudflare Worker, where
 * `crypto.subtle` is native and `node:crypto` is not reliably available.
 */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Signs `body` (the exact string that will be sent as the request payload) with `secret`, returning a hex digest. */
export async function signHmac(secret: string, body: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return bytesToHex(signature);
}

/**
 * Deterministic, always-safe Firestore document id derivation (2026-09,
 * offer-submission idempotency hardening) — used to turn an external
 * partner-supplied identifier (Mombongo's own `listingId`) into a doc id
 * without trusting its raw shape (length, `/`, unicode, whitespace).
 * SHA-256 hex is fixed-length (64 chars, well under Firestore's 1500-byte
 * limit), contains no `/`, and is stable for the exact same input string
 * — no case-folding or trimming, since nothing in Mombongo's contract
 * documents listingId as case-insensitive or whitespace-tolerant; two
 * strings differing only by case or trailing whitespace are treated as
 * genuinely different listings, matching how the rest of this
 * integration already treats Mombongo's own field values literally (see
 * harvest-listings.tsx's own commodity-casing lesson on AROM-Mobile).
 */
export async function hashSha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(digest);
}

/**
 * Verifies `signatureHex` against `body` using `crypto.subtle.verify`
 * (constant-time by construction) rather than a manual string/byte
 * comparison — avoids reimplementing timing-safe comparison ourselves.
 */
export async function verifyHmac(
  secret: string,
  body: string,
  signatureHex: string | undefined | null,
): Promise<boolean> {
  if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0)
    return false;
  const key = await importHmacKey(secret);
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBytes(signatureHex) as BufferSource,
      new TextEncoder().encode(body),
    );
  } catch {
    return false;
  }
}
