/**
 * Reply-loop domain rules shared between the agent, the database and the API.
 *
 * These live in `shared` rather than in `reply-loop` because the database needs
 * the defaults to fill in a null column and the app needs the naming helpers to
 * address a Durable Object, and neither should depend on the reply loop to get
 * them.
 */

import { z } from "zod";
import { type ConversationId, conversationIdSchema, type TenantId, tenantIdSchema } from "./ids.ts";

/**
 * The two dials ADR-006 makes per-tenant config.
 *
 * `retrieval` is compared against the reranker cross-encoder score, never the
 * fused hybrid score, which is rank-derived and not comparable across queries.
 * `confidence` is compared against the model's own self report.
 */
export interface EscalationThresholds {
  readonly retrieval: number;
  readonly confidence: number;
}

/**
 * Starting points, not tuned values. ADR-006 gives no numbers and says tuning
 * happens from real traffic via traces and the eval set in build step 10, so
 * these are deliberately set to over-escalate: a confident wrong answer costs
 * more than an unnecessary handoff.
 */
export const DEFAULT_ESCALATION_THRESHOLDS: EscalationThresholds = {
  retrieval: 0.35,
  confidence: 0.6,
};

/** Both dials are probabilities, so both boundaries are the same. */
export const thresholdSchema = z.number().min(0).max(1);

/**
 * The Durable Object instance name, which is also the only place the agent
 * learns its tenant.
 *
 * `architecture.md` specifies `${tenantId}:${conversationId}`. It matters that
 * the tenant arrives this way rather than in the message body: the DO name is
 * chosen by the Worker that authenticated the request, where the body is
 * whatever the socket sent.
 */
export function conversationAgentName(tenantId: TenantId, conversationId: ConversationId): string {
  return `${tenantId}:${conversationId}`;
}

const agentName = z
  .string()
  .transform((value) => {
    const separator = value.indexOf(":");
    return separator === -1
      ? null
      : { tenantId: value.slice(0, separator), conversationId: value.slice(separator + 1) };
  })
  .pipe(z.object({ tenantId: tenantIdSchema, conversationId: conversationIdSchema }).nullable());

/**
 * The inverse, returning null rather than throwing. A malformed name is a
 * request that should 404, not an exception in the agent's constructor.
 */
export function parseConversationAgentName(
  name: string,
): { tenantId: TenantId; conversationId: ConversationId } | null {
  const parsed = agentName.safeParse(name);
  return parsed.success ? parsed.data : null;
}

/** Whether a conversation is still taking messages. */
export const CONVERSATION_STATUSES = ["open", "escalated", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** Who produced a stored message. `human` is a support agent, from step 6. */
export const MESSAGE_ROLES = ["user", "assistant", "human"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
