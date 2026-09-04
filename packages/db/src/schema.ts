import { SOURCE_STATUSES, TENANT_PLANS, TENANT_ROLES } from "@cf-chat/shared";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantPlan = pgEnum("tenant_plan", TENANT_PLANS);
export const tenantRole = pgEnum("tenant_role", TENANT_ROLES);
export const sourceStatus = pgEnum("source_status", SOURCE_STATUSES);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: tenantPlan("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  /** Stored already lowercased and trimmed by the boundary schema. */
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tenantRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index("memberships_user_id_idx").on(table.userId),
  ],
);

/**
 * The first genuinely tenant-owned table, and so the first to carry RLS. The
 * policies are in migration 0003 and the reasoning is in ADR-009.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    /** Derived from the extension, never from the client's header. */
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    r2Key: text("r2_key").notNull(),
    /** Null until the ingest consumer has indexed it. Needed to delete or replace. */
    aiSearchItemId: text("ai_search_item_id"),
    chunkCount: integer("chunk_count"),
    status: sourceStatus("status").notNull().default("uploaded"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sources_tenant_created_idx").on(table.tenantId, table.createdAt.desc())],
);

export type TenantRow = typeof tenants.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
