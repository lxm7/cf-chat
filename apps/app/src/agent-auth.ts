import { env } from "cloudflare:workers";
import {
  type ConversationId,
  conversationAgentName,
  parseConversationAgentName,
  revocationKvKey,
  SESSION_COOKIE,
  type TenantId,
  type UserId,
  type VisitorId,
  verifySession,
  verifyVisitorToken,
} from "@cf-chat/shared";

/**
 * The header the `widget` Worker uses to present a visitor token.
 *
 * A header rather than a query parameter because this hop is a service-binding
 * fetch that `widget` constructs (ADR-008), so nothing from the browser reaches
 * it. The browser's own hop cannot use a header at all: `WebSocket` gives no way
 * to set one on the upgrade, so the token arrives at `widget` in the query
 * string and is moved here.
 */
export const VISITOR_TOKEN_HEADER = "x-cf-chat-visitor-token";

/**
 * The visitor id `app` has verified, handed to the Durable Object.
 *
 * `onChatMessage` sees only client-supplied data, so this is the one channel
 * that carries an identity the agent can trust. `app` always sets it, which
 * overwrites anything a caller tried to send under the same name.
 */
export const VISITOR_ID_HEADER = "x-cf-chat-visitor-id";

/**
 * Who is allowed to open a socket to a `Conversation`, and as what.
 *
 * The Durable Object takes its tenant from its own name, so whoever chooses the
 * name chooses the tenant. That makes this check the actual isolation boundary
 * for the reply loop, not a convenience: without it, anyone who can guess or
 * observe a `${tenantId}:${conversationId}` pair could read and continue
 * another tenant's conversation.
 *
 * Two principals reach it. Staff hold a dashboard session, which is what build
 * step 4 shipped. Visitors hold a signed visitor token minted by `widget` after
 * the site key, the origin allowlist and Turnstile all passed (ADR-016). Both
 * are verified here rather than trusted from `widget`: a service binding makes
 * `widget` a convenient place to put the gates, not an authority.
 */
export type AgentPrincipal =
  | { readonly kind: "staff"; readonly tenantId: TenantId; readonly userId: UserId }
  | {
      readonly kind: "visitor";
      readonly tenantId: TenantId;
      readonly conversationId: ConversationId;
      readonly visitorId: VisitorId;
    };

/** Null means not authorised, for every reason. The caller's answer is one 403. */
export async function authoriseAgentRequest(request: Request): Promise<AgentPrincipal | null> {
  const agentName = conversationNameFrom(new URL(request.url));
  if (!agentName) {
    return null;
  }
  const identity = parseConversationAgentName(agentName);
  if (!identity) {
    return null;
  }

  const token = request.headers.get(VISITOR_TOKEN_HEADER);
  if (token) {
    return await authoriseVisitor(token, agentName);
  }
  return await authoriseStaff(request, identity.tenantId);
}

/**
 * The visitor path.
 *
 * The name is rebuilt from the token and compared, rather than the token's
 * tenant being compared against a name parsed from the URL. Both would pass the
 * same inputs today, but deriving means a future change to the naming scheme
 * cannot leave a comparison that silently checks less than it looks like it
 * checks.
 */
async function authoriseVisitor(token: string, agentName: string): Promise<AgentPrincipal | null> {
  const visitor = await verifyVisitorToken(token, env.WIDGET_TOKEN_SECRET);
  if (!visitor) {
    return null;
  }
  if (conversationAgentName(visitor.tenantId, visitor.conversationId) !== agentName) {
    return null;
  }
  return {
    kind: "visitor",
    tenantId: visitor.tenantId,
    conversationId: visitor.conversationId,
    visitorId: visitor.visitorId,
  };
}

/** The step 4 path, unchanged: a dashboard session whose active tenant matches. */
async function authoriseStaff(
  request: Request,
  tenantId: TenantId,
): Promise<AgentPrincipal | null> {
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!cookie) {
    return null;
  }

  const session = await verifySession(cookie, env.SESSION_SECRET);
  if (!session) {
    return null;
  }
  if (await env.KV.get(revocationKvKey(session.sid))) {
    return null;
  }

  // The session's active tenant must be the tenant in the name. A signed-in
  // user of one workspace has no business opening another's conversation, and
  // this is the line that says so.
  if (session.tenantId !== tenantId) {
    return null;
  }
  return { kind: "staff", tenantId, userId: session.userId };
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
