import {
  CONVERSATION_STATUSES,
  MESSAGE_ROLES,
  SOURCE_STATUSES,
  TENANT_PLANS,
  TENANT_ROLES,
} from "@cf-chat/shared";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantPlan = pgEnum("tenant_plan", TENANT_PLANS);
export const tenantRole = pgEnum("tenant_role", TENANT_ROLES);
export const sourceStatus = pgEnum("source_status", SOURCE_STATUSES);
export const conversationStatus = pgEnum("conversation_status", CONVERSATION_STATUSES);
export const messageRole = pgEnum("message_role", MESSAGE_ROLES);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: tenantPlan("plan").notNull().default("free"),
  /**
   * ADR-006's two dials, per tenant. Null means "use the default from
   * `@cf-chat/shared`", so a tenant that has never tuned anything carries no
   * copy of a number we may want to change globally.
   */
  retrievalThreshold: real("retrieval_threshold"),
  confidenceThreshold: real("confidence_threshold"),
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

/**
 * A visitor conversation. The Durable Object holds the live copy in its own
 * SQLite; this is the archive the dashboard inbox and the analytics queries
 * read, and the only copy that outlives the object.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Minted by the widget, not a signed-in user. */
    visitorId: uuid("visitor_id").notNull(),
    status: conversationStatus("status").notNull().default("open"),
    /** Set the first time any signal escalates, and never cleared. */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_tenant_updated_idx").on(table.tenantId, table.updatedAt.desc())],
);

/**
 * The message archive. Append only: an edit would desynchronise this from the
 * Durable Object's copy, and the DO is the live truth during a conversation.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

/**
 * ADR-006: "every decision and its inputs are logged". One row per visitor
 * turn, escalated or not, because the rate of *not* escalating is half of what
 * the thresholds are tuned against.
 *
 * It is also the input to the nightly `KnowledgeGapDigest` in build step 8,
 * which clusters the low-confidence questions into articles worth writing.
 */
export const questionLog = pgTable(
  "question_log",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** Null when nothing was retrieved at all. */
    topScore: real("top_score"),
    /**
     * Which score `top_score` is. Without it a later analysis would compare
     * reranker scores against fused ones and draw a confident wrong conclusion
     * about where the threshold belongs.
     */
    scoreKind: text("score_kind"),
    chunkCount: integer("chunk_count").notNull().default(0),
    /** Null when the model never reported, which is itself an escalation. */
    confidence: real("confidence"),
    escalated: boolean("escalated").notNull(),
    /** 1, 2 or 3 per ADR-006. Null when nothing escalated. */
    signal: smallint("signal"),
    /** The named sub-rule, so traces and rows agree on why. */
    rule: text("rule"),
    modelId: text("model_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("question_log_tenant_created_idx").on(table.tenantId, table.createdAt.desc())],
);

export type TenantRow = typeof tenants.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type QuestionLogRow = typeof questionLog.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
