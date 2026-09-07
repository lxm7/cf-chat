import { env } from "cloudflare:test";
import {
  conversationAgentName,
  newConversationId,
  newTenantId,
  newVisitorId,
  newWidgetSiteKey,
  signVisitorToken,
  visitorTokenExpiry,
  type WidgetConfig,
  type WidgetSiteKey,
  widgetConfigKvKey,
} from "@cf-chat/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { admitSocket, type GateDeps, mintSession, readConfig } from "../src/gate.ts";
import { FixtureTurnstile } from "../src/turnstile.ts";

const tenantId = newTenantId();
const ORIGIN = "https://acme.example.com";

let siteKey: WidgetSiteKey;

function deps(turnstile = new FixtureTurnstile(true)): GateDeps {
  return { kv: env.KV, turnstile, tokenSecret: env.WIDGET_TOKEN_SECRET };
}

async function seed(overrides: Partial<WidgetConfig> = {}): Promise<WidgetSiteKey> {
  const key = newWidgetSiteKey();
  const config: WidgetConfig = {
    tenantId,
    origins: [ORIGIN],
    turnstileSiteKey: "0x-public-site-key",
    ...overrides,
  };
  await env.KV.put(widgetConfigKvKey(key), JSON.stringify(config));
  return key;
}

function request(path: string, key: WidgetSiteKey, origin: string | null = ORIGIN): Request {
  return new Request(`https://widget.example.com${path}?k=${key}`, {
    headers: origin ? { origin } : {},
  });
}

beforeEach(async () => {
  siteKey = await seed();
});

describe("readConfig", () => {
  it("reads a seeded config", async () => {
    const found = await readConfig(deps(), siteKey);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.config.tenantId).toBe(tenantId);
  });

  it("refuses a site key that is not in KV", async () => {
    const found = await readConfig(deps(), newWidgetSiteKey());
    expect(found).toEqual({ ok: false, refusal: "unknown_site_key" });
  });

  it("refuses a malformed site key without touching KV", async () => {
    expect(await readConfig(deps(), "not-a-site-key")).toEqual({
      ok: false,
      refusal: "unknown_site_key",
    });
  });

  it("refuses a missing site key", async () => {
    expect(await readConfig(deps(), null)).toEqual({ ok: false, refusal: "unknown_site_key" });
  });

  /** KV is our own store, but a config written by an older dashboard is still a boundary. */
  it("refuses a config that no longer matches the schema", async () => {
    const key = newWidgetSiteKey();
    await env.KV.put(widgetConfigKvKey(key), JSON.stringify({ tenantId: "not-a-uuid" }));
    expect(await readConfig(deps(), key)).toEqual({ ok: false, refusal: "unknown_site_key" });
  });
});

describe("mintSession", () => {
  it("mints a token for an allowlisted origin with a solved challenge", async () => {
    const minted = await mintSession(deps(), request("/session", siteKey), "turnstile-token");
    expect(minted.ok).toBe(true);
    if (minted.ok) expect(minted.value.envelope.tenantId).toBe(tenantId);
  });

  it("passes the visitor IP to Turnstile when the edge supplies one", async () => {
    const turnstile = new FixtureTurnstile(true);
    const withIp = new Request(`https://widget.example.com/session?k=${siteKey}`, {
      headers: { origin: ORIGIN, "cf-connecting-ip": "203.0.113.7" },
    });
    await mintSession(deps(turnstile), withIp, "turnstile-token");
    expect(turnstile.seen).toEqual([{ token: "turnstile-token", remoteIp: "203.0.113.7" }]);
  });

  it("refuses an origin that is not on the allowlist", async () => {
    const other = request("/session", siteKey, "https://evil.example.com");
    expect(await mintSession(deps(), other, "turnstile-token")).toEqual({
      ok: false,
      refusal: "origin_not_allowed",
    });
  });

  /**
   * A suffix check would let `evil-acme.example.com` satisfy a rule written for
   * `acme.example.com`. The comparison is exact, and this is the test that says so.
   */
  it("refuses an origin that merely ends with an allowlisted one", async () => {
    const lookalike = request("/session", siteKey, "https://evil-acme.example.com");
    expect(await mintSession(deps(), lookalike, "turnstile-token")).toEqual({
      ok: false,
      refusal: "origin_not_allowed",
    });
  });

  it("refuses a request with no Origin header at all", async () => {
    expect(await mintSession(deps(), request("/session", siteKey, null), "x")).toEqual({
      ok: false,
      refusal: "origin_not_allowed",
    });
  });

  it("refuses a failed Turnstile solve", async () => {
    const failing = deps(new FixtureTurnstile(false));
    expect(await mintSession(failing, request("/session", siteKey), "bad-token")).toEqual({
      ok: false,
      refusal: "turnstile_failed",
    });
  });

  it("refuses a missing Turnstile token without calling siteverify", async () => {
    const turnstile = new FixtureTurnstile(true);
    expect(await mintSession(deps(turnstile), request("/session", siteKey), null)).toEqual({
      ok: false,
      refusal: "turnstile_failed",
    });
    expect(turnstile.seen).toEqual([]);
  });

  /** The order is the security property: no signature before a solve. */
  it("checks the origin before it calls Turnstile", async () => {
    const turnstile = new FixtureTurnstile(true);
    const other = request("/session", siteKey, "https://evil.example.com");
    await mintSession(deps(turnstile), other, "turnstile-token");
    expect(turnstile.seen).toEqual([]);
  });

  it("mints ids the caller did not choose", async () => {
    const first = await mintSession(deps(), request("/session", siteKey), "t");
    const second = await mintSession(deps(), request("/session", siteKey), "t");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.envelope.conversationId).not.toBe(second.value.envelope.conversationId);
      expect(first.value.envelope.visitorId).not.toBe(second.value.envelope.visitorId);
    }
  });
});

describe("admitSocket", () => {
  async function token(overrides: { tenantId?: typeof tenantId } = {}) {
    return await signVisitorToken(
      {
        tenantId: overrides.tenantId ?? tenantId,
        conversationId: newConversationId(),
        visitorId: newVisitorId(),
        exp: visitorTokenExpiry(),
      },
      env.WIDGET_TOKEN_SECRET,
    );
  }

  it("admits a valid token and derives the agent name from it", async () => {
    const admitted = await admitSocket(deps(), request("/chat", siteKey), await token());
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.value.agentName).toBe(
        conversationAgentName(
          admitted.value.envelope.tenantId,
          admitted.value.envelope.conversationId,
        ),
      );
    }
  });

  it("never calls Turnstile, so a reload does not re-challenge", async () => {
    const turnstile = new FixtureTurnstile(true);
    await admitSocket(deps(turnstile), request("/chat", siteKey), await token());
    expect(turnstile.seen).toEqual([]);
  });

  /**
   * Both tenants' tokens verify against the same signing secret, so the tenant
   * comparison is the only thing stopping a token minted through one tenant's
   * widget being replayed through another's.
   */
  it("refuses a token whose tenant is not the site key's tenant", async () => {
    const foreign = await token({ tenantId: newTenantId() });
    expect(await admitSocket(deps(), request("/chat", siteKey), foreign)).toEqual({
      ok: false,
      refusal: "invalid_token",
    });
  });

  it("refuses an expired token", async () => {
    const stale = await signVisitorToken(
      {
        tenantId,
        conversationId: newConversationId(),
        visitorId: newVisitorId(),
        exp: Math.floor(Date.now() / 1000) - 1,
      },
      env.WIDGET_TOKEN_SECRET,
    );
    expect(await admitSocket(deps(), request("/chat", siteKey), stale)).toEqual({
      ok: false,
      refusal: "invalid_token",
    });
  });

  it("refuses a token signed with another secret", async () => {
    const forged = await signVisitorToken(
      {
        tenantId,
        conversationId: newConversationId(),
        visitorId: newVisitorId(),
        exp: visitorTokenExpiry(),
      },
      "a-different-secret",
    );
    expect(await admitSocket(deps(), request("/chat", siteKey), forged)).toEqual({
      ok: false,
      refusal: "invalid_token",
    });
  });

  it("refuses a missing token", async () => {
    expect(await admitSocket(deps(), request("/chat", siteKey), null)).toEqual({
      ok: false,
      refusal: "invalid_token",
    });
  });

  it("still enforces the origin allowlist", async () => {
    const other = request("/chat", siteKey, "https://evil.example.com");
    expect(await admitSocket(deps(), other, await token())).toEqual({
      ok: false,
      refusal: "origin_not_allowed",
    });
  });
});
