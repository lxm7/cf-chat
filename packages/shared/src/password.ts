import { scrypt as nodeScrypt } from "node:crypto";
import { base64UrlDecode, base64UrlEncode, timingSafeEqual, utf8 } from "./encoding.ts";

/**
 * scrypt via node:crypto, which `nodejs_compat` makes available in the Workers
 * runtime. Memory-hard, so it resists GPU attack in a way PBKDF2 does not.
 *
 * We used PBKDF2-SHA256 at 210,000 iterations until the deployed runtime
 * rejected it: Workers caps PBKDF2 at exactly 100,000 iterations and throws
 * above that. The cap is undocumented, and local workerd does not enforce it,
 * so this only ever appeared in production. 100,000 is six times below OWASP's
 * 2023 figure for PBKDF2-SHA256, which made staying on PBKDF2 the worse trade.
 *
 * Parameters below are OWASP's `N=2^15, r=8, p=3` equivalent. Memory is
 * ~128 * N * r bytes and does not depend on p, so this costs 32MB per hash
 * against a 128MB isolate. `N=2^17, r=8, p=1` also verified working in
 * production but leaves no headroom for a second concurrent login, and the
 * probe could not prove two hashes actually overlap rather than serialise.
 */
const SCHEME = "scrypt";
const N = 32_768;
const R = 8;
const P = 3;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Node's default is 32MB, which is exactly what `N=2^15, r=8` needs and so
 * fails the bounds check by a hair. Doubling it leaves room without inviting a
 * parameter change to allocate unboundedly.
 */
const MAX_MEM = 64 * 1024 * 1024;

/** Legacy PBKDF2 hashes, kept only so pre-existing rows verify. See below. */
const LEGACY_SCHEME = "pbkdf2";
const LEGACY_DIGEST = "sha256";

/**
 * The Workers runtime's hard ceiling. Anything stored above it cannot be
 * verified on the deployed runtime at all, whatever the password.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;

function scryptBytes(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM }, (error, derived) => {
      if (error) reject(error);
      else resolve(new Uint8Array(derived));
    });
  });
}

/** Re-derives with the parameters the stored hash names, not our current ones. */
function scryptBytesWith(
  password: string,
  salt: Uint8Array,
  n: number,
  r: number,
  p: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEM }, (error, derived) => {
      if (error) reject(error);
      else resolve(new Uint8Array(derived));
    });
  });
}

async function legacyPbkdf2Bits(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await scryptBytes(password, salt);
  return [SCHEME, N, R, P, base64UrlEncode(salt), base64UrlEncode(derived)].join("$");
}

async function verifyScrypt(password: string, parts: readonly string[]): Promise<boolean> {
  const [, nRaw, rRaw, pRaw, saltRaw, expectedRaw] = parts;
  if (!nRaw || !rRaw || !pRaw || !saltRaw || !expectedRaw) {
    return false;
  }
  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  // Bound the parameters read off a stored row: they drive an allocation, and a
  // corrupted or hostile row must not be able to ask for an arbitrary one.
  if (n < 1024 || n > 131_072 || r < 1 || r > 16 || p < 1 || p > 16) {
    return false;
  }
  const derived = await scryptBytesWith(password, base64UrlDecode(saltRaw), n, r, p);
  return timingSafeEqual(derived, base64UrlDecode(expectedRaw));
}

async function verifyLegacyPbkdf2(password: string, parts: readonly string[]): Promise<boolean> {
  const [, digest, iterationsRaw, saltRaw, expectedRaw] = parts;
  if (digest !== LEGACY_DIGEST || !iterationsRaw || !saltRaw || !expectedRaw) {
    return false;
  }
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }
  // A hash stored above the runtime cap can never be verified here. Return
  // false rather than letting deriveBits throw: a throw becomes a 500, which
  // both breaks the constant-time login path and tells an attacker that this
  // account is different from one that simply has the wrong password. The
  // account needs an out-of-band reset, which `needsRehash` also reports.
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    return false;
  }
  const derived = await legacyPbkdf2Bits(password, base64UrlDecode(saltRaw), iterations);
  return timingSafeEqual(derived, base64UrlDecode(expectedRaw));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts[0] === SCHEME && parts.length === 6) {
    return verifyScrypt(password, parts);
  }
  if (parts[0] === LEGACY_SCHEME && parts.length === 5) {
    return verifyLegacyPbkdf2(password, parts);
  }
  return false;
}

/**
 * True when a stored hash was produced with anything other than our current
 * scheme and parameters, so the caller can re-hash on the next successful
 * login. Every PBKDF2 hash reports true, including ones still verifiable under
 * the cap: the scheme itself is what we are migrating off.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts[0] !== SCHEME || parts.length !== 6) {
    return true;
  }
  return (
    Number.parseInt(parts[1] ?? "", 10) !== N ||
    Number.parseInt(parts[2] ?? "", 10) !== R ||
    Number.parseInt(parts[3] ?? "", 10) !== P
  );
}

/**
 * A syntactically valid hash that no password matches, for the absent-user path
 * in login. Built with the live parameters so an unknown email costs the same
 * as a known one; a constant with parameters baked in drifts the moment they
 * change, and a stale one that exceeds a runtime cap throws instead of costing
 * anything at all.
 */
export function absentUserHash(): string {
  return [SCHEME, N, R, P, "A".repeat(22), "A".repeat(43)].join("$");
}
