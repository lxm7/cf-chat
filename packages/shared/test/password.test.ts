import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "../src/password.ts";

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
});
