import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { api } from "./api/index.ts";

/**
 * The Worker entry.
 *
 * Everything under /api is the Hono app; everything else is TanStack Start's
 * SSR handler. This file is also where the Durable Object classes, queue
 * consumers and scheduled handler get exported once build steps 4 onwards land
 * (ADR-003: one Worker holds the app, the agent and the async plumbing).
 */
export default createServerEntry({
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return api.fetch(request);
    }
    return handler.fetch(request);
  },
});
