import { isAllowedOrigin } from "@cf-chat/shared";
import { admitSocket, type GateDeps, mintSession, readConfig } from "./gate.ts";
import { CloudflareTurnstile } from "./turnstile.ts";

/**
 * The widget Worker: the edge a visitor's browser actually talks to.
 *
 * It holds the gates and nothing else. Site key, origin allowlist and Turnstile
 * live here; the reply loop, the Durable Object and the knowledge base all sit
 * behind the service binding to `app` (ADR-008). `app` re-verifies the token it
 * is handed, so this Worker is a convenient place to put the gates rather than
 * an authority (ADR-016).
 *
 * Three routes matter:
 *
 * - `POST /session` runs the gates and returns a signed visitor token as JSON.
 * - `GET /chat` upgrades a WebSocket, presenting that token, and forwards to
 *   `app`.
 * - `GET /config` hands the embed the public Turnstile site key it needs before
 *   it can solve anything.
 *
 * The split between the first two is forced by the browser, not chosen. A
 * `WebSocket` exposes no response headers to JavaScript, so a token minted
 * during the upgrade could never be read back and stored, and the visitor would
 * be challenged again on every reload. Minting over plain HTTP first also means
 * no Durable Object is created for anyone who has not already solved Turnstile.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const deps: GateDeps = {
      kv: env.KV,
      turnstile: new CloudflareTurnstile(env.TURNSTILE_SECRET_KEY),
      tokenSecret: env.WIDGET_TOKEN_SECRET,
    };

    if (request.method === "OPTIONS") {
      return await preflight(deps, request);
    }
    if (url.pathname === "/config" && request.method === "GET") {
      return await config(deps, request);
    }
    if (url.pathname === "/session" && request.method === "POST") {
      return await session(deps, request);
    }
    if (url.pathname === "/chat") {
      return await chat(deps, request, env);
    }
    if (url.pathname === "/embed.js") {
      return embed();
    }
    if (url.pathname === "/health") {
      const upstream = await env.APP.fetch(new Request(new URL("/api/health", url)));
      return Response.json({
        widget: "ok",
        app: upstream.ok ? "ok" : `unhealthy (${upstream.status})`,
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * One refusal for every gate.
 *
 * The reason is logged, never sent. Telling a caller which gate closed would let
 * them enumerate valid site keys by watching the message change, so every path
 * out of here says the same thing.
 */
function refuse(reason: string, request: Request): Response {
  console.warn("widget gate refused", { reason, origin: request.headers.get("origin") });
  return new Response("Not authorised", { status: 403 });
}

/**
 * CORS, scoped to the origins a tenant has actually allowlisted.
 *
 * The allowlisted origin is echoed rather than `*` because these responses
 * carry a credential. A wildcard would let any page on the internet mint a
 * token off the back of a site key that, being public, is trivially copied.
 */
async function corsHeaders(deps: GateDeps, request: Request): Promise<Headers | null> {
  const config = await readConfig(deps, new URL(request.url).searchParams.get("k"));
  const origin = request.headers.get("origin");
  if (!config.ok || !isAllowedOrigin(config.value.config, origin) || origin === null) {
    return null;
  }
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  });
}

async function preflight(deps: GateDeps, request: Request): Promise<Response> {
  const headers = await corsHeaders(deps, request);
  return headers
    ? new Response(null, { status: 204, headers })
    : refuse("preflight_origin", request);
}

/** The public Turnstile site key. Public by design; the secret never leaves the Worker. */
async function config(deps: GateDeps, request: Request): Promise<Response> {
  const headers = await corsHeaders(deps, request);
  if (!headers) {
    return refuse("config_origin", request);
  }
  const found = await readConfig(deps, new URL(request.url).searchParams.get("k"));
  if (!found.ok) {
    return refuse(found.refusal, request);
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ turnstileSiteKey: found.value.config.turnstileSiteKey }), {
    headers,
  });
}

/**
 * Mint a visitor token.
 *
 * `expiresAt` is returned so the embed can drop a token it knows is stale
 * instead of opening a socket that is certain to be refused.
 */
async function session(deps: GateDeps, request: Request): Promise<Response> {
  const headers = await corsHeaders(deps, request);
  if (!headers) {
    return refuse("session_origin", request);
  }

  let turnstileToken: string | null = null;
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null) {
      const candidate = (body as { turnstileToken?: unknown }).turnstileToken;
      turnstileToken = typeof candidate === "string" ? candidate : null;
    }
  } catch {
    turnstileToken = null;
  }

  const minted = await mintSession(deps, request, turnstileToken);
  if (!minted.ok) {
    return refuse(minted.refusal, request);
  }

  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(
    JSON.stringify({
      token: minted.value.token,
      conversationId: minted.value.envelope.conversationId,
      expiresAt: minted.value.envelope.exp,
    }),
    { headers },
  );
}

/**
 * Upgrade and forward.
 *
 * The token travels in the query string on this hop because `WebSocket` gives
 * the browser no way to set a header, and moves into a header on the hop to
 * `app`, which is a service-binding fetch this Worker constructs and so is out
 * of the browser's reach.
 */
async function chat(deps: GateDeps, request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const url = new URL(request.url);
  const admitted = await admitSocket(deps, request, url.searchParams.get("t"));
  if (!admitted.ok) {
    return refuse(admitted.refusal, request);
  }

  const target = new URL(
    `/agents/conversation/${encodeURIComponent(admitted.value.agentName)}`,
    url,
  );
  const forwarded = new Request(target, request);
  // Header, not query string: `app` reads the credential from somewhere the
  // browser could not have written even if it reached `app` directly.
  forwarded.headers.set("x-cf-chat-visitor-token", url.searchParams.get("t") ?? "");
  return await env.APP.fetch(forwarded);
}

/**
 * Placeholder until build step 5's `packages/widget-ui` lands.
 *
 * The loader stays deliberately tiny: it is the only thing a customer's page
 * pays for until a visitor actually opens the panel, which is what keeps the
 * React bundle off every page view (ADR-015).
 */
function embed(): Response {
  return new Response(
    `(() => {
  console.info("cf-chat widget: gates are live, UI lands with packages/widget-ui");
})();
`,
    {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    },
  );
}
