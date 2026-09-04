/**
 * Placeholder widget Worker.
 *
 * The real embed (Preact bundle, WebSocket to the Conversation agent, Turnstile
 * on first message) lands at build step 5. What exists here is the routing
 * shell plus the service binding from ADR-008, so the cross-Worker hop is real
 * and testable before anything depends on it.
 */

const EMBED_STUB = `(() => {
  console.info("cf-chat widget: placeholder embed, build step 5 not done yet");
})();
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/embed.js") {
      return new Response(EMBED_STUB, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/health") {
      // Proves the ADR-008 service binding resolves, in dev and in production.
      const upstream = await env.APP.fetch(new Request(new URL("/api/health", url)));
      return Response.json({
        widget: "ok",
        app: upstream.ok ? "ok" : `unhealthy (${upstream.status})`,
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
