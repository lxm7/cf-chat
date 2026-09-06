import type { RetrievedChunk, ScoreKind } from "@cf-chat/retrieval";
import type { EscalationThresholds } from "@cf-chat/shared";
import type { SelfReport } from "./types.ts";

/**
 * ADR-006's three signals, numbered as the ADR numbers them because
 * `escalation.signal` goes onto the span as a number (ADR-007).
 */
export type EscalationSignal = 1 | 2 | 3;

export type EscalationDecision =
  | { readonly escalate: false }
  | {
      readonly escalate: true;
      readonly signal: EscalationSignal;
      /** Which sub-rule fired. Stable identifier for the question log and traces. */
      readonly rule: EscalationRule;
      /** Human-readable, and safe to show a visitor. */
      readonly reason: string;
    };

export type EscalationRule =
  | "no_chunks"
  | "below_retrieval_threshold"
  /** Retrieval itself failed or is unconfigured, so signal 1 cannot be evaluated. */
  | "retrieval_failed"
  | "no_self_report"
  | "model_requested_human"
  | "below_confidence_threshold"
  | "asked_for_human"
  | "sensitive_topic";

export const NO_ESCALATION: EscalationDecision = { escalate: false };

/**
 * Phrases that mean "put me through to a person". Matched as phrases rather
 * than as bare words: "human" on its own fires on "is this a human?" and on
 * half the product questions a support bot ever sees.
 */
const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(speak|talk|chat)\s+(to|with)\s+(a\s+|an\s+)?(human|person|agent|advisor|adviser|someone|somebody|rep\b|representative)/i,
  /\b(real|actual|live)\s+(human|person|agent)\b/i,
  /\bhuman\s+(agent|support|being\s+please)\b/i,
  /\b(get|put)\s+me\s+(through\s+)?to\s+(a\s+|an\s+)?(human|person|agent|manager|supervisor)/i,
  /\b(escalate|escalation)\b/i,
  /\b(manager|supervisor)\b/i,
];

/**
 * Topics where a wrong answer is expensive enough that a human should own it.
 * ADR-006 calls these refund / cancel / legal.
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(refund|refunded|chargeback|charge\s?back|dispute\s+(the\s+)?(charge|payment))\b/i,
  /\bcancel(l)?(ing|ed)?\s+(my|our|the)\s+(account|subscription|plan|order|contract)\b/i,
  /\b(terminate|close)\s+(my|our)\s+account\b/i,
  /\b(lawyer|solicitor|attorney|legal\s+action|sue|suing|litigation|court)\b/i,
  /\b(gdpr|data\s+(deletion|erasure)|right\s+to\s+be\s+forgotten)\b/i,
  /\b(formal\s+)?complaint\b/i,
];

/**
 * Signal 3: deterministic rules on what the visitor said.
 *
 * Runs before retrieval and before any inference, so "let me talk to a human"
 * costs nothing and does not go through a model that might argue with them.
 *
 * ADR-006 lists a third rule here, strongly negative sentiment, which is not
 * implemented. It needs either a classifier call, which the same ADR forbids,
 * or a lexicon nobody has chosen. See the ADR-006 amendment: this is a known
 * gap, not an oversight.
 */
export function checkHardRules(message: string): EscalationDecision {
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      escalate: true,
      signal: 3,
      rule: "asked_for_human",
      reason: "The visitor asked to speak to a person.",
    };
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      escalate: true,
      signal: 3,
      rule: "sensitive_topic",
      reason: "The question touches refunds, cancellation or legal matters.",
    };
  }
  return NO_ESCALATION;
}

/**
 * What the retrieval gate concluded, plus the inputs ADR-006 says every
 * decision must record. Returned together because the caller needs all of it
 * for the span and the question log, and asking twice would rank the chunks
 * twice.
 */
export interface RetrievalAssessment {
  readonly decision: EscalationDecision;
  /**
   * False when the top chunk carried no reranker score, so the threshold could
   * not honestly be applied. That is a misconfigured instance (reranking off),
   * and it is recorded rather than papered over.
   */
  readonly thresholdApplied: boolean;
  readonly topScore: number | null;
  readonly scoreKind: ScoreKind | null;
}

/**
 * Signal 1: the retrieval gate.
 *
 * Nothing retrieved is an escalation. Something retrieved but below the
 * reranker threshold is an escalation. Something retrieved whose score is the
 * fused hybrid number is *not* an escalation on this signal, because that score
 * is rank-derived and comparing it to a fixed threshold would be superstition.
 * Those turns fall through to signal 2, where the model's own self report still
 * catches a groundless answer.
 */
export function assessRetrieval(
  chunks: readonly RetrievedChunk[],
  thresholds: EscalationThresholds,
): RetrievalAssessment {
  let best: RetrievedChunk | null = null;
  for (const chunk of chunks) {
    if (!best || chunk.score > best.score) {
      best = chunk;
    }
  }

  if (!best) {
    return {
      decision: {
        escalate: true,
        signal: 1,
        rule: "no_chunks",
        reason: "Nothing in the knowledge base matches this question.",
      },
      thresholdApplied: false,
      topScore: null,
      scoreKind: null,
    };
  }

  if (best.scoreKind !== "reranker") {
    return {
      decision: NO_ESCALATION,
      thresholdApplied: false,
      topScore: best.score,
      scoreKind: best.scoreKind,
    };
  }

  return {
    decision:
      best.score < thresholds.retrieval
        ? {
            escalate: true,
            signal: 1,
            rule: "below_retrieval_threshold",
            reason: "Nothing in the knowledge base matches this question closely enough.",
          }
        : NO_ESCALATION,
    thresholdApplied: true,
    topScore: best.score,
    scoreKind: best.scoreKind,
  };
}

/**
 * Signal 2: the model's self report.
 *
 * A missing report is treated as confidence 0, which escalates. ADR-006 says
 * the bias is toward over-escalating, and a model that skipped the tool call is
 * exactly the case where we know least about the answer it just gave.
 */
export function checkSelfReport(
  report: SelfReport | null,
  thresholds: EscalationThresholds,
): EscalationDecision {
  if (!report) {
    return {
      escalate: true,
      signal: 2,
      rule: "no_self_report",
      reason: "The assistant did not report its confidence, so this is going to a person.",
    };
  }
  if (report.needsHuman) {
    return {
      escalate: true,
      signal: 2,
      rule: "model_requested_human",
      reason: report.reason ?? "The assistant asked for a person to take over.",
    };
  }
  if (report.confidence < thresholds.confidence) {
    return {
      escalate: true,
      signal: 2,
      rule: "below_confidence_threshold",
      reason: report.reason ?? "The assistant was not confident enough in that answer.",
    };
  }
  return NO_ESCALATION;
}

/**
 * The three signals composed in hot-path order, for callers that have all the
 * inputs at once (the eval harness in step 10, and the tests).
 *
 * The agent does not call this: it evaluates each signal at the point where the
 * input becomes available, so signal 3 can skip retrieval and signal 1 can skip
 * generation.
 */
export function decideEscalation(input: {
  readonly message: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly report: SelfReport | null;
  readonly thresholds: EscalationThresholds;
}): EscalationDecision {
  const hard = checkHardRules(input.message);
  if (hard.escalate) {
    return hard;
  }
  const retrieval = assessRetrieval(input.chunks, input.thresholds);
  if (retrieval.decision.escalate) {
    return retrieval.decision;
  }
  return checkSelfReport(input.report, input.thresholds);
}
