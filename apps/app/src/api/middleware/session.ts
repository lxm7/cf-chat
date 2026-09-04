import { env } from "cloudflare:workers";
import {
  AppError,
  revocationKvKey,
  SESSION_COOKIE,
  type SessionEnvelope,
  verifySession,
} from "@cf-chat/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

export interface SessionVariables {
  session: SessionEnvelope;
}

export const requireSession = createMiddleware<{ Variables: SessionVariables }>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    throw new AppError("unauthorized", "Not signed in");
  }

  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) {
    throw new AppError("unauthorized", "Session is invalid or expired");
  }

  if (await env.KV.get(revocationKvKey(session.sid))) {
    throw new AppError("unauthorized", "Session has been revoked");
  }

  c.set("session", session);
  await next();
});
