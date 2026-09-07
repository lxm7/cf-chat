import { describe, expect, it } from "vitest";
import {
  newConversationId,
  newSessionId,
  newTenantId,
  newUserId,
  newVisitorId,
} from "../src/ids.ts";
import { signSession, verifySession } from "../src/session.ts";
import {
  signVisitorToken,
  VISITOR_TOKEN_TTL_SECONDS,
  type VisitorEnvelope,
  verifyVisitorToken,
  visitorTokenExpiry,
} from "../src/visitor.ts";

const SECRET = "test-visitor-secret-not-a-real-key";
const SESSION_SECRET = "test-session-secret-not-a-real-key";

function envelope(overrides: Partial<VisitorEnvelope> = {}): VisitorEnvelope {
  return {
    tenantId: newTenantId(),
    conversationId: newConversationId(),
    visitorId: newVisitorId(),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

describe("visitor token", () => {
  it("round-trips a signed envelope", async () => {
    const original = envelope();
    const verified = await verifyVisitorToken(await signVisitorToken(original, SECRET), SECRET);
    expect(verified).toEqual(original);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signVisitorToken(envelope(), SECRET);
    expect(await verifyVisitorToken(token, "a-different-secret")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signVisitorToken(envelope(), SECRET);
    const [payload, signature] = token.split(".");
    const forged = `${payload?.slice(0, -2)}AA.${signature}`;
    expect(await verifyVisitorToken(forged, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signVisitorToken(
      envelope({ exp: Math.floor(Date.now() / 1000) - 1 }),
      SECRET,
    );
    expect(await verifyVisitorToken(token, SECRET)).toBeNull();
  });

  it("rejects a token with no signature separator", async () => {
    expect(await verifyVisitorToken("not-a-token", SECRET)).toBeNull();
  });

  /**
   * The reason the two token types get separate secrets. If these ever shared
   * one, a dashboard session would still fail here on shape, but the shape check
   * is the second line of defence and this test guards the first.
   */
  it("does not accept a dashboard session token", async () => {
    const session = await signSession(
      {
        sid: newSessionId(),
        userId: newUserId(),
        tenantId: newTenantId(),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SESSION_SECRET,
    );
    expect(await verifyVisitorToken(session, SESSION_SECRET)).toBeNull();
  });

  /** And the same in reverse: a visitor must never become a signed-in user. */
  it("is not accepted as a dashboard session token", async () => {
    const token = await signVisitorToken(envelope(), SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET)).toBeNull();
  });

  it("mints an expiry one TTL ahead of the supplied clock", () => {
    expect(visitorTokenExpiry(1_000)).toBe(1_000 + VISITOR_TOKEN_TTL_SECONDS);
  });

  it("treats a token expiring exactly now as expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signVisitorToken(envelope({ exp: now }), SECRET);
    expect(await verifyVisitorToken(token, SECRET, now)).toBeNull();
  });

  it("accepts a token one second before expiry, so a live conversation survives", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signVisitorToken(envelope({ exp: now + 1 }), SECRET);
    expect(await verifyVisitorToken(token, SECRET, now)).not.toBeNull();
  });
});
