import type { RetrievedChunk } from "@cf-chat/retrieval";
import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import { FixtureGenerator } from "../src/fixture.ts";
import type { GenerationChunk, GenerationInput } from "../src/types.ts";

const tenantId = newTenantId();

function chunk(id: string, content: string, score: number): RetrievedChunk {
  return {
    id,
    content,
    score,
    scoreKind: "reranker",
    source: { id: `src-${id}`, title: id, url: null },
  };
}

function input(chunks: RetrievedChunk[]): GenerationInput {
  return { tenantId, messages: [{ role: "user", content: "how do refunds work" }], chunks };
}

/** Drain a generation into the two things a caller actually assembles. */
async function drain(stream: AsyncIterable<GenerationChunk>) {
  const chunks: GenerationChunk[] = [];
  let text = "";
  for await (const part of stream) {
    chunks.push(part);
    if (part.type === "text-delta") {
      text += part.text;
    }
  }
  return { chunks, text };
}

describe("FixtureGenerator", () => {
  it("answers from the highest scoring chunk", async () => {
    const generator = new FixtureGenerator();
    const result = await generator.stream(
      input([chunk("low", "Shipping is slow", 0.2), chunk("high", "Refunds take 14 days", 0.9)]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { text } = await drain(result.value);
    expect(text).toBe("Refunds take 14 days");
  });

  it("streams in deltas rather than one lump, so chunk boundaries get exercised", async () => {
    const generator = new FixtureGenerator();
    const result = await generator.stream(input([chunk("a", "Refunds take 14 days", 0.9)]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chunks } = await drain(result.value);
    expect(chunks.filter((c) => c.type === "text-delta").length).toBeGreaterThan(1);
  });

  it("reports confidence equal to the top chunk score, so signal 2 is drivable", async () => {
    const generator = new FixtureGenerator();
    const result = await generator.stream(input([chunk("a", "Refunds take 14 days", 0.42)]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chunks } = await drain(result.value);
    const report = chunks.find((c) => c.type === "self-report");
    expect(report).toEqual({
      type: "self-report",
      report: { confidence: 0.42, needsHuman: false, reason: null },
    });
  });

  it("asks for a human when it was given nothing to answer from", async () => {
    const generator = new FixtureGenerator();
    const result = await generator.stream(input([]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chunks } = await drain(result.value);
    const report = chunks.find((c) => c.type === "self-report");
    expect(report?.type === "self-report" && report.report.needsHuman).toBe(true);
  });

  it("can stand in for a model that skipped the tool call", async () => {
    const generator = new FixtureGenerator("fixture/echo", { report: null });
    const result = await generator.stream(input([chunk("a", "Refunds take 14 days", 0.9)]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chunks, text } = await drain(result.value);
    expect(text).toBe("Refunds take 14 days");
    expect(chunks.some((c) => c.type === "self-report")).toBe(false);
  });

  it("reports a failure to start as an error rather than throwing", async () => {
    const generator = new FixtureGenerator("fixture/echo", {
      failure: { kind: "unavailable", message: "model offline" },
    });

    const result = await generator.stream(input([chunk("a", "anything", 0.9)]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });

  it("delivers a mid-stream failure as a chunk, because the visitor is already reading", async () => {
    const generator = new FixtureGenerator("fixture/echo", {
      midStreamFailure: { kind: "rate_limited", message: "slow down" },
    });

    const result = await generator.stream(input([chunk("a", "one two three four five six", 0.9)]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chunks, text } = await drain(result.value);
    expect(text.length).toBeGreaterThan(0);
    expect(chunks.at(-1)).toEqual({
      type: "error",
      error: { kind: "rate_limited", message: "slow down" },
    });
  });

  it("records what it was asked, so the prompt inputs can be asserted on", async () => {
    const generator = new FixtureGenerator();
    const given = input([chunk("a", "Refunds take 14 days", 0.9)]);
    await generator.stream(given);
    expect(generator.inputs).toEqual([given]);
  });
});
