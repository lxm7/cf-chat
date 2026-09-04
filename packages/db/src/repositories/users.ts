import type { UserId } from "@cf-chat/shared";
import { eq } from "drizzle-orm";
import type { Queryable } from "../client.ts";
import { type UserRow, users } from "../schema.ts";

/** Not tenant-scoped: a user exists before any membership does, and may belong to several tenants. */
export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0];
}

export async function findUserById(db: Queryable, userId: UserId): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0];
}

export interface InsertUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
}

export async function insertUser(db: Queryable, input: InsertUser): Promise<UserRow> {
  const rows = await db.insert(users).values(input).returning();
  const row = rows[0];
  if (!row) {
    throw new Error("insertUser returned no row");
  }
  return row;
}
