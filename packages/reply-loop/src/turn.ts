import {
  latestUserMessage,
  type RetrievedChunk,
  type Retriever,
  type ScoreKind,
} from "@cf-chat/retrieval";
import type { EscalationThresholds, TenantId } from "@cf-chat/shared";
import {
  assessRetrieval,
  checkHardRules,
  checkSelfReport,
  type EscalationDecision,
} from "./escalation.ts";
import type { Generator, GeneratorMessage, SelfReport } from "./types.ts";

/**
 * What one visitor turn produces, in the order it produces it.
 *
 * An event stream rather than a return value because the answer is streamed:
 * the caller forwards `text-delta` to the socket as it arrives and only sees
 * `done` once everything is settled.
 */
export type TurnEvent =
  | { readonly type: "sources"; readonly chunks: readonly RetrievedChunk[] }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "escalation"; readonly decision: EscalationDecision }
  | { readonly type: "done"; readonly summary: TurnSummary };

/** Everything the question log and the span need, gathered as the turn runs. */
export interface TurnSummary {
  readonly question: string;
  readonly answer: string;
  readonly topScore: number | null;
  readonly scoreKind: ScoreKind | null;
  readonly chunkCount: number;
  readonly confidence: number | null;
  readonly decision: EscalationDecision;
  readonly modelId: string;
  /**
   * False when the reranker score was missing so signal 1's threshold could not
   * be applied. Goes onto the span; a run of these means reranking is off on
   * that tenant's instance.
   */
  readonly thresholdApplied: boolean;
}

export interface TurnInput {
  readonly tenantId: TenantId;
  /** The recent window, oldest first, ending with the visitor's new message. */
  readonly messages: readonly GeneratorMessage[];
  readonly retriever: Retriever;
  readonly generator: Generator;
  readonly thresholds: EscalationThresholds;
}

/**
 * The reply loop.
 *
 * The three signals are evaluated where their inputs become available rather
 * than all at the end, so an escalation short-circuits the work below it: a
 * visitor asking for a human costs no retrieval and no inference, and a
 * question nothing matches costs no inference.
 */
export async function* runTurn(input: TurnInput): AsyncIterable<TurnEvent> {
  const question = latestUserMessage(input.messages);
  const modelId = input.generator.modelId;

  // Signal 3, before anything is spent. Deterministic, and not something the
  // model should get a chance to talk the visitor out of.
  const hardRule = checkHardRules(question);
  if (hardRule.escalate) {
    yield* handoff(hardRule);
    yield {
      type: "done",
      summary: {
        question,
        answer: handoffText(hardRule),
        topScore: null,
        scoreKind: null,
        chunkCount: 0,
        confidence: null,
        decision: hardRule,
        modelId,
        thresholdApplied: false,
      },
    };
    return;
  }

  const retrieved = await input.retriever.search(input.tenantId, input.messages);
  if (!retrieved.ok) {
    // Retrieval failing is not the visitor's problem to solve, and answering
    // without sources is exactly what signal 1 exists to prevent. It degrades
    // into a handoff rather than a 500, which is why `Retriever` returns a
    // Result in the first place.
    const decision: EscalationDecision = {
      escalate: true,
      signal: 1,
      rule: "retrieval_failed",
      reason:
        retrieved.error.kind === "not_configured"
          ? "There is no knowledge base set up yet."
          : "The knowledge base is unavailable right now.",
    };
    yield* handoff(decision);
    yield {
      type: "done",
      summary: {
        question,
        answer: handoffText(decision),
        topScore: null,
        scoreKind: null,
        chunkCount: 0,
        confidence: null,
        decision,
        modelId,
        thresholdApplied: false,
      },
    };
    return;
  }

  const chunks = retrieved.value;
  // Emitted before the answer so a client can render citations alongside the
  // text as it streams rather than after it finishes.
  yield { type: "sources", chunks };

  // Signal 1.
  const assessment = assessRetrieval(chunks, input.thresholds);
  if (assessment.decision.escalate) {
    yield* handoff(assessment.decision);
    yield {
      type: "done",
      summary: {
        question,
        answer: handoffText(assessment.decision),
        topScore: assessment.topScore,
        scoreKind: assessment.scoreKind,
        chunkCount: chunks.length,
        confidence: null,
        decision: assessment.decision,
        modelId,
        thresholdApplied: assessment.thresholdApplied,
      },
    };
    return;
  }

  const generated = await input.generator.stream({
    tenantId: input.tenantId,
    messages: input.messages,
    chunks,
  });

  if (!generated.ok) {
    const decision: EscalationDecision = {
      escalate: true,
      signal: 2,
      rule: "no_self_report",
      reason: "The assistant could not answer just now.",
    };
    yield* handoff(decision);
    yield {
      type: "done",
      summary: {
        question,
        answer: handoffText(decision),
        topScore: assessment.topScore,
        scoreKind: assessment.scoreKind,
        chunkCount: chunks.length,
        confidence: null,
        decision,
        modelId,
        thresholdApplied: assessment.thresholdApplied,
      },
    };
    return;
  }

  let answer = "";
  let report: SelfReport | null = null;
  let failed = false;
  for await (const chunk of generated.value) {
    switch (chunk.type) {
      case "text-delta":
        answer += chunk.text;
        yield { type: "text-delta", text: chunk.text };
        break;
      case "self-report":
        report = chunk.report;
        break;
      case "error":
        // Mid-stream: the visitor is already reading a partial answer, so the
        // stream is not restarted. The turn is finished off as an escalation,
        // which is what a half-answer deserves.
        failed = true;
        break;
      default: {
        const exhaustive: never = chunk;
        throw new Error(`Unhandled generation chunk ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // A failed stream cannot have produced a trustworthy report even if one
  // arrived, so it is dropped rather than being allowed to pass signal 2.
  const decision = checkSelfReport(failed ? null : report, input.thresholds);
  if (decision.escalate) {
    // No canned text here: the visitor already has the model's answer. Adding a
    // second paragraph contradicting it reads worse than a quiet handoff.
    yield { type: "escalation", decision };
  }

  yield {
    type: "done",
    summary: {
      question,
      answer,
      topScore: assessment.topScore,
      scoreKind: assessment.scoreKind,
      chunkCount: chunks.length,
      confidence: failed ? null : (report?.confidence ?? null),
      decision,
      modelId,
      thresholdApplied: assessment.thresholdApplied,
    },
  };
}

/**
 * What the visitor sees when a turn escalates before the model ever ran. Said
 * plainly, because the alternative is silence while a human is found.
 */
function handoffText(decision: EscalationDecision): string {
  const reason = decision.escalate ? decision.reason : "";
  return `${reason} Let me pass you to someone who can help.`.trim();
}

function* handoff(decision: EscalationDecision): TurnEventGenerator {
  yield { type: "escalation", decision };
  yield { type: "text-delta", text: handoffText(decision) };
}

/**
 * Qualified as `globalThis.Generator` because this module exports its own
 * `Generator` interface, which shadows the built-in one.
 */
type TurnEventGenerator = globalThis.Generator<TurnEvent, void, unknown>;
