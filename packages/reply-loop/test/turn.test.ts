import { FixtureRetriever, type RetrievedChunk } from "@cf-chat/retrieval";
import { DEFAULT_ESCALATION_THRESHOLDS, newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import { FixtureGenerator } from "../src/fixture.ts";
import { runTurn, type TurnEvent, type TurnSummary } from "../src/turn.ts";
import type { GeneratorMessage } from "../src/types.ts";

const tenantId = newTenantId();
const thresholds = DEFAULT_ESCALATION_THRESHOLDS;

function chunk(id: string, content: string): RetrievedChunk {
  return {
    id,
    content,
    score: 0,
    scoreKind: "reranker",
    source: { id: `src-${id}`, title: `${id}.md`, url: null },
  };
}

/** Term overlap in FixtureRetriever means a full match scores 1. */
const knowledge = {
  [tenantId]: [
    chunk("refunds", "refunds are issued within 14 days"),
    chunk("shipping", "shipping takes three to five working days"),
  ],
};

async function collect(events: AsyncIterable<TurnEvent>) {
  const all: TurnEvent[] = [];
  let text = "";
  let summary: TurnSummary | null = null;
  for await (const event of events) {
    all.push(event);
    if (event.type === "text-delta") text += event.text;
    if (event.type === "done") summary = event.summary;
  }
  return { all, text, summary };
}

function ask(content: string): GeneratorMessage[] {
  return [{ role: "user", content }];
}

describe("runTurn", () => {
  it("answers from retrieved sources and does not escalate when everything is clear", async () => {
    const { all, text, summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge),
        generator: new FixtureGenerator("fixture/echo", {
          report: { confidence: 0.92, needsHuman: false, reason: null },
        }),
        thresholds,
      }),
    );

    expect(text).toBe("refunds are issued within 14 days");
    expect(all.some((e) => e.type === "escalation")).toBe(false);
    expect(summary?.decision.escalate).toBe(false);
    expect(summary?.confidence).toBe(0.92);
    expect(summary?.chunkCount).toBe(1);
  });

  it("emits sources before any answer text, so citations can render alongside", async () => {
    const { all } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge),
        generator: new FixtureGenerator(),
        thresholds,
      }),
    );

    const sourcesAt = all.findIndex((e) => e.type === "sources");
    const firstTextAt = all.findIndex((e) => e.type === "text-delta");
    expect(sourcesAt).toBeGreaterThanOrEqual(0);
    expect(sourcesAt).toBeLessThan(firstTextAt);
  });

  it("escalates on a hard rule without spending retrieval or inference", async () => {
    const retriever = new FixtureRetriever(knowledge);
    const generator = new FixtureGenerator();

    const { all, summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("can I speak to a human please"),
        retriever,
        generator,
        thresholds,
      }),
    );

    expect(summary?.decision.escalate).toBe(true);
    if (!summary?.decision.escalate) return;
    expect(summary.decision.signal).toBe(3);
    // The point of evaluating signal 3 first: neither of these was touched.
    expect(retriever.queries).toHaveLength(0);
    expect(generator.inputs).toHaveLength(0);
    expect(all.some((e) => e.type === "sources")).toBe(false);
  });

  it("escalates when nothing was retrieved, without asking the model to guess", async () => {
    const generator = new FixtureGenerator();

    const { summary, text } = await collect(
      runTurn({
        tenantId,
        messages: ask("what is your VAT number"),
        retriever: new FixtureRetriever(knowledge),
        generator,
        thresholds,
      }),
    );

    expect(summary?.decision.escalate).toBe(true);
    if (!summary?.decision.escalate) return;
    expect(summary.decision.signal).toBe(1);
    expect(generator.inputs).toHaveLength(0);
    expect(text).toContain("pass you to someone");
  });

  it("escalates when the model reports low confidence, keeping the answer it gave", async () => {
    const { text, summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge),
        generator: new FixtureGenerator("fixture/echo", {
          report: { confidence: 0.1, needsHuman: false, reason: "Not sure that covers it" },
        }),
        thresholds,
      }),
    );

    expect(text).toBe("refunds are issued within 14 days");
    expect(summary?.decision.escalate).toBe(true);
    if (!summary?.decision.escalate) return;
    expect(summary.decision.signal).toBe(2);
    expect(summary.decision.rule).toBe("below_confidence_threshold");
  });

  it("escalates when the model skipped its report", async () => {
    const { summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge),
        generator: new FixtureGenerator("fixture/echo", { report: null }),
        thresholds,
      }),
    );

    expect(summary?.decision.escalate).toBe(true);
    if (!summary?.decision.escalate) return;
    expect(summary.decision.rule).toBe("no_self_report");
    expect(summary.confidence).toBeNull();
  });

  it("degrades a retrieval outage into a handoff rather than an error", async () => {
    const { summary, text } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever({}, { kind: "unavailable", message: "index offline" }),
        generator: new FixtureGenerator(),
        thresholds,
      }),
    );

    expect(summary?.decision.escalate).toBe(true);
    if (!summary?.decision.escalate) return;
    expect(summary.decision.rule).toBe("retrieval_failed");
    expect(text).toContain("pass you to someone");
  });

  it("says a workspace has no knowledge base when that is the actual problem", async () => {
    const { text } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever({}, { kind: "not_configured", message: "no instance" }),
        generator: new FixtureGenerator(),
        thresholds,
      }),
    );

    expect(text).toContain("no knowledge base set up yet");
  });

  it("distrusts a report that arrived on a stream that then failed", async () => {
    // A half-answer plus a confident score is the worst combination to let
    // through: the visitor sees a truncated reply presented as complete.
    const { summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge),
        generator: new FixtureGenerator("fixture/echo", {
          report: { confidence: 1, needsHuman: false, reason: null },
          midStreamFailure: { kind: "unavailable", message: "connection lost" },
        }),
        thresholds,
      }),
    );

    expect(summary?.decision.escalate).toBe(true);
    expect(summary?.confidence).toBeNull();
  });

  it("passes the whole window to retrieval so follow-ups can be rewritten", async () => {
    const retriever = new FixtureRetriever(knowledge);
    const window: GeneratorMessage[] = [
      { role: "user", content: "tell me about refunds" },
      { role: "assistant", content: "refunds are issued within 14 days" },
      { role: "user", content: "refunds" },
    ];

    await collect(
      runTurn({
        tenantId,
        messages: window,
        retriever,
        generator: new FixtureGenerator(),
        thresholds,
      }),
    );

    expect(retriever.queries.at(-1)).toEqual(window);
  });

  it("records the score kind so a misconfigured reranker is visible in the log", async () => {
    const { summary } = await collect(
      runTurn({
        tenantId,
        messages: ask("refunds"),
        retriever: new FixtureRetriever(knowledge, null, "fused"),
        generator: new FixtureGenerator("fixture/echo", {
          report: { confidence: 0.9, needsHuman: false, reason: null },
        }),
        thresholds,
      }),
    );

    expect(summary?.scoreKind).toBe("fused");
    expect(summary?.thresholdApplied).toBe(false);
    // Still answered: a fused score is not grounds to refuse, only grounds not
    // to threshold. Signal 2 remains the backstop.
    expect(summary?.decision.escalate).toBe(false);
  });
});
