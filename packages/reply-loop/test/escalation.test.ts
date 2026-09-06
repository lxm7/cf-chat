import type { RetrievedChunk, ScoreKind } from "@cf-chat/retrieval";
import { DEFAULT_ESCALATION_THRESHOLDS, type EscalationThresholds } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import {
  assessRetrieval,
  checkHardRules,
  checkSelfReport,
  decideEscalation,
} from "../src/escalation.ts";
import type { SelfReport } from "../src/types.ts";

const thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS;

function chunk(score: number, scoreKind: ScoreKind = "reranker"): RetrievedChunk {
  return {
    id: "c",
    content: "Refunds take 14 days",
    score,
    scoreKind,
    source: { id: "src", title: "faq.md", url: null },
  };
}

function report(overrides: Partial<SelfReport> = {}): SelfReport {
  return { confidence: 0.9, needsHuman: false, reason: null, ...overrides };
}

describe("signal 3, hard rules", () => {
  it.each([
    "can I speak to a human",
    "talk to an agent please",
    "get me through to a person",
    "I want a real person",
    "please escalate this",
    "let me speak with someone",
  ])("escalates when the visitor asks for a person: %s", (message) => {
    const decision = checkHardRules(message);
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.signal).toBe(3);
    expect(decision.rule).toBe("asked_for_human");
  });

  it.each([
    "I want a refund",
    "cancel my subscription",
    "I am going to speak to my lawyer",
    "this is a formal complaint",
    "GDPR data deletion request",
  ])("escalates on sensitive topics: %s", (message) => {
    const decision = checkHardRules(message);
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.rule).toBe("sensitive_topic");
  });

  it.each([
    "is this a human or a bot?",
    "how do I export my data",
    "what are your opening hours",
    "does the pro plan include SSO",
  ])("does not fire on ordinary questions that merely contain the words: %s", (message) => {
    // The phrase matching exists precisely so "is this a human" does not
    // escalate every curious visitor straight to an agent.
    expect(checkHardRules(message).escalate).toBe(false);
  });
});

describe("signal 1, the retrieval gate", () => {
  it("escalates when nothing was retrieved", () => {
    const assessment = assessRetrieval([], thresholds);
    expect(assessment.decision.escalate).toBe(true);
    if (!assessment.decision.escalate) return;
    expect(assessment.decision.signal).toBe(1);
    expect(assessment.decision.rule).toBe("no_chunks");
    expect(assessment.topScore).toBeNull();
  });

  it("escalates when the best reranker score is below the threshold", () => {
    const assessment = assessRetrieval([chunk(0.1), chunk(0.2)], thresholds);
    expect(assessment.decision.escalate).toBe(true);
    if (!assessment.decision.escalate) return;
    expect(assessment.decision.rule).toBe("below_retrieval_threshold");
    expect(assessment.topScore).toBe(0.2);
    expect(assessment.thresholdApplied).toBe(true);
  });

  it("passes when the best reranker score clears the threshold", () => {
    const assessment = assessRetrieval([chunk(0.1), chunk(0.8)], thresholds);
    expect(assessment.decision.escalate).toBe(false);
    expect(assessment.topScore).toBe(0.8);
    expect(assessment.scoreKind).toBe("reranker");
  });

  it("declines to gate on a fused score rather than thresholding a meaningless number", () => {
    // A fused score is rank-derived and not comparable across queries. 0.05
    // would escalate if it were treated as a reranker score; it must not.
    const assessment = assessRetrieval([chunk(0.05, "fused")], thresholds);
    expect(assessment.decision.escalate).toBe(false);
    expect(assessment.thresholdApplied).toBe(false);
    expect(assessment.scoreKind).toBe("fused");
    expect(assessment.topScore).toBe(0.05);
  });

  it("still escalates on no chunks even when reranking is misconfigured", () => {
    expect(assessRetrieval([], thresholds).decision.escalate).toBe(true);
  });
});

describe("signal 2, the model self report", () => {
  it("escalates when the model did not report at all", () => {
    const decision = checkSelfReport(null, thresholds);
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.signal).toBe(2);
    expect(decision.rule).toBe("no_self_report");
  });

  it("escalates when the model asked for a human", () => {
    const decision = checkSelfReport(
      report({ needsHuman: true, reason: "Needs an account change" }),
      thresholds,
    );
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.rule).toBe("model_requested_human");
    expect(decision.reason).toBe("Needs an account change");
  });

  it("escalates below the confidence threshold", () => {
    const decision = checkSelfReport(report({ confidence: 0.3 }), thresholds);
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.rule).toBe("below_confidence_threshold");
  });

  it("passes a confident answer", () => {
    expect(checkSelfReport(report({ confidence: 0.95 }), thresholds).escalate).toBe(false);
  });

  it("treats the threshold as a floor, not a ceiling", () => {
    const exactly = checkSelfReport(report({ confidence: thresholds.confidence }), thresholds);
    expect(exactly.escalate).toBe(false);
  });
});

describe("decideEscalation", () => {
  it("lets a hard rule win before retrieval or the model get a say", () => {
    const decision = decideEscalation({
      message: "I want to speak to a human",
      chunks: [chunk(0.99)],
      report: report({ confidence: 1 }),
      thresholds,
    });
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.signal).toBe(3);
  });

  it("lets the retrieval gate win over a confident model", () => {
    // The bias ADR-006 asks for: a model claiming certainty on nothing is
    // exactly the case worth catching.
    const decision = decideEscalation({
      message: "what are your opening hours",
      chunks: [],
      report: report({ confidence: 1 }),
      thresholds,
    });
    expect(decision.escalate).toBe(true);
    if (!decision.escalate) return;
    expect(decision.signal).toBe(1);
  });

  it("does not escalate when all three signals are clear", () => {
    const decision = decideEscalation({
      message: "what are your opening hours",
      chunks: [chunk(0.8)],
      report: report({ confidence: 0.9 }),
      thresholds,
    });
    expect(decision.escalate).toBe(false);
  });
});
