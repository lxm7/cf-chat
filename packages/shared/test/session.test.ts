import { describe, expect, it } from "vitest";
import { newSessionId, newTenantId, newUserId } from "../src/ids.ts";
import { type SessionEnvelope, signSession, verifySession } from "../src/session.ts";

const SECRET = "test-secret-not-a-real-key";

function envelope(overrides: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    sid: newSessionId(),
    userId: newUserId(),
    tenantId: newTenantId(),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

describe("session envelope", () => {
  it("round-trips a signed envelope", async () => {
    const original = envelope();
    const verified = await verifySession(await signSession(original, SECRET), SECRET);
    expect(verified).toEqual(original);
  });

  it("carries a null tenant for a user with no active workspace", async () => {
    const original = envelope({ tenantId: null });
    const verified = await verifySession(await signSession(original, SECRET), SECRET);
    expect(verified?.tenantId).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(envelope(), SECRET);
    expect(await verifySession(token, "a-different-secret")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(envelope(), SECRET);
    const [payload, signature] = token.split(".");
    const forged = `${payload?.slice(0, -2)}AA.${signature}`;
    expect(await verifySession(forged, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSession(envelope({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects an expiry that has just passed, not just one long gone", async () => {
    const exp = Math.floor(Date.now() / 1000) + 30;
    const token = await signSession(envelope({ exp }), SECRET);
    expect(await verifySession(token, SECRET, exp - 1)).not.toBeNull();
    expect(await verifySession(token, SECRET, exp)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["no payload", ".sig"],
  ])("rejects a malformed token (%s)", async (_label, token) => {
    expect(await verifySession(token, SECRET)).toBeNull();
  });
});
