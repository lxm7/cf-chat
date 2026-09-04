import { z } from "zod";
import { base64UrlDecode, base64UrlEncode, fromUtf8, timingSafeEqual, utf8 } from "./encoding.ts";
import {
  type SessionId,
  sessionIdSchema,
  type TenantId,
  tenantIdSchema,
  type UserId,
  userIdSchema,
} from "./ids.ts";

export const SESSION_COOKIE = "cf_chat_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/**
 * The signed cookie is the authority for identity, deliberately.
 *
 * CLAUDE.md forbids read-after-write on KV, which rules out "write the session
 * to KV at login, read it back on the next request". Instead the envelope is
 * HMAC-signed and self-describing, so authentication needs no KV read at all.
 * KV holds a record for audit and a revocation tombstone; absence of a
 * tombstone means valid, so KV's eventual consistency can only ever delay a
 * logout, never grant access the cookie did not already carry.
 */
export interface SessionEnvelope {
  readonly sid: SessionId;
  readonly userId: UserId;
  readonly tenantId: TenantId | null;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

const wireSchema = z.object({
  sid: sessionIdSchema,
  uid: userIdSchema,
  tid: tenantIdSchema.nullable(),
  exp: z.int().positive(),
});

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export async function signSession(envelope: SessionEnvelope, secret: string): Promise<string> {
  const payload = base64UrlEncode(
    utf8(
      JSON.stringify({
        sid: envelope.sid,
        uid: envelope.userId,
        tid: envelope.tenantId,
        exp: envelope.exp,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Returns null for any token that is malformed, mis-signed or expired. */
export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionEnvelope | null> {
  const separator = token.indexOf(".");
  if (separator < 1) {
    return null;
  }
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload)),
  );
  if (!timingSafeEqual(expected, base64UrlDecode(signature))) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(fromUtf8(base64UrlDecode(payload)));
  } catch {
    return null;
  }

  const parsed = wireSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.exp <= nowSeconds) {
    return null;
  }

  return {
    sid: parsed.data.sid,
    userId: parsed.data.uid,
    tenantId: parsed.data.tid,
    exp: parsed.data.exp,
  };
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export const sessionKvKey = (sid: SessionId): string => `session:${sid}`;
export const revocationKvKey = (sid: SessionId): string => `revoked:${sid}`;
