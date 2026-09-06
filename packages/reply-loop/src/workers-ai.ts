import { err, ok, type Result } from "@cf-chat/shared";
import { type LanguageModel, stepCountIs, streamText } from "ai";
import { parseSelfReport, REPORT_CONFIDENCE_TOOL, replyTools } from "./output.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { GenerationChunk, GenerationError, GenerationInput, Generator } from "./types.ts";

export interface WorkersAIGeneratorOptions {
  /** Falls back to the tenant's own name being unavailable at construction. */
  readonly tenantName?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/**
 * The production generator.
 *
 * Takes a constructed AI SDK model rather than the `Ai` binding, which is what
 * keeps this package free of workers types and testable against a mock model.
 * The binding, the gateway id and the model id are assembled in `apps/app`,
 * where the environment actually lives.
 */
export class WorkersAIGenerator implements Generator {
  readonly modelId: string;
  readonly #model: LanguageModel;
  readonly #options: WorkersAIGeneratorOptions;

  constructor(model: LanguageModel, modelId: string, options: WorkersAIGeneratorOptions = {}) {
    this.#model = model;
    this.modelId = modelId;
    this.#options = options;
  }

  async stream(
    input: GenerationInput,
  ): Promise<Result<AsyncIterable<GenerationChunk>, GenerationError>> {
    let stream: AsyncIterable<unknown>;
    try {
      const result = streamText({
        model: this.#model,
        system: buildSystemPrompt({
          chunks: input.chunks,
          tenantName: this.#options.tenantName ?? "this company",
        }),
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: replyTools,
        // The load-bearing half of the terminal tool call. Without this the SDK
        // would feed the tool result back and call the model a second time,
        // which is the "no extra inference call per turn" ADR-006 rules out.
        // The report is read off the `tool-call` part below, so the second step
        // would buy nothing and cost a full generation.
        stopWhen: stepCountIs(1),
        ...(this.#options.temperature === undefined
          ? {}
          : { temperature: this.#options.temperature }),
        ...(this.#options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: this.#options.maxOutputTokens }),
      });
      stream = result.fullStream;
    } catch (cause) {
      // Only a synchronous failure to start reaches here: bad configuration, an
      // unusable model. Everything after the first chunk arrives as an error
      // chunk, because by then the visitor is already reading a half-answer.
      return err(classify(cause));
    }

    return ok(toGenerationChunks(stream));
  }
}

/**
 * Narrow the SDK's stream part union to the three things the reply loop cares
 * about. Parts we ignore (reasoning, step boundaries, tool input deltas) are
 * ignored deliberately: adding them to `GenerationChunk` would put SDK
 * vocabulary into an interface whose whole point is to hide it.
 */
async function* toGenerationChunks(stream: AsyncIterable<unknown>): AsyncIterable<GenerationChunk> {
  for await (const part of stream) {
    if (typeof part !== "object" || part === null || !("type" in part)) {
      continue;
    }

    const typed = part as { type: unknown };
    if (typed.type === "text-delta" && "text" in part && typeof part.text === "string") {
      yield { type: "text-delta", text: part.text };
      continue;
    }

    if (typed.type === "tool-call" && "toolName" in part && "input" in part) {
      if (part.toolName !== REPORT_CONFIDENCE_TOOL) {
        continue;
      }
      const report = parseSelfReport(part.input);
      if (report) {
        yield { type: "self-report", report };
      } else {
        // The model called the tool with arguments that do not validate. That
        // is not the same as not calling it, and the caller escalates either
        // way, but the message says which happened.
        yield {
          type: "error",
          error: {
            kind: "malformed_output",
            message: "The model reported its confidence in an unusable shape",
          },
        };
      }
      continue;
    }

    if (typed.type === "error" && "error" in part) {
      yield { type: "error", error: classify(part.error) };
    }
  }
}

/**
 * Rate limiting is worth separating from a generic outage: it is the one
 * failure where retrying the same request later is the right move, and on
 * Workers AI it is the one most likely to show up under load.
 */
function classify(cause: unknown): GenerationError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalised = message.toLowerCase();

  if (
    normalised.includes("rate limit") ||
    normalised.includes("rate_limit") ||
    normalised.includes("429") ||
    normalised.includes("capacity")
  ) {
    return { kind: "rate_limited", message };
  }
  return { kind: "unavailable", message };
}
