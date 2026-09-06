import { describe, expect, it } from "vitest";
import { parseSelfReport, REPORT_CONFIDENCE_TOOL, replyTools } from "../src/output.ts";

describe("parseSelfReport", () => {
  it("accepts a well formed report", () => {
    expect(
      parseSelfReport({ confidence: 0.8, needs_human: false, reason: "Covered by the FAQ" }),
    ).toEqual({ confidence: 0.8, needsHuman: false, reason: "Covered by the FAQ" });
  });

  it("defaults an absent reason to null rather than an empty string", () => {
    expect(parseSelfReport({ confidence: 0.8, needs_human: false })).toEqual({
      confidence: 0.8,
      needsHuman: false,
      reason: null,
    });
  });

  it.each([
    ["a confidence above 1", { confidence: 1.5, needs_human: false }],
    ["a negative confidence", { confidence: -0.2, needs_human: false }],
    ["a missing needs_human", { confidence: 0.5 }],
    ["a stringly typed confidence", { confidence: "0.5", needs_human: false }],
    ["nothing at all", undefined],
    ["a bare string", "very confident"],
  ])("returns null for %s, so the caller can tell it apart from a low score", (_label, input) => {
    expect(parseSelfReport(input)).toBeNull();
  });
});

describe("replyTools", () => {
  it("exposes exactly the tool the prompt names", () => {
    expect(Object.keys(replyTools)).toEqual([REPORT_CONFIDENCE_TOOL]);
  });
});
