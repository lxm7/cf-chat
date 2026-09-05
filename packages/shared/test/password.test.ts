import { describe, expect, it } from "vitest";
import {
  absentUserHash,
  hashPassword,
  needsRehash,
  PBKDF2_MAX_ITERATIONS,
  verifyPassword,
} from "../src/password.ts";

describe("password hashing", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("produces a different hash each time, so salts are not reused", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["wrong field count", "pbkdf2$sha256$210000$salt"],
    ["unknown scheme", "bcrypt$sha256$210000$c2FsdA$aGFzaA"],
    ["non-numeric iterations", "pbkdf2$sha256$many$c2FsdA$aGFzaA"],
  ])("returns false for a malformed stored hash (%s)", async (_label, stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });

  it("flags hashes weaker than the current parameters", async () => {
    expect(needsRehash(await hashPassword("x".repeat(12)))).toBe(false);
    expect(needsRehash("pbkdf2$sha256$1000$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash("scrypt$sha256$210000$c2FsdA$aGFzaA")).toBe(true);
  });

  it("emits the current scheme, not the legacy one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.split("$")[0]).toBe("scrypt");
    expect(hash.split("$")).toHaveLength(6);
  });

  it("rejects stored parameters that would drive an unbounded allocation", async () => {
    // N far above anything we emit. A corrupted or hostile row must not be
    // able to choose how much memory the verify path asks for.
    expect(await verifyPassword("anything", "scrypt$99999999$8$3$c2FsdA$aGFzaA")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$32768$999$3$c2FsdA$aGFzaA")).toBe(false);
  });
});

describe("legacy PBKDF2 hashes", () => {
  /** Mirrors what hashPassword produced before the move to scrypt. */
  async function legacyHash(password: string, iterations: number): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    );
    const b64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    return ["pbkdf2", "sha256", iterations, b64(salt), b64(new Uint8Array(bits))].join("$");
  }

  it("still verifies a hash at or under the runtime cap", async () => {
    const stored = await legacyHash("correct horse battery staple", PBKDF2_MAX_ITERATIONS);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  it("returns false rather than throwing for a hash above the cap", async () => {
    // 210,000 was the old default. The deployed runtime refuses to derive it at
    // all, so the only safe answer is a plain false: throwing would 500 the
    // login and single this account out from an ordinary wrong password.
    const stored = await legacyHash("correct horse battery staple", 210_000);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(false);
  });

  it("marks every PBKDF2 hash for rehash, cap or no cap", async () => {
    expect(needsRehash(await legacyHash("x".repeat(12), PBKDF2_MAX_ITERATIONS))).toBe(true);
  });
});

describe("absent user hash", () => {
  it("is verifiable without throwing, and matches nothing", async () => {
    // The login path hands this to verifyPassword when the email is unknown, so
    // it has to cost the same as a real verify. A stale constant carrying
    // parameters the runtime rejects would throw instead, which is both a 500
    // and a user-enumeration oracle.
    await expect(verifyPassword("anything at all", absentUserHash())).resolves.toBe(false);
  });

  it("carries the parameters we currently hash with", async () => {
    const [, n, r, p] = absentUserHash().split("$");
    const [, hn, hr, hp] = (await hashPassword("x".repeat(12))).split("$");
    expect([n, r, p]).toEqual([hn, hr, hp]);
  });
});
