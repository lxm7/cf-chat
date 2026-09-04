import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import { FixtureRetriever } from "../src/fixture.ts";
import type { RetrievedChunk } from "../src/types.ts";

const tenantA = newTenantId();
const tenantB = newTenantId();

function chunk(id: string, content: string): RetrievedChunk {
  return { id, content, score: 0, source: { id: `src-${id}`, title: id, url: null } };
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
    const result = await retriever.search(tenantA, "refunds");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.id).toBe("refunds");
    expect(result.value[0]?.score).toBe(1);
  });

  it("never returns another tenant's chunks", async () => {
    const result = await retriever.search(tenantA, "refunds");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.id)).not.toContain("secret");
  });

  it("returns nothing for a tenant with no content", async () => {
    const result = await retriever.search(newTenantId(), "refunds");
    expect(result.ok && result.value).toEqual([]);
  });

  it("respects the limit", async () => {
    const result = await retriever.search(tenantA, "refunds shipping days", { limit: 1 });
    expect(result.ok && result.value).toHaveLength(1);
  });

  it("reports failure as an error rather than throwing, so the loop can escalate", async () => {
    const failing = new FixtureRetriever({}, { kind: "unavailable", message: "index offline" });
    const result = await failing.search(tenantA, "refunds");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });
});
