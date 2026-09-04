import { env } from "cloudflare:test";
import {
  newSessionId,
  newTenantId,
  newUserId,
  revocationKvKey,
  SESSION_COOKIE,
  signSession,
} from "@cf-chat/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/index.ts";

const SECRET = "test-secret-not-a-real-key";

async function validToken(): Promise<{ token: string; sid: ReturnType<typeof newSessionId> }> {
  const sid = newSessionId();
  const token = await signSession(
    {
      sid,
      userId: newUserId(),
      tenantId: newTenantId(),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    SECRET,
  );
  return { token, sid };
}

function request(path: string, cookie?: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

describe("api", () => {
  beforeAll(() => {
    // Fail loudly if the pool's bindings drift from what the tests assume.
    expect(env.SESSION_SECRET).toBe(SECRET);
  });

  it("serves health without a session", async () => {
    const response = await api.fetch(request("/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns a structured 404 for an unknown endpoint", async () => {
    const response = await api.fetch(request("/api/nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("rejects a request with no session cookie", async () => {
    const response = await api.fetch(request("/api/auth/me"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("rejects a cookie that is not a valid token", async () => {
    const response = await api.fetch(request("/api/auth/me", "not-a-token"));
    expect(response.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = await signSession(
      {
        sid: newSessionId(),
        userId: newUserId(),
        tenantId: null,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      "attacker-secret",
    );
    const response = await api.fetch(request("/api/auth/me", forged));
    expect(response.status).toBe(401);
  });

  it("rejects a revoked session even though the signature is valid", async () => {
    const { token, sid } = await validToken();
    await env.KV.put(revocationKvKey(sid), "1");

    const response = await api.fetch(request("/api/auth/me", token));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: "Session has been revoked" });
  });
});
