import { env } from "cloudflare:workers";
import {
  parseConversationAgentName,
  revocationKvKey,
  SESSION_COOKIE,
  verifySession,
} from "@cf-chat/shared";

/**
 * Who is allowed to open a socket to a `Conversation`.
 *
 * The Durable Object takes its tenant from its own name, so whoever chooses the
 * name chooses the tenant. That makes this check the actual isolation boundary
 * for the reply loop, not a convenience: without it, anyone who can guess or
 * observe a `${tenantId}:${conversationId}` pair could read and continue
 * another tenant's conversation.
 *
 * For build step 4 the caller must hold a dashboard session for the tenant it
 * is addressing. That is deliberately narrow. Build step 5 replaces it with the
 * widget's site key, origin allowlist and Turnstile, at which point visitors
 * reach the agent without a session and this becomes the staff path.
 */
export async function isAllowedAgentRequest(request: Request): Promise<boolean> {
  const agentName = conversationNameFrom(new URL(request.url));
  if (!agentName) {
    return false;
  }
  const identity = parseConversationAgentName(agentName);
  if (!identity) {
    return false;
  }

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) {
    return false;
  }

  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) {
    return false;
  }
  if (await env.KV.get(revocationKvKey(session.sid))) {
    return false;
  }

  // The session's active tenant must be the tenant in the name. A signed-in
  // user of one workspace has no business opening another's conversation, and
  // this is the line that says so.
  return session.tenantId === identity.tenantId;
}

/**
 * The instance name out of `/agents/:agent/:name`.
 *
 * Only the `conversation` namespace is routable. `routeAgentRequest` would
 * happily resolve any exported Agent class by its kebab-cased name, so
 * restricting it here keeps a future agent from becoming publicly addressable
 * the moment it is exported.
 */
export function conversationNameFrom(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "agents" || segments[1] !== "conversation") {
    return null;
  }
  return decodeURIComponent(segments[2] ?? "");
}

/** Cookie parsing without pulling Hono into the Worker entry. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}
