import { env } from "cloudflare:workers";
import { connect, type Db } from "@cf-chat/db";

/**
 * One connection per call, closed before the response is returned. Hyperdrive
 * owns the pool, so this is cheap; the client is closed inline rather than in
 * `waitUntil` because the framework's fetch entry does not hand us an
 * ExecutionContext.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const connection = await connect(env.HYPERDRIVE.connectionString);
  try {
    return await fn(connection.db);
  } finally {
    await connection.close();
  }
}
