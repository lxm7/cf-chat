import {
  type Db,
  findTenantBySlug,
  findUserByEmail,
  insertMembership,
  insertTenant,
  insertUser,
  listMembershipsForUser,
  withTenant,
} from "@cf-chat/db";
import {
  AppError,
  clearedSessionCookie,
  hashPassword,
  loginInput,
  newTenantId,
  newUserId,
  sessionCookie,
  signupInput,
  slugify,
  unsafeTenantId,
  unsafeUserId,
  verifyPassword,
} from "@cf-chat/shared";
import { Hono } from "hono";
import { withDb } from "../db.ts";
import { requireSession, type SessionVariables } from "../middleware/session.ts";
import { issueSession, revokeSession } from "../session.ts";
import { parseBody } from "../validation.ts";

/**
 * A syntactically valid hash that no password matches. Verified against when
 * the email is unknown, so login costs the same whether or not the account
 * exists and cannot be used to enumerate users.
 */
const ABSENT_USER_HASH = `pbkdf2$sha256$210000$${"A".repeat(22)}$${"A".repeat(43)}`;

async function reserveSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name) || "tenant";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomUUID().slice(0, 6)}`;
    if (!(await findTenantBySlug(db, candidate))) {
      return candidate;
    }
  }
  throw new AppError("conflict", "Could not allocate a unique workspace slug");
}

const auth = new Hono<{ Variables: SessionVariables }>();

auth.post("/signup", async (c) => {
  const input = await parseBody(c, signupInput);

  const result = await withDb(async (db) => {
    if (await findUserByEmail(db, input.email)) {
      throw new AppError("conflict", "An account with that email already exists");
    }

    const slug = await reserveSlug(db, input.tenantName);
    const tenantId = newTenantId();
    const userId = newUserId();
    const passwordHash = await hashPassword(input.password);

    // One transaction because the three inserts have to succeed or fail
    // together, with app.tenant_id set for consistency with every other write
    // path. The identity tables deliberately carry no RLS (migration 0001), so
    // the GUC is not what makes these inserts legal; the policies that do
    // require it start at `sources`.
    return withTenant(db, tenantId, async (tx) => {
      const tenant = await insertTenant(tx, { id: tenantId, name: input.tenantName, slug });
      const user = await insertUser(tx, {
        id: userId,
        email: input.email,
        name: input.name,
        passwordHash,
      });
      await insertMembership(tx, tenantId, userId, "owner");
      return { tenant, user };
    });
  });

  const { token, maxAgeSeconds } = await issueSession(
    unsafeUserId(result.user.id),
    unsafeTenantId(result.tenant.id),
  );
  c.header("Set-Cookie", sessionCookie(token, maxAgeSeconds));

  return c.json(
    {
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
    },
    201,
  );
});

auth.post("/login", async (c) => {
  const input = await parseBody(c, loginInput);

  const outcome = await withDb(async (db) => {
    const user = await findUserByEmail(db, input.email);
    if (!user) {
      await verifyPassword(input.password, ABSENT_USER_HASH);
      return null;
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      return null;
    }
    const memberships = await listMembershipsForUser(db, unsafeUserId(user.id));
    return { user, memberships };
  });

  if (!outcome) {
    throw new AppError("unauthorized", "Email or password is incorrect");
  }

  const activeTenantId = outcome.memberships[0]?.tenantId ?? null;
  const { token, maxAgeSeconds } = await issueSession(
    unsafeUserId(outcome.user.id),
    activeTenantId,
  );
  c.header("Set-Cookie", sessionCookie(token, maxAgeSeconds));

  return c.json({
    user: { id: outcome.user.id, email: outcome.user.email, name: outcome.user.name },
    tenants: outcome.memberships,
    activeTenantId,
  });
});

auth.post("/logout", requireSession, async (c) => {
  const session = c.get("session");
  await revokeSession(session.sid, session.exp);
  c.header("Set-Cookie", clearedSessionCookie());
  return c.body(null, 204);
});

auth.get("/me", requireSession, async (c) => {
  const session = c.get("session");

  const data = await withDb(async (db) => {
    const memberships = await listMembershipsForUser(db, session.userId);
    return memberships;
  });

  return c.json({
    userId: session.userId,
    activeTenantId: session.tenantId,
    tenants: data,
  });
});

export default auth;
