import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;
/** The transaction handle drizzle hands to `db.transaction(...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything you can run a query on. Repositories accept either. */
export type Queryable = Db | Tx;

export interface DbConnection {
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * One connection per request, built from `env.HYPERDRIVE.connectionString`.
 *
 * postgres.js rather than node-postgres: it is ESM-native, which node-postgres
 * is not, and node-postgres resolves `pg-protocol` through an `import`
 * condition inside a `require` graph that the Workers test pool cannot load.
 * Hyperdrive supports named prepared statements in both drivers.
 *
 * `max: 1` because Hyperdrive is the real pool; this client should not try to
 * be a second one. `prepare` is left at its default of true, since turning it
 * off also turns off Hyperdrive's query cache.
 */
export async function connect(connectionString: string): Promise<DbConnection> {
  const sql = postgres(connectionString, {
    max: 1,
    // Skips the pg_catalog type round trip on first query. Our columns are all
    // built-in types plus enums, which come back as strings either way.
    fetch_types: false,
  });

  return {
    db: drizzle(sql, { schema }),
    close: async () => {
      await sql.end();
    },
  };
}
