import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import type { SelfReport } from "./types.ts";

/**
 * Declared as a literal key on `replyTools` below rather than built from this
 * constant. A computed property key widens the tool set's type far enough that
 * the AI SDK infers the tool's input as `never`, which fails at the call site
 * with a wall of variance errors rather than anywhere near the cause.
 */
export const REPORT_CONFIDENCE_TOOL = "report_confidence";

/**
 * The arguments the model must supply. Snake case because that is what reads
 * naturally to a model in a JSON schema, and because it keeps the wire shape
 * stable if the internal `SelfReport` field names ever change.
 */
export const reportConfidenceInput = z.object({
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How confident you are that your answer is correct and fully supported by the sources. 0 is a guess, 1 is certain.",
    ),
  needs_human: z
    .boolean()
    .describe(
      "True if a human support agent should take over: the sources do not cover the question, the visitor asked for a person, or the request needs an action you cannot take.",
    ),
  reason: z
    .string()
    .max(280)
    .optional()
    .describe("One short sentence on why, only when needs_human is true or confidence is low."),
});

/**
 * The structured tail from ADR-006 signal 2, carried on the tool channel rather
 * than in the prose.
 *
 * `execute` is a no-op that exists for two reasons. The AI SDK's `ToolSet` type
 * requires the property to be present, and a tool without one does not satisfy
 * it under this repo's `exactOptionalPropertyTypes`. More importantly, the
 * report is read off the `tool-call` part in the stream, not off the result, so
 * there is nothing for this to compute: the caller pairs it with
 * `stopWhen: stepCountIs(1)`, which is what holds the turn to the single
 * inference call ADR-006 requires.
 */
export const reportConfidenceTool = tool({
  description:
    "Report your confidence in the answer you just gave. You must call this exactly once, after your answer, on every single turn.",
  inputSchema: reportConfidenceInput,
  execute: async (input) => input,
});

/**
 * Validate what the model actually sent.
 *
 * Returns null rather than throwing or defaulting, because "the model did not
 * report" and "the model reported low confidence" have to stay distinguishable:
 * both escalate, but only one of them means the prompt is not working.
 */
export function parseSelfReport(input: unknown): SelfReport | null {
  const parsed = reportConfidenceInput.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  return {
    confidence: parsed.data.confidence,
    needsHuman: parsed.data.needs_human,
    reason: parsed.data.reason ?? null,
  };
}

/** One entry, with a literal key so the name stays checkable below. */
const declaredTools = { report_confidence: reportConfidenceTool };

/**
 * Ties the name constant to the tool set: renaming one without the other is a
 * compile error rather than a tool call that silently never matches. It has to
 * happen here, on the uncast object, because the cast below erases the keys.
 */
const _toolNameMatches: keyof typeof declaredTools = REPORT_CONFIDENCE_TOOL;
void _toolNameMatches;

/** The tool set handed to `streamText`. */
export const replyTools = declaredTools;
