import type { SourceId, SourceStatus, TenantId } from "@cf-chat/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Queryable } from "../client.ts";
import { type SourceRow, sources } from "../schema.ts";

/**
 * Every function here is tenant-scoped and takes the branded `TenantId` first,
 * so the predicate cannot be forgotten and Hyperdrive's cache key includes the
 * tenant (ADR-009 point 1).
 *
 * Reads work on a plain connection. Writes must run inside `withTenant`,
 * because the RLS policies in migration 0003 require `app.tenant_id` to be set
 * for INSERT, UPDATE and DELETE. A write outside a transaction fails rather
 * than silently writing across tenants.
 */

export async function listSources(db: Queryable, tenantId: TenantId): Promise<SourceRow[]> {
  return db
    .select()
    .from(sources)
    .where(eq(sources.tenantId, tenantId))
    .orderBy(desc(sources.createdAt));
}

export async function findSource(
  db: Queryable,
  tenantId: TenantId,
  sourceId: SourceId,
): Promise<SourceRow | undefined> {
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)))
    .limit(1);
  return rows[0];
}

export interface InsertSource {
  readonly id: SourceId;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly r2Key: string;
}

export async function insertSource(
  db: Queryable,
  tenantId: TenantId,
  input: InsertSource,
): Promise<SourceRow> {
  const rows = await db
    .insert(sources)
    .values({ ...input, tenantId })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("insertSource returned no row");
  }
  return row;
}

export interface SourceStatusUpdate {
  readonly status: SourceStatus;
  readonly aiSearchItemId?: string | null;
  readonly chunkCount?: number | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export async function updateSourceStatus(
  db: Queryable,
  tenantId: TenantId,
  sourceId: SourceId,
  update: SourceStatusUpdate,
): Promise<SourceRow | undefined> {
  const rows = await db
    .update(sources)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)))
    .returning();
  return rows[0];
}

export async function deleteSource(
  db: Queryable,
  tenantId: TenantId,
  sourceId: SourceId,
): Promise<boolean> {
  const rows = await db
    .delete(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)))
    .returning({ id: sources.id });
  return rows.length > 0;
}
