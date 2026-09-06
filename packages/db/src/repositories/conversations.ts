import type {
  ConversationId,
  ConversationStatus,
  MessageRole,
  TenantId,
  VisitorId,
} from "@cf-chat/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Queryable } from "../client.ts";
import {
  type ConversationRow,
  conversations,
  type MessageRow,
  messages,
  type QuestionLogRow,
  questionLog,
} from "../schema.ts";

/**
 * Tenant-scoped like every other repository here: the branded `TenantId` comes
 * first so the predicate cannot be forgotten.
 *
 * Reads work on a plain connection; writes must run inside `withTenant`,
 * because the policies in migration 0006 require `app.tenant_id` for INSERT and
 * UPDATE. `messages` and `question_log` have no UPDATE or DELETE policy at all,
 * so there are deliberately no functions here that would issue one.
 */

export async function findConversation(
  db: Queryable,
  tenantId: TenantId,
  conversationId: ConversationId,
): Promise<ConversationRow | undefined> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .limit(1);
  return rows[0];
}

export async function listConversations(
  db: Queryable,
  tenantId: TenantId,
  limit = 50,
): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.tenantId, tenantId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

/**
 * Create the conversation if this is its first turn, otherwise touch it.
 *
 * Idempotent on purpose. The agent does not know whether the analytics message
 * it just sent is the first one to arrive, and a queue can deliver twice, so
 * "insert unless it exists" is the only shape that survives both.
 */
export async function upsertConversation(
  db: Queryable,
  tenantId: TenantId,
  input: {
    readonly id: ConversationId;
    readonly visitorId: VisitorId;
  },
): Promise<ConversationRow> {
  const rows = await db
    .insert(conversations)
    .values({ id: input.id, tenantId, visitorId: input.visitorId })
    .onConflictDoUpdate({
      target: conversations.id,
      set: { updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("upsertConversation returned no row");
  }
  return row;
}

/**
 * Move a conversation's status on.
 *
 * `escalatedAt` is set only the first time, with COALESCE rather than a read
 * followed by a write: two signals escalating on consecutive turns should not
 * move the timestamp, and the workflow in step 7 will care when it first
 * happened.
 */
export async function setConversationStatus(
  db: Queryable,
  tenantId: TenantId,
  conversationId: ConversationId,
  status: ConversationStatus,
): Promise<ConversationRow | undefined> {
  const rows = await db
    .update(conversations)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === "escalated"
        ? { escalatedAt: sql`coalesce(${conversations.escalatedAt}, now())` }
        : {}),
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .returning();
  return rows[0];
}

export async function listMessages(
  db: Queryable,
  tenantId: TenantId,
  conversationId: ConversationId,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
}

export interface InsertMessage {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string;
}

/**
 * Append to the archive.
 *
 * `onConflictDoNothing` because the id is minted by the agent and the analytics
 * queue is at-least-once: a redelivery must not double the transcript.
 */
export async function insertMessages(
  db: Queryable,
  tenantId: TenantId,
  input: readonly InsertMessage[],
): Promise<number> {
  if (input.length === 0) {
    return 0;
  }
  const rows = await db
    .insert(messages)
    .values(input.map((message) => ({ ...message, tenantId })))
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });
  return rows.length;
}

export interface InsertQuestionLog {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly question: string;
  readonly topScore: number | null;
  readonly scoreKind: string | null;
  readonly chunkCount: number;
  readonly confidence: number | null;
  readonly escalated: boolean;
  readonly signal: number | null;
  readonly rule: string | null;
  readonly modelId: string;
}

/**
 * One row per visitor turn, escalated or not (ADR-006). Idempotent for the same
 * reason the message insert is.
 */
export async function insertQuestionLog(
  db: Queryable,
  tenantId: TenantId,
  input: InsertQuestionLog,
): Promise<QuestionLogRow | undefined> {
  const rows = await db
    .insert(questionLog)
    .values({ ...input, tenantId })
    .onConflictDoNothing({ target: questionLog.id })
    .returning();
  return rows[0];
}

/**
 * The low-confidence questions from the last `sinceHours`, which is the input
 * to `KnowledgeGapDigest` in build step 8.
 */
export async function listEscalatedQuestions(
  db: Queryable,
  tenantId: TenantId,
  sinceHours = 24,
): Promise<QuestionLogRow[]> {
  return db
    .select()
    .from(questionLog)
    .where(
      and(
        eq(questionLog.tenantId, tenantId),
        eq(questionLog.escalated, true),
        sql`${questionLog.createdAt} > now() - make_interval(hours => ${sinceHours})`,
      ),
    )
    .orderBy(desc(questionLog.createdAt));
}
