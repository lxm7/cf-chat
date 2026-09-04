import type { TenantId, TenantPlan } from "@cf-chat/shared";
import { eq } from "drizzle-orm";
import type { Queryable } from "../client.ts";
import { type TenantRow, tenants } from "../schema.ts";

export async function findTenantById(
  db: Queryable,
  tenantId: TenantId,
): Promise<TenantRow | undefined> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return rows[0];
}

export async function findTenantBySlug(
  db: Queryable,
  slug: string,
): Promise<TenantRow | undefined> {
  const rows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return rows[0];
}

export interface InsertTenant {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly plan?: TenantPlan;
}

export async function insertTenant(db: Queryable, input: InsertTenant): Promise<TenantRow> {
  const rows = await db.insert(tenants).values(input).returning();
  const row = rows[0];
  if (!row) {
    throw new Error("insertTenant returned no row");
  }
  return row;
}
