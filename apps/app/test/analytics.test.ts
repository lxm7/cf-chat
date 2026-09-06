import { newConversationId, newTenantId, newVisitorId } from "@cf-chat/shared";
import { describe, expect, it, vi } from "vitest";
import { type AnalyticsDeps, analyticsOne } from "../src/analytics.ts";
import { dispatchBatch, type QueueHandlers } from "../src/queues.ts";

const tenantId = newTenantId();
const conversationId = newConversationId();
const visitorId = newVisitorId();

function turn(overrides: Record<string, unknown> = {}) {
  return {
    kind: "turn",
    tenantId,
    conversationId,
    visitorId,
    question: "how do refunds work",
    answer: "Refunds take 14 days.",
    topScore: 0.82,
    scoreKind: "reranker",
    chunkCount: 3,
    confidence: 0.9,
    escalated: false,
    signal: null,
    rule: null,
    modelId: "@cf/moonshotai/kimi-k2.6",
    ...overrides,
  };
}

function harness(recordTurn?: AnalyticsDeps["recordTurn"]) {
  const recorded: unknown[] = [];
  const deps: AnalyticsDeps = {
    recordTurn:
      recordTurn ??
      (async (_tenantId, _conversationId, _visitorId, message) => {
        recorded.push(message);
      }),
  };
  return { deps, recorded };
}

describe("analyticsOne", () => {
  it("records a well formed turn", async () => {
    const { deps, recorded } = harness();
    expect(await analyticsOne(turn(), deps)).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it("carries the escalation signal and rule through to the row", async () => {
    const { deps, recorded } = harness();
    await analyticsOne(turn({ escalated: true, signal: 1, rule: "no_chunks" }), deps);
    expect(recorded[0]).toMatchObject({ escalated: true, signal: 1, rule: "no_chunks" });
  });

  it("keeps the score kind, so reranker and fused scores are never compared later", async () => {
    const { deps, recorded } = harness();
    await analyticsOne(turn({ scoreKind: "fused", topScore: 0.03 }), deps);
    expect(recorded[0]).toMatchObject({ scoreKind: "fused" });
  });

  it.each([
    ["a missing tenant", turn({ tenantId: "not-a-uuid" })],
    ["an out of range signal", turn({ signal: 9 })],
    ["a stringly typed confidence", turn({ confidence: "high" })],
    ["an unknown kind", turn({ kind: "something-else" })],
    ["nothing at all", undefined],
  ])("acks %s rather than retrying a shape no retry can fix", async (_label, message) => {
    const { deps, recorded } = harness();
    expect(await analyticsOne(message, deps)).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("retries a database failure, because nobody is waiting on this write", async () => {
    const { deps } = harness(async () => {
      throw new Error("connection reset");
    });
    expect(await analyticsOne(turn(), deps)).toBe(false);
  });

  it("accepts a null confidence, which is what a skipped self report looks like", async () => {
    const { deps, recorded } = harness();
    expect(await analyticsOne(turn({ confidence: null, escalated: true, signal: 2 }), deps)).toBe(
      true,
    );
    expect(recorded[0]).toMatchObject({ confidence: null });
  });
});

describe("dispatchBatch", () => {
  function handlers() {
    return {
      ingest: vi.fn(async () => {}),
      ingestDeadLetter: vi.fn(async () => {}),
      analytics: vi.fn(async () => {}),
      analyticsDeadLetter: vi.fn(async () => {}),
    } satisfies QueueHandlers;
  }

  function batch(queue: string) {
    return {
      queue,
      messages: [],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown> & { ackAll: ReturnType<typeof vi.fn> };
  }

  it.each([
    ["cf-chat-ingest", "ingest"],
    ["cf-chat-ingest-dlq", "ingestDeadLetter"],
    ["cf-chat-analytics", "analytics"],
    ["cf-chat-analytics-dlq", "analyticsDeadLetter"],
  ] as const)("routes %s to its own consumer", async (queue, expected) => {
    const routes = handlers();
    await dispatchBatch(batch(queue), routes);

    for (const [name, handler] of Object.entries(routes)) {
      expect(handler, name).toHaveBeenCalledTimes(name === expected ? 1 : 0);
    }
  });

  it("acks a batch from a queue nobody claims, rather than retrying it forever", async () => {
    const received = batch("cf-chat-something-new");
    await dispatchBatch(received, handlers());
    expect(received.ackAll).toHaveBeenCalledTimes(1);
  });
});
