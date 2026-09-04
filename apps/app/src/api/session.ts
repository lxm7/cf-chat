import { env } from "cloudflare:workers";
import {
  newSessionId,
  revocationKvKey,
  SESSION_TTL_SECONDS,
  type SessionId,
  sessionKvKey,
  signSession,
  type TenantId,
  type UserId,
} from "@cf-chat/shared";

export interface IssuedSession {
  readonly token: string;
  readonly maxAgeSeconds: number;
}

export async function issueSession(
  userId: UserId,
  tenantId: TenantId | null,
): Promise<IssuedSession> {
  const sid = newSessionId();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession({ sid, userId, tenantId, exp }, env.SESSION_SECRET);

  // Written for audit and future session listing. Never read back to
  // authorise, which is what keeps this off the read-after-write path that
  // CLAUDE.md rules out for KV.
  await env.KV.put(
    sessionKvKey(sid),
    JSON.stringify({ userId, tenantId, issuedAt: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );

  return { token, maxAgeSeconds: SESSION_TTL_SECONDS };
}

/**
 * Writes a tombstone the session middleware checks. Absence means valid, so KV
 * propagation delay can only postpone a logout taking effect elsewhere, never
 * grant access. The cookie is cleared in the same response, so the browser that
 * logged out is done immediately either way.
 */
export async function revokeSession(sid: SessionId, expSeconds: number): Promise<void> {
  const ttl = Math.max(60, expSeconds - Math.floor(Date.now() / 1000));
  await env.KV.put(revocationKvKey(sid), "1", { expirationTtl: ttl });
}
