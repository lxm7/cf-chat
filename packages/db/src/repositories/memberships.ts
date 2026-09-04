import {
  type TenantId,
  type TenantPlan,
  type TenantRole,
  type UserId,
  unsafeTenantId,
} from "@cf-chat/shared";
import { and, eq } from "drizzle-orm";
import type { Queryable } from "../client.ts";
import { type MembershipRow, memberships, tenants } from "../schema.ts";

/**
 * Tenant-scoped. `tenantId` is branded and comes first, so the predicate cannot
 * be omitted by accident and Hyperdrive's cache key includes the tenant.
 */
export async function findMembership(
  db: Queryable,
  tenantId: TenantId,
  userId: UserId,
): Promise<MembershipRow | undefined> {
  const rows = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .limit(1);
  return rows[0];
}

export interface TenantMembership {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly plan: TenantPlan;
  readonly role: TenantRole;
}

/**
 * Deliberately not tenant-scoped: this is the tenant picker, so it spans every
 * tenant the user belongs to. Scoped by `userId` instead, which is the same
 * isolation guarantee from the other direction.
 */
export async function listMembershipsForUser(
  db: Queryable,
  userId: UserId,
): Promise<TenantMembership[]> {
  const rows = await db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: tenants.plan,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId));
  // Postgres hands back a plain string id; brand it here, at the edge of the DB layer.
  return rows.map((row) => ({ ...row, tenantId: unsafeTenantId(row.tenantId) }));
}

export async function insertMembership(
  db: Queryable,
  tenantId: TenantId,
  userId: UserId,
  role: TenantRole,
): Promise<MembershipRow> {
  const rows = await db.insert(memberships).values({ tenantId, userId, role }).returning();
  const row = rows[0];
  if (!row) {
    throw new Error("insertMembership returned no row");
  }
  return row;
}
