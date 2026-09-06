import { env } from "cloudflare:workers";
import type { InsertMessage } from "@cf-chat/db";
import {
  insertMessages,
  insertQuestionLog,
  setConversationStatus,
  upsertConversation,
  withTenant,
} from "@cf-chat/db";
import {
  type ConversationId,
  conversationIdSchema,
  type TenantId,
  tenantIdSchema,
  type VisitorId,
  visitorIdSchema,
} from "@cf-chat/shared";
import { z } from "zod";
import { withDb } from "./api/db.ts";

/**
 * One visitor turn, as the agent hands it off.
 *
 * Parsed like every other queue message: a message that crossed a boundary is
 * input, and a malformed one must be discarded rather than allowed to take the
 * consumer down.
 */
const turnMessage = z.object({
  kind: z.literal("turn"),
  tenantId: tenantIdSchema,
  conversationId: conversationIdSchema,
  visitorId: visitorIdSchema,
  question: z.string(),
  answer: z.string(),
  topScore: z.number().nullable(),
  scoreKind: z.enum(["reranker", "fused"]).nullable(),
  chunkCount: z.number().int().nonnegative(),
  confidence: z.number().nullable(),
  escalated: z.boolean(),
  signal: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  rule: z.string().nullable(),
  modelId: z.string(),
});

const analyticsMessage = z.discriminatedUnion("kind", [turnMessage]);

export type AnalyticsMessage = z.infer<typeof analyticsMessage>;
type TurnMessage = z.infer<typeof turnMessage>;

/**
 * Everything the analytics step touches, injected for the same reason the
 * ingest consumer injects its dependencies: Hyperdrive has no local emulation,
 * so a consumer that closed over its bindings could only be tested live.
 */
export interface AnalyticsDeps {
  readonly recordTurn: (
    tenantId: TenantId,
    conversationId: ConversationId,
    visitorId: VisitorId,
    turn: TurnMessage,
  ) => Promise<void>;
}

/**
 * One message. Never throws: every outcome is "done, ack it" (true) or
 * "transient, put it back" (false).
 */
export async function analyticsOne(raw: unknown, deps: AnalyticsDeps): Promise<boolean> {
  const parsed = analyticsMessage.safeParse(raw);
  if (!parsed.success) {
    // No number of retries fixes a shape, so this is acked rather than requeued.
    console.error("Discarding unparseable analytics message", parsed.error.message);
    return true;
  }

  const message = parsed.data;
  switch (message.kind) {
    case "turn":
      try {
        await deps.recordTurn(message.tenantId, message.conversationId, message.visitorId, message);
        return true;
      } catch (cause) {
        // A database blip is worth retrying: unlike the reply itself, nobody is
        // waiting on this write.
        console.error("Could not record turn analytics, retrying", {
          conversationId: message.conversationId,
          cause,
        });
        return false;
      }
    default: {
      const exhaustive: never = message.kind;
      throw new Error(`Unhandled analytics message ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The production wiring.
 *
 * One transaction per turn, because the RLS policies in migration 0006 require
 * `app.tenant_id` for every insert, and because a question-log row referencing
 * a conversation that failed to insert would violate the foreign key anyway.
 *
 * Every write is idempotent on its id: queues are at-least-once, and a
 * redelivery must not double the transcript or the log.
 */
export function liveAnalyticsDeps(): AnalyticsDeps {
  return {
    recordTurn: async (tenantId, conversationId, visitorId, turn) => {
      await withDb((db) =>
        withTenant(db, tenantId, async (tx) => {
          await upsertConversation(tx, tenantId, { id: conversationId, visitorId });

          const archived: InsertMessage[] = [
            {
              // Deterministic ids: the same turn redelivered produces the same
              // two rows, which is what makes `onConflictDoNothing` a real
              // guard rather than a decoration.
              id: turnMessageId(conversationId, turn, "user"),
              conversationId,
              role: "user",
              content: turn.question,
            },
          ];
          if (turn.answer.length > 0) {
            archived.push({
              id: turnMessageId(conversationId, turn, "assistant"),
              conversationId,
              role: "assistant",
              content: turn.answer,
            });
          }
          await insertMessages(tx, tenantId, archived);

          await insertQuestionLog(tx, tenantId, {
            id: turnMessageId(conversationId, turn, "log"),
            conversationId,
            question: turn.question,
            topScore: turn.topScore,
            scoreKind: turn.scoreKind,
            chunkCount: turn.chunkCount,
            confidence: turn.confidence,
            escalated: turn.escalated,
            signal: turn.signal,
            rule: turn.rule,
            modelId: turn.modelId,
          });

          if (turn.escalated) {
            // `escalatedAt` is only set the first time, in the repository, so a
            // second escalating turn does not move the clock.
            await setConversationStatus(tx, tenantId, conversationId, "escalated");
          }
        }),
      );
    },
  };
}

/**
 * A stable uuid for a turn's rows, derived from the conversation and the
 * question rather than generated fresh, so a redelivered message collides with
 * itself instead of appending a duplicate.
 */
function turnMessageId(
  conversationId: ConversationId,
  turn: TurnMessage,
  part: "user" | "assistant" | "log",
): string {
  return uuidFromString(`${conversationId}:${part}:${turn.question}:${turn.modelId}`);
}

/**
 * A deterministic uuid from arbitrary text. FNV-1a over four offsets, laid out
 * as a v4-shaped uuid so the column type is satisfied.
 *
 * Not a cryptographic hash: this is a collision-avoidance key for idempotency,
 * not a security boundary, and it is scoped to a single conversation. The
 * alternative was an async SHA-256, which would make every caller await for no
 * benefit at this scale.
 */
function uuidFromString(value: string): string {
  const hex: string[] = [];
  for (let seed = 0; seed < 4; seed += 1) {
    let hash = 0x811c9dc5 ^ seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex.push(hash.toString(16).padStart(8, "0"));
  }
  const raw = hex.join("");
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `4${raw.slice(13, 16)}`,
    `8${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join("-");
}

/** Must match the queue name in `wrangler.jsonc`. */
export const ANALYTICS_QUEUE = "cf-chat-analytics";

export async function analyticsBatch(
  batch: MessageBatch<unknown>,
  deps: AnalyticsDeps,
): Promise<void> {
  const outcomes = await Promise.all(
    batch.messages.map(async (message) => {
      try {
        return { message, done: await analyticsOne(message.body, deps) };
      } catch (cause) {
        console.error("Analytics threw unexpectedly", cause);
        return { message, done: false };
      }
    }),
  );

  for (const { message, done } of outcomes) {
    if (done) {
      message.ack();
    } else {
      message.retry();
    }
  }
}

/**
 * The dead letter path. Nothing to salvage: the row is lost, and saying so in a
 * log is the whole remedy. Unlike ingest, there is no user-visible record to
 * mark, because analytics rows are the record.
 */
export async function analyticsDeadLetterBatch(batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    console.error("Analytics message dead-lettered and lost", message.body);
    message.ack();
  }
}

/** Kept out of `liveAnalyticsDeps` so the queue send stays visible at the call site. */
export async function sendAnalytics(message: AnalyticsMessage): Promise<void> {
  await env.ANALYTICS.send(message);
}
