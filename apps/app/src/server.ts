import { env } from "cloudflare:workers";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";
import { type AgentPrincipal, authoriseAgentRequest, VISITOR_ID_HEADER } from "./agent-auth.ts";
import { api } from "./api/index.ts";
import { handleQueueBatch } from "./queues.ts";

/**
 * The `Conversation` Durable Object, re-exported so wrangler can find the class
 * on the same module its `main` points at. The class itself lives in
 * `conversation.ts`; ADR-010 is why it lives in `app` at all.
 */
export { Conversation } from "./conversation.ts";

/**
 * The Worker entry.
 *
 * Everything under /agents is the Agents SDK router, everything under /api is
 * the Hono app, and everything else is TanStack Start's SSR handler. The async
 * plumbing hangs off the same default export: ADR-010 records why it lives here
 * in `app` rather than in a separate Worker, and why `wrangler.jsonc` must keep
 * pointing `main` at this file.
 *
 * The queue handler has to sit on the object wrangler actually consumes, so it
 * is attached to the entry rather than exported separately. Verify it and the
 * Durable Object class both survive the build
 * (`grep -o Conversation dist/server/index.js`) rather than assuming: the
 * original ADR-010 bug was exactly an entry that looked right and was never
 * loaded.
 */
const entry = createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/agents/")) {
      // The name carries the tenant and the Durable Object trusts it, so this
      // check is the isolation boundary for the reply loop rather than a
      // convenience. See `agent-auth.ts`.
      const principal = await authoriseAgentRequest(request);
      if (!principal) {
        return new Response("Not authorised for this conversation", { status: 403 });
      }
      const routed = await routeAgentRequest(withVisitorId(request, principal), env);
      return routed ?? new Response("No such agent", { status: 404 });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return api.fetch(request);
    }
    return handler.fetch(request);
  },
});

export default {
  fetch: (request: Request, ...rest: never[]) => entry.fetch(request, ...rest),
  queue: handleQueueBatch,
};

/**
 * Stamp the verified visitor id onto the request the agent will see.
 *
 * `onChatMessage` receives only client-supplied data, so a visitor id read from
 * the message body is worth exactly as much as the socket that sent it. The
 * Durable Object reads this header in `onConnect` instead. Setting it on a fresh
 * `Headers` overwrites any value a caller supplied, which is the point: the
 * header is a statement by `app`, not a field a client can fill in.
 *
 * Staff connections carry no visitor, so the header is absent and the agent
 * mints one for the conversation.
 */
function withVisitorId(request: Request, principal: AgentPrincipal): Request {
  if (principal.kind !== "visitor") {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set(VISITOR_ID_HEADER, principal.visitorId);
  return new Request(request, { headers });
}
