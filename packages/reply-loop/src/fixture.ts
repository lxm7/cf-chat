import { err, ok, type Result } from "@cf-chat/shared";
import type { GenerationError, GenerationInput, GenerationOutput, Generator } from "./types.ts";

/**
 * Test double for the generator. Deterministic by construction: it answers from
 * the highest-scoring chunk it was given and reports confidence equal to that
 * chunk's score, so escalation tests can drive signal 1 and signal 2 together
 * without any inference call.
 */
export class FixtureGenerator implements Generator {
  readonly modelId: string;
  readonly #failure: GenerationError | null;

  constructor(modelId = "fixture/echo", failure: GenerationError | null = null) {
    this.modelId = modelId;
    this.#failure = failure;
  }

  async generate(input: GenerationInput): Promise<Result<GenerationOutput, GenerationError>> {
    if (this.#failure) {
      return err(this.#failure);
    }

    const best = [...input.chunks].sort((a, b) => b.score - a.score)[0];
    if (!best) {
      return ok({
        answer: "I do not have anything on that. Would you like a human to take a look?",
        confidence: 0,
        needsHuman: true,
      });
    }

    return ok({
      answer: best.content,
      confidence: best.score,
      needsHuman: false,
    });
  }
}
