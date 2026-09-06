import { err, ok, type Result } from "@cf-chat/shared";
import type {
  GenerationChunk,
  GenerationError,
  GenerationInput,
  Generator,
  SelfReport,
} from "./types.ts";

export interface FixtureGeneratorOptions {
  /**
   * What the model "reports" on the next turn. `null` stands in for a model
   * that skipped the tool call, which is the case signal 2 has to escalate on.
   */
  readonly report?: SelfReport | null;
  /** Fails before a single chunk, the way bad configuration would. */
  readonly failure?: GenerationError | null;
  /** Fails partway through, after some text has already reached the visitor. */
  readonly midStreamFailure?: GenerationError | null;
}

/**
 * Test double for the generator. Deterministic by construction: it answers from
 * the highest-scoring chunk it was given and, unless told otherwise, reports
 * confidence equal to that chunk's score, so escalation tests can drive signal
 * 1 and signal 2 together without any inference call.
 *
 * Streams the answer in word-sized deltas rather than one lump, so a consumer
 * that mishandles chunk boundaries fails here rather than in production.
 */
export class FixtureGenerator implements Generator {
  readonly modelId: string;
  readonly inputs: GenerationInput[] = [];
  #options: FixtureGeneratorOptions;

  constructor(modelId = "fixture/echo", options: FixtureGeneratorOptions = {}) {
    this.modelId = modelId;
    this.#options = options;
  }

  /** Change what the next turn does, for multi-turn tests. */
  configure(options: FixtureGeneratorOptions): void {
    this.#options = options;
  }

  async stream(
    input: GenerationInput,
  ): Promise<Result<AsyncIterable<GenerationChunk>, GenerationError>> {
    this.inputs.push(input);

    if (this.#options.failure) {
      return err(this.#options.failure);
    }

    const best = [...input.chunks].sort((a, b) => b.score - a.score)[0];
    const answer = best
      ? best.content
      : "I do not have anything on that. Would you like a human to take a look?";
    // An unanswerable question reports needing a human, matching what a
    // well-behaved model would do rather than leaving the fixture optimistic.
    const fallbackReport: SelfReport = best
      ? { confidence: best.score, needsHuman: false, reason: null }
      : { confidence: 0, needsHuman: true, reason: "No sources matched." };
    const report = this.#options.report === undefined ? fallbackReport : this.#options.report;
    const midStreamFailure = this.#options.midStreamFailure ?? null;

    return ok(
      (async function* () {
        const words = answer.split(" ");
        for (const [index, word] of words.entries()) {
          if (midStreamFailure && index === Math.floor(words.length / 2)) {
            yield { type: "error", error: midStreamFailure } as const;
            return;
          }
          yield { type: "text-delta", text: index === 0 ? word : ` ${word}` } as const;
        }
        if (report) {
          yield { type: "self-report", report } as const;
        }
      })(),
    );
  }
}
