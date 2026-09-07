import { z } from "zod";
import { base64UrlDecode, base64UrlEncode, fromUtf8, timingSafeEqual, utf8 } from "./encoding.ts";
import {
  type ConversationId,
  conversationIdSchema,
  type TenantId,
  tenantIdSchema,
  type VisitorId,
  visitorIdSchema,
} from "./ids.ts";

/**
 * The credential an anonymous widget visitor carries.
 *
 * Build step 4 gated `/agents/*` on a dashboard session, which made the reply
 * loop unreachable by the people it exists for. This replaces that for visitors
 * and leaves the session check as the staff path (ADR-016).
 *
 * The token is minted by the `widget` Worker only after the site key, the origin
 * allowlist and Turnstile have all passed, which is the whole point of its
 * ordering: possession of a valid token therefore means a human solved a
 * challenge. Minting it before the Turnstile check would reduce it to proof of a
 * plausible `Origin` header, and `Origin` is only a header once you are outside
 * a browser.
 *
 * No `typ` discriminator, deliberately. This envelope and `SessionEnvelope` are
 * structurally disjoint (each requires fields the other does not have, and zod
 * rejects the missing ones), and they are signed with different secrets, so a
 * type tag would only defend against a misconfiguration the separate secret
 * already prevents.
 */
export interface VisitorEnvelope {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly visitorId: VisitorId;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

/**
 * Four hours, which is a resumption window as much as an auth lifetime.
 *
 * The widget stores this token and re-presents it, so it is what lets a visitor
 * reload the page, or come back after lunch, and still be in the same
 * conversation. Thirty minutes would have been tighter but would drop threads at
 * exactly the moment a support conversation is still live. The blast radius of a
 * leaked token stays small regardless: it grants one conversation of one tenant
 * and nothing else, and it cannot be exchanged for a dashboard session.
 */
export const VISITOR_TOKEN_TTL_SECONDS = 60 * 60 * 4;

/** The wire form is deliberately terse: this rides on every socket upgrade. */
const wireSchema = z.object({
  tid: tenantIdSchema,
  cid: conversationIdSchema,
  vid: visitorIdSchema,
  exp: z.int().positive(),
});

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export async function signVisitorToken(envelope: VisitorEnvelope, secret: string): Promise<string> {
  const payload = base64UrlEncode(
    utf8(
      JSON.stringify({
        tid: envelope.tenantId,
        cid: envelope.conversationId,
        vid: envelope.visitorId,
        exp: envelope.exp,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Returns null for any token that is malformed, mis-signed or expired.
 *
 * Null rather than a `Result`, matching `verifySession`: the caller's only
 * sensible response to any of those cases is the same 403, and distinguishing
 * them would tell an attacker which part of the token to fix next.
 */
export async function verifyVisitorToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VisitorEnvelope | null> {
  const separator = token.indexOf(".");
  if (separator < 1) {
    return null;
  }
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(payload)),
  );
  // Signature before parse, so a forged payload is never handed to zod.
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
    tenantId: parsed.data.tid,
    conversationId: parsed.data.cid,
    visitorId: parsed.data.vid,
    exp: parsed.data.exp,
  };
}

/** Expiry for a token minted now. */
export function visitorTokenExpiry(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + VISITOR_TOKEN_TTL_SECONDS;
}
