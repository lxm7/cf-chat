import { base64UrlDecode, base64UrlEncode, timingSafeEqual, utf8 } from "./encoding.ts";

/**
 * PBKDF2-SHA256 via WebCrypto. Not memory-hard, so weaker than scrypt or
 * argon2id against GPU attack. It is the only KDF guaranteed present in the
 * Workers runtime, which is the trade we accept for the PoC. Revisit before
 * real users: see docs/plan.md.
 */
const SCHEME = "pbkdf2";
const DIGEST = "sha256";
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

async function deriveBits(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(password, salt, ITERATIONS);
  return [SCHEME, DIGEST, ITERATIONS, base64UrlEncode(salt), base64UrlEncode(derived)].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5) {
    return false;
  }
  const [scheme, digest, iterationsRaw, saltRaw, expectedRaw] = parts;
  if (scheme !== SCHEME || digest !== DIGEST || !iterationsRaw || !saltRaw || !expectedRaw) {
    return false;
  }
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }
  const derived = await deriveBits(password, base64UrlDecode(saltRaw), iterations);
  return timingSafeEqual(derived, base64UrlDecode(expectedRaw));
}

/** True when a stored hash was produced with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  const iterationsRaw = parts[2];
  if (parts[0] !== SCHEME || parts[1] !== DIGEST || !iterationsRaw) {
    return true;
  }
  return Number.parseInt(iterationsRaw, 10) < ITERATIONS;
}
