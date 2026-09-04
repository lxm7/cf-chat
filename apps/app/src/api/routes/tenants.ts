import { listMembershipsForUser } from "@cf-chat/db";
import { Hono } from "hono";
import { withDb } from "../db.ts";
import { requireSession, type SessionVariables } from "../middleware/session.ts";

const tenants = new Hono<{ Variables: SessionVariables }>();

tenants.get("/", requireSession, async (c) => {
  const session = c.get("session");
  const memberships = await withDb((db) => listMembershipsForUser(db, session.userId));
  return c.json({ tenants: memberships, activeTenantId: session.tenantId });
});

export default tenants;
