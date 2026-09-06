import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { RetrievedChunk } from "@cf-chat/retrieval";
import { newTenantId } from "@cf-chat/shared";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import type { GenerationChunk, GenerationInput } from "../src/types.ts";
import { WorkersAIGenerator } from "../src/workers-ai.ts";

const tenantId = newTenantId();

const chunk: RetrievedChunk = {
  id: "c1",
  content: "Refunds are issued within 14 days.",
  score: 0.9,
  scoreKind: "reranker",
  source: { id: "src-1", title: "billing-faq.md", url: null },
};

const input: GenerationInput = {
  tenantId,
  messages: [{ role: "user", content: "how do refunds work" }],
  chunks: [chunk],
};

const FINISH: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
};

/**
 * A model that emits exactly the parts we script. Drives the real `streamText`
 * so the mapping is tested through the SDK rather than around it.
 */
function modelEmitting(parts: LanguageModelV4StreamPart[]) {
  // Annotated rather than `satisfies`: ReadableStream is invariant in its
  // element type, so the array has to *be* the SDK union, not merely satisfy it.
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    ...parts,
    FINISH,
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

function text(id: string, ...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })),
    { type: "text-end", id },
  ];
}

function toolCall(input: string): LanguageModelV4StreamPart {
  return { type: "tool-call", toolCallId: "call-1", toolName: "report_confidence", input };
}

async function drain(stream: AsyncIterable<GenerationChunk>) {
  const chunks: GenerationChunk[] = [];
  let answer = "";
  for await (const part of stream) {
    chunks.push(part);
    if (part.type === "text-delta") answer += part.text;
  }
  return { chunks, answer };
}

describe("WorkersAIGenerator", () => {
  it("streams text deltas through and surfaces the self report from the tool call", async () => {
    const generator = new WorkersAIGenerator(
      modelEmitting([
        ...text("t1", "Refunds ", "take ", "14 days."),
        toolCall(JSON.stringify({ confidence: 0.85, needs_human: false, reason: "In the FAQ" })),
      ]),
      "@cf/moonshotai/kimi-k2.6",
    );

    const result = await generator.stream(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks, answer } = await drain(result.value);
    expect(answer).toBe("Refunds take 14 days.");
    expect(chunks.find((c) => c.type === "self-report")).toEqual({
      type: "self-report",
      report: { confidence: 0.85, needsHuman: false, reason: "In the FAQ" },
    });
  });

  it("emits no self report when the model skipped the tool call, so signal 2 escalates", async () => {
    const generator = new WorkersAIGenerator(
      modelEmitting(text("t1", "Probably about two weeks.")),
      "@cf/moonshotai/kimi-k2.6",
    );

    const result = await generator.stream(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks } = await drain(result.value);
    expect(chunks.some((c) => c.type === "self-report")).toBe(false);
  });

  it("reports malformed tool arguments as an error rather than a silent skip", async () => {
    // Distinguishable from "did not call the tool": both escalate, but only one
    // of them means the prompt or the schema needs work.
    const generator = new WorkersAIGenerator(
      modelEmitting([
        ...text("t1", "Refunds take 14 days."),
        toolCall(JSON.stringify({ confidence: 7, needs_human: "maybe" })),
      ]),
      "@cf/moonshotai/kimi-k2.6",
    );

    const result = await generator.stream(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks } = await drain(result.value);
    expect(chunks.some((c) => c.type === "self-report")).toBe(false);
    expect(chunks.some((c) => c.type === "error" && c.error.kind === "malformed_output")).toBe(
      true,
    );
  });

  it("delivers a mid-stream model error as a chunk, not a throw", async () => {
    const generator = new WorkersAIGenerator(
      modelEmitting([
        ...text("t1", "Refunds "),
        { type: "error", error: new Error("upstream capacity exceeded") },
      ]),
      "@cf/moonshotai/kimi-k2.6",
    );

    const result = await generator.stream(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { chunks, answer } = await drain(result.value);
    expect(answer).toBe("Refunds ");
    expect(chunks.some((c) => c.type === "error" && c.error.kind === "rate_limited")).toBe(true);
  });

  it("puts the retrieved content and the tool instruction in the system prompt", async () => {
    let seenSystem = "";
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const system = prompt.find((message) => message.role === "system");
        seenSystem = typeof system?.content === "string" ? system.content : "";
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          ...text("t1", "ok"),
          FINISH,
        ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const result = await new WorkersAIGenerator(model, "@cf/moonshotai/kimi-k2.6", {
      tenantName: "Acme",
    }).stream(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await drain(result.value);

    expect(seenSystem).toContain("Acme");
    expect(seenSystem).toContain("Refunds are issued within 14 days.");
    expect(seenSystem).toContain("report_confidence");
  });

  it("carries the model id as data, per ADR-005", () => {
    const generator = new WorkersAIGenerator(modelEmitting([]), "@cf/moonshotai/kimi-k2.6");
    expect(generator.modelId).toBe("@cf/moonshotai/kimi-k2.6");
  });
});
