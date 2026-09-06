import {
  DEFAULT_ESCALATION_THRESHOLDS,
  type EscalationThresholds,
  type TenantId,
  type TenantPlan,
} from "@cf-chat/shared";
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

/**
 * The tenant's escalation thresholds, with the defaults filled in.
 *
 * Null columns mean "never tuned", so the default from `@cf-chat/shared`
 * applies and stays changeable in one place rather than being copied into every
 * tenant row at signup. Read once per conversation by the agent and cached in
 * its state, not read per turn.
 */
export async function findEscalationThresholds(
  db: Queryable,
  tenantId: TenantId,
): Promise<EscalationThresholds> {
  const rows = await db
    .select({
      retrieval: tenants.retrievalThreshold,
      confidence: tenants.confidenceThreshold,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const row = rows[0];
  return {
    retrieval: row?.retrieval ?? DEFAULT_ESCALATION_THRESHOLDS.retrieval,
    confidence: row?.confidence ?? DEFAULT_ESCALATION_THRESHOLDS.confidence,
  };
}
