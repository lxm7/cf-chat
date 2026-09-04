import { isAppError } from "@cf-chat/shared";
import { Hono } from "hono";
import type { SessionVariables } from "./middleware/session.ts";
import auth from "./routes/auth.ts";
import session from "./routes/session.ts";
import sources from "./routes/sources.ts";
import tenants from "./routes/tenants.ts";

export const api = new Hono<{ Variables: SessionVariables }>().basePath("/api");

api.get("/health", (c) => c.json({ status: "ok" }));

api.route("/auth", auth);
api.route("/tenants", tenants);
api.route("/session", session);
api.route("/sources", sources);

/**
 * The single place AppError becomes a response. Details are only serialised
 * for validation failures; every other code keeps its details server-side so
 * internals are never handed to a caller.
 */
api.onError((error, c) => {
  if (isAppError(error)) {
    return c.json(
      {
        error: error.code,
        message: error.message,
        ...(error.code === "validation" ? { details: error.details } : {}),
      },
      error.status as 400 | 401 | 403 | 404 | 409 | 429 | 500,
    );
  }

  console.error("Unhandled API error", error);
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
});

api.notFound((c) => c.json({ error: "not_found", message: "No such endpoint" }, 404));
