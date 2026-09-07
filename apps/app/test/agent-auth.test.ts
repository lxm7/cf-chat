import { env } from "cloudflare:test";
import {
  conversationAgentName,
  newConversationId,
  newSessionId,
  newTenantId,
  newUserId,
  newVisitorId,
  revocationKvKey,
  sessionCookie,
  signSession,
  signVisitorToken,
  visitorTokenExpiry,
} from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import {
  authoriseAgentRequest,
  conversationNameFrom,
  VISITOR_ID_HEADER,
  VISITOR_TOKEN_HEADER,
} from "../src/agent-auth.ts";

const tenantId = newTenantId();
const conversationId = newConversationId();

function agentUrl(name: string): string {
  return `https://app.example.com/agents/conversation/${encodeURIComponent(name)}`;
}

async function visitorToken(
  overrides: { tenantId?: typeof tenantId; conversationId?: typeof conversationId } = {},
) {
  return await signVisitorToken(
    {
      tenantId: overrides.tenantId ?? tenantId,
      conversationId: overrides.conversationId ?? conversationId,
      visitorId: newVisitorId(),
      exp: visitorTokenExpiry(),
    },
    env.WIDGET_TOKEN_SECRET,
  );
}

function visitorRequest(name: string, token: string): Request {
  return new Request(agentUrl(name), { headers: { [VISITOR_TOKEN_HEADER]: token } });
}

async function staffCookie(overrides: { tenantId?: typeof tenantId | null } = {}) {
  const token = await signSession(
    {
      sid: newSessionId(),
      userId: newUserId(),
      tenantId: overrides.tenantId === undefined ? tenantId : overrides.tenantId,
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    env.SESSION_SECRET,
  );
  return sessionCookie(token, 600).split(";")[0] ?? "";
}

describe("authoriseAgentRequest, visitor path", () => {
  it("admits a visitor whose token matches the conversation in the URL", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    const principal = await authoriseAgentRequest(visitorRequest(name, await visitorToken()));
    expect(principal?.kind).toBe("visitor");
    expect(principal).toMatchObject({ tenantId, conversationId });
  });

  /**
   * The failure this whole design exists to prevent: a valid token for one
   * conversation must not open a different one, even inside the same tenant.
   */
  it("rejects a valid token pointed at another conversation", async () => {
    const other = conversationAgentName(tenantId, newConversationId());
    expect(await authoriseAgentRequest(visitorRequest(other, await visitorToken()))).toBeNull();
  });

  it("rejects a valid token pointed at another tenant", async () => {
    const other = conversationAgentName(newTenantId(), conversationId);
    expect(await authoriseAgentRequest(visitorRequest(other, await visitorToken()))).toBeNull();
  });

  it("rejects a token signed with the session secret", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    const forged = await signVisitorToken(
      {
        tenantId,
        conversationId,
        visitorId: newVisitorId(),
        exp: visitorTokenExpiry(),
      },
      env.SESSION_SECRET,
    );
    expect(await authoriseAgentRequest(visitorRequest(name, forged))).toBeNull();
  });

  it("rejects an expired token", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    const expired = await signVisitorToken(
      {
        tenantId,
        conversationId,
        visitorId: newVisitorId(),
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      env.WIDGET_TOKEN_SECRET,
    );
    expect(await authoriseAgentRequest(visitorRequest(name, expired))).toBeNull();
  });
});

describe("authoriseAgentRequest, staff path", () => {
  it("admits a session whose active tenant matches the name", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    const request = new Request(agentUrl(name), { headers: { cookie: await staffCookie() } });
    const principal = await authoriseAgentRequest(request);
    expect(principal?.kind).toBe("staff");
    expect(principal).toMatchObject({ tenantId });
  });

  it("rejects a session for another tenant", async () => {
    const name = conversationAgentName(newTenantId(), conversationId);
    const request = new Request(agentUrl(name), { headers: { cookie: await staffCookie() } });
    expect(await authoriseAgentRequest(request)).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const sid = newSessionId();
    const token = await signSession(
      { sid, userId: newUserId(), tenantId, exp: Math.floor(Date.now() / 1000) + 600 },
      env.SESSION_SECRET,
    );
    await env.KV.put(revocationKvKey(sid), "1");
    const name = conversationAgentName(tenantId, conversationId);
    const request = new Request(agentUrl(name), {
      headers: { cookie: `${sessionCookie(token, 600).split(";")[0]}` },
    });
    expect(await authoriseAgentRequest(request)).toBeNull();
  });

  it("rejects a request with no credential at all", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    expect(await authoriseAgentRequest(new Request(agentUrl(name)))).toBeNull();
  });

  /**
   * A visitor token present means the visitor path, full stop. Falling back to
   * the staff check on a bad token would let a caller probe both gates with one
   * request.
   */
  it("does not fall back to the staff path when a visitor token is present but bad", async () => {
    const name = conversationAgentName(tenantId, conversationId);
    const request = new Request(agentUrl(name), {
      headers: { [VISITOR_TOKEN_HEADER]: "not-a-token", cookie: await staffCookie() },
    });
    expect(await authoriseAgentRequest(request)).toBeNull();
  });
});

describe("conversationNameFrom", () => {
  it("reads the instance name", () => {
    const name = conversationAgentName(tenantId, conversationId);
    expect(conversationNameFrom(new URL(agentUrl(name)))).toBe(name);
  });

  it("refuses any agent namespace but conversation", () => {
    expect(conversationNameFrom(new URL("https://app.example.com/agents/presence/x"))).toBeNull();
  });

  it("refuses a path with the wrong number of segments", () => {
    expect(conversationNameFrom(new URL("https://app.example.com/agents/conversation"))).toBeNull();
  });
});

/**
 * `server.ts` stamps the verified visitor id onto the request before routing.
 * Rebuilding a Request is the part worth testing in the real runtime rather than
 * assuming: an upgrade request carries headers workerd treats specially, and if
 * the clone dropped or refused them the visitor id would silently never arrive.
 */
describe("rebuilding an upgrade request with an extra header", () => {
  it("preserves the upgrade header and overwrites a client-supplied visitor id", () => {
    const original = new Request("https://app.example.com/agents/conversation/x", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        [VISITOR_ID_HEADER]: "a-value-the-client-made-up",
      },
    });

    const headers = new Headers(original.headers);
    headers.set(VISITOR_ID_HEADER, "the-verified-one");
    const rebuilt = new Request(original, { headers });

    expect(rebuilt.headers.get("upgrade")).toBe("websocket");
    expect(rebuilt.headers.get(VISITOR_ID_HEADER)).toBe("the-verified-one");
    expect(rebuilt.url).toBe(original.url);
  });
});
