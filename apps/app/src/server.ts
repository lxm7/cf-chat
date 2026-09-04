import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { api } from "./api/index.ts";
import { handleIngestBatch } from "./ingest.ts";

/**
 * The Worker entry.
 *
 * Everything under /api is the Hono app; everything else is TanStack Start's
 * SSR handler. The async plumbing hangs off the same default export: ADR-010
 * records why it lives here in `app` rather than in a separate Worker, and why
 * `wrangler.jsonc` must keep pointing `main` at this file.
 *
 * The queue handler has to sit on the object wrangler actually consumes, so it
 * is attached to the entry rather than exported separately. Verify it survives
 * the build (`grep queue dist/server/index.js`) rather than assuming: the
 * original ADR-010 bug was exactly an entry that looked right and was never
 * loaded.
 */
const entry = createServerEntry({
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return api.fetch(request);
    }
    return handler.fetch(request);
  },
});

export default {
  fetch: (request: Request, ...rest: never[]) => entry.fetch(request, ...rest),
  queue: handleIngestBatch,
};
