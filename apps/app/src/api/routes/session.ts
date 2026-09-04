import { findMembership } from "@cf-chat/db";
import { AppError, sessionCookie, switchTenantInput } from "@cf-chat/shared";
import { Hono } from "hono";
import { withDb } from "../db.ts";
import { requireSession, type SessionVariables } from "../middleware/session.ts";
import { issueSession, revokeSession } from "../session.ts";
import { parseBody } from "../validation.ts";

const session = new Hono<{ Variables: SessionVariables }>();

session.post("/tenant", requireSession, async (c) => {
  const current = c.get("session");
  const { tenantId } = await parseBody(c, switchTenantInput);

  const membership = await withDb((db) => findMembership(db, tenantId, current.userId));
  if (!membership) {
    throw new AppError("forbidden", "You are not a member of that workspace");
  }

  // Switching mints a new session rather than mutating the old one, so the old
  // cookie stops being usable even if it was captured somewhere.
  await revokeSession(current.sid, current.exp);
  const { token, maxAgeSeconds } = await issueSession(current.userId, tenantId);
  c.header("Set-Cookie", sessionCookie(token, maxAgeSeconds));

  return c.json({ activeTenantId: tenantId, role: membership.role });
});

export default session;
