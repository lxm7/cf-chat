import type { RetrievedChunk } from "@cf-chat/retrieval";
import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import { FixtureGenerator } from "../src/fixture.ts";

const tenantId = newTenantId();

function chunk(id: string, content: string, score: number): RetrievedChunk {
  return { id, content, score, source: { id: `src-${id}`, title: id, url: null } };
}

describe("FixtureGenerator", () => {
  it("answers from the highest scoring chunk", async () => {
    const result = await new FixtureGenerator().generate({
      tenantId,
      messages: [{ role: "user", content: "how do refunds work" }],
      chunks: [chunk("low", "unrelated", 0.1), chunk("high", "refunds take 14 days", 0.9)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answer).toBe("refunds take 14 days");
    expect(result.value.confidence).toBe(0.9);
    expect(result.value.needsHuman).toBe(false);
  });

  it("asks for a human when retrieval found nothing", async () => {
    const result = await new FixtureGenerator().generate({
      tenantId,
      messages: [{ role: "user", content: "anything" }],
      chunks: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.needsHuman).toBe(true);
    expect(result.value.confidence).toBe(0);
  });

  it("carries the model id as data, never hardcoded in the loop", () => {
    expect(new FixtureGenerator("@cf/moonshotai/kimi-k2.5").modelId).toBe(
      "@cf/moonshotai/kimi-k2.5",
    );
  });

  it("returns an error rather than throwing when generation is unavailable", async () => {
    const generator = new FixtureGenerator("fixture/echo", {
      kind: "rate_limited",
      message: "slow down",
    });
    const result = await generator.generate({ tenantId, messages: [], chunks: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("rate_limited");
  });
});
