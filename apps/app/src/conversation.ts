import { env, tracing } from "cloudflare:workers";
import { findEscalationThresholds } from "@cf-chat/db";
import {
  type EscalationDecision,
  type GeneratorMessage,
  runTurn,
  type TurnSummary,
  WorkersAIGenerator,
} from "@cf-chat/reply-loop";
import { AISearchRetriever, type RetrievedChunk } from "@cf-chat/retrieval";
import {
  type ConversationId,
  DEFAULT_ESCALATION_THRESHOLDS,
  type EscalationThresholds,
  parseConversationAgentName,
  type TenantId,
  unsafeVisitorId,
} from "@cf-chat/shared";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { withDb } from "./api/db.ts";

/**
 * Persisted agent state.
 *
 * Everything here has to survive hibernation, which is why it is state rather
 * than instance fields: the object sleeps between visitor messages and loses
 * in-memory variables when it does (ADR-014). Caching the thresholds here is
 * what keeps the tenant lookup to once per conversation rather than once per
 * turn, without a field that would silently empty after a sleep.
 */
export interface ConversationState {
  readonly thresholds: EscalationThresholds | null;
  readonly tenantName: string | null;
}

/** Extra fields the widget sends alongside a message. */
interface TurnBody {
  readonly visitorId?: unknown;
}

/**
 * The reply loop's Durable Object.
 *
 * Deliberately thin. Every decision lives in `@cf-chat/reply-loop`, which has
 * no bindings and is tested with fixtures; this class resolves the environment,
 * runs the turn, and forwards the events onto the socket. See ADR-010 for why
 * it is exported from `app` rather than living in its own Worker.
 *
 * Hibernation is left at its default of on. `static options = { hibernate:
 * false }` is what would break it, and `AIChatAgent` calls `keepAlive()` itself
 * while streaming, so an idle open tab costs nothing and a generating one is
 * billed for exactly as long as it generates.
 */
export class Conversation extends AIChatAgent<Cloudflare.Env, ConversationState> {
  override initialState: ConversationState = { thresholds: null, tenantName: null };

  override async onChatMessage(
    _onFinish: unknown,
    options?: { readonly body?: unknown },
  ): Promise<Response> {
    // The tenant comes from the Durable Object's name, which was chosen by the
    // Worker that authenticated the request. Taking it from the message body
    // would mean taking it from the socket.
    const identity = parseConversationAgentName(this.name);
    if (!identity) {
      // Worded without the placeholder braces on purpose: as a plain string
      // they trip the template-literal lint, and this is prose, not a template.
      return new Response(
        "Conversation names must be a tenant id and a conversation id, colon separated",
        {
          status: 400,
        },
      );
    }
    const { tenantId, conversationId } = identity;

    const messages = toGeneratorMessages(this.messages);
    if (messages.length === 0) {
      return new Response("No message to answer", { status: 400 });
    }

    const thresholds = await this.#thresholds(tenantId);
    const generator = this.#generator();
    const retriever = new AISearchRetriever(env.AI_SEARCH);
    const visitorId = readVisitorId(options?.body);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const textId = crypto.randomUUID();
        let started = false;
        let summary: TurnSummary | null = null;

        await tracing.enterSpan("reply_loop.turn", async (span) => {
          span.setAttribute("tenant.id", tenantId);
          span.setAttribute("model.id", generator.modelId);

          for await (const event of runTurn({
            tenantId,
            messages,
            retriever,
            generator,
            thresholds,
          })) {
            switch (event.type) {
              case "sources":
                // A data part rather than prose, so the client renders
                // citations as UI and the model cannot fabricate one.
                writer.write({
                  type: "data-sources",
                  id: crypto.randomUUID(),
                  data: { sources: event.chunks.map(toCitation) },
                });
                span.setAttribute("retrieval.k", event.chunks.length);
                break;
              case "text-delta":
                if (!started) {
                  writer.write({ type: "text-start", id: textId });
                  started = true;
                }
                writer.write({ type: "text-delta", id: textId, delta: event.text });
                break;
              case "escalation":
                writer.write({
                  type: "data-escalation",
                  id: crypto.randomUUID(),
                  data: toEscalationData(event.decision),
                });
                break;
              case "done":
                summary = event.summary;
                break;
              default: {
                const exhaustive: never = event;
                throw new Error(`Unhandled turn event ${JSON.stringify(exhaustive)}`);
              }
            }
          }

          if (started) {
            writer.write({ type: "text-end", id: textId });
          }
          if (summary) {
            annotate(span, summary);
          }
        });

        if (summary) {
          // Fire and forget onto the analytics queue: a Neon blip must not fail
          // a reply the visitor has already read. See architecture.md's hot path.
          await this.#record(tenantId, conversationId, visitorId, summary);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Read once per conversation and cached in persisted state. Falls back to the
   * defaults rather than failing the turn: an unreachable database is not a
   * reason to refuse to answer from a knowledge base that is reachable.
   */
  async #thresholds(tenantId: TenantId): Promise<EscalationThresholds> {
    const cached = this.state?.thresholds;
    if (cached) {
      return cached;
    }
    try {
      const thresholds = await withDb((db) => findEscalationThresholds(db, tenantId));
      this.setState({ ...this.state, thresholds });
      return thresholds;
    } catch (cause) {
      console.error("Could not read escalation thresholds, using defaults", cause);
      return DEFAULT_ESCALATION_THRESHOLDS;
    }
  }

  /**
   * Model id and gateway are config, never literals (ADR-005). Both are vars in
   * `wrangler.jsonc`, so a missing one is a deploy-time mistake rather than a
   * silent fallback to something nobody chose.
   */
  #generator(): WorkersAIGenerator {
    const workersai = createWorkersAI({
      binding: env.AI,
      gateway: { id: env.AI_GATEWAY_ID },
    });
    const modelId = env.REPLY_MODEL_ID;
    return new WorkersAIGenerator(workersai(modelId), modelId, {
      ...(this.state?.tenantName ? { tenantName: this.state.tenantName } : {}),
    });
  }

  async #record(
    tenantId: TenantId,
    conversationId: ConversationId,
    visitorId: string,
    summary: TurnSummary,
  ): Promise<void> {
    try {
      await env.ANALYTICS.send({
        kind: "turn",
        tenantId,
        conversationId,
        visitorId,
        question: summary.question,
        answer: summary.answer,
        topScore: summary.topScore,
        scoreKind: summary.scoreKind,
        chunkCount: summary.chunkCount,
        confidence: summary.confidence,
        escalated: summary.decision.escalate,
        signal: summary.decision.escalate ? summary.decision.signal : null,
        rule: summary.decision.escalate ? summary.decision.rule : null,
        modelId: summary.modelId,
      });
    } catch (cause) {
      // The reply already reached the visitor. Losing the analytics row is bad,
      // but failing the turn after the fact would be worse and is not possible
      // anyway at this point in the stream.
      console.error("Could not enqueue turn analytics", { conversationId, cause });
    }
  }
}

/** The span attributes ADR-007 requires on every reply. */
function annotate(span: Span, summary: TurnSummary): void {
  span.setAttribute("escalation.decision", summary.decision.escalate);
  if (summary.decision.escalate) {
    span.setAttribute("escalation.signal", summary.decision.signal);
    span.setAttribute("escalation.rule", summary.decision.rule);
  }
  if (summary.topScore !== null) {
    span.setAttribute("retrieval.top_score", summary.topScore);
  }
  if (summary.scoreKind) {
    // Not in ADR-007's list. Added because it is the only way to see that a
    // tenant's reranking is off, which silently disables signal 1's threshold.
    span.setAttribute("retrieval.score_kind", summary.scoreKind);
    span.setAttribute("retrieval.threshold_applied", summary.thresholdApplied);
  }
  if (summary.confidence !== null) {
    span.setAttribute("model.confidence", summary.confidence);
  }
}

/** Only the fields a client needs to render a citation. */
function toCitation(chunk: RetrievedChunk) {
  return {
    id: chunk.source.id,
    title: chunk.source.title,
    url: chunk.source.url,
    score: chunk.score,
  };
}

function toEscalationData(decision: EscalationDecision) {
  return decision.escalate
    ? { escalated: true, signal: decision.signal, rule: decision.rule, reason: decision.reason }
    : { escalated: false };
}

/**
 * `UIMessage` carries parts, not a string. Only text parts are of interest: the
 * data parts this agent writes are its own output and have no business being
 * fed back in as context.
 */
export function toGeneratorMessages(uiMessages: readonly UIMessage[]): GeneratorMessage[] {
  const messages: GeneratorMessage[] = [];
  for (const message of uiMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (content.length > 0) {
      messages.push({ role: message.role, content });
    }
  }
  return messages;
}

/**
 * The visitor id the widget minted. Validated rather than trusted, and replaced
 * with a fresh one when it is missing or malformed: an unattributable
 * conversation is better than one attributed to a value the client made up.
 */
function readVisitorId(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const candidate = (body as TurnBody).visitorId;
    if (typeof candidate === "string" && /^[0-9a-f-]{36}$/i.test(candidate)) {
      return unsafeVisitorId(candidate);
    }
  }
  return crypto.randomUUID();
}
