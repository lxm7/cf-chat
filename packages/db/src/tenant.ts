import type { TenantId } from "@cf-chat/shared";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client.ts";

/**
 * Runs `fn` inside a transaction with `app.tenant_id` set, so the RLS policies
 * apply. See docs/decisions/009: this is deliberately NOT the general read
 * path. Hyperdrive pools in transaction mode, and holding a transaction open
 * pins a connection for its duration, which Cloudflare explicitly warns costs
 * pool scaling. Use it for multi-statement writes, which need a transaction
 * anyway; ordinary reads carry `tenant_id = $1` in the SQL instead.
 *
 * `set_config` rather than `SET LOCAL` because Postgres does not accept bind
 * parameters in a SET statement, and interpolating the id into SQL text is not
 * something worth doing by hand.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: TenantId,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
