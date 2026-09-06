import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import { FixtureRetriever } from "../src/fixture.ts";
import type { RetrievalMessage, RetrievedChunk } from "../src/types.ts";

const tenantA = newTenantId();
const tenantB = newTenantId();

function chunk(id: string, content: string): RetrievedChunk {
  return {
    id,
    content,
    score: 0,
    scoreKind: "reranker",
    source: { id: `src-${id}`, title: id, url: null },
  };
}

/** The common case: one standalone question. */
function ask(content: string): RetrievalMessage[] {
  return [{ role: "user", content }];
}

const retriever = new FixtureRetriever({
  [tenantA]: [
    chunk("refunds", "Refunds are issued within 14 days of the request"),
    chunk("shipping", "Shipping takes three to five working days"),
  ],
  [tenantB]: [chunk("secret", "Tenant B refunds are handled by finance")],
});

describe("FixtureRetriever", () => {
  it("ranks by term overlap", async () => {
    const result = await retriever.search(tenantA, ask("refunds"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.id).toBe("refunds");
    expect(result.value[0]?.score).toBe(1);
  });

  it("never returns another tenant's chunks", async () => {
    const result = await retriever.search(tenantA, ask("refunds"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.id)).not.toContain("secret");
  });

  it("returns nothing for a tenant with no content", async () => {
    const result = await retriever.search(newTenantId(), ask("refunds"));
    expect(result.ok && result.value).toEqual([]);
  });

  it("respects the limit", async () => {
    const result = await retriever.search(tenantA, ask("refunds shipping days"), { limit: 1 });
    expect(result.ok && result.value).toHaveLength(1);
  });

  it("scores against the last user turn, not the assistant's reply", async () => {
    const result = await retriever.search(tenantA, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Shipping takes three to five working days" },
      { role: "user", content: "refunds" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.id).toBe("refunds");
  });

  it("records the whole window, so a follow-up test can assert what was sent", async () => {
    const recording = new FixtureRetriever({ [tenantA]: [chunk("plans", "The pro plan is £20")] });
    const window: RetrievalMessage[] = [
      { role: "user", content: "what plans are there" },
      { role: "assistant", content: "Free and pro." },
      { role: "user", content: "pro" },
    ];
    await recording.search(tenantA, window);
    expect(recording.queries.at(-1)).toEqual(window);
  });

  it("reports failure as an error rather than throwing, so the loop can escalate", async () => {
    const failing = new FixtureRetriever({}, { kind: "unavailable", message: "index offline" });
    const result = await failing.search(tenantA, ask("refunds"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });
});
