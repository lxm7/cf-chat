import type { RetrievalMessage, RetrievedChunk } from "@cf-chat/retrieval";
import type { Result, TenantId } from "@cf-chat/shared";

/**
 * A turn as the generator sees it, which is the same shape retrieval sees.
 * Aliased rather than redeclared so the two cannot drift apart.
 */
export type GeneratorMessage = RetrievalMessage;

export interface GenerationInput {
  readonly tenantId: TenantId;
  readonly messages: readonly GeneratorMessage[];
  readonly chunks: readonly RetrievedChunk[];
}

/**
 * ADR-006 signal 2, as the model reports it.
 *
 * This arrives as a terminal tool call rather than a delimiter in the prose.
 * The prose is the one part of the reply that retrieved text can influence, and
 * retrieved text is hostile by assumption, so a sentinel the model prints could
 * be forged by a poisoned chunk. Tool call arguments are parsed from a separate
 * channel and validated against a schema.
 */
export interface SelfReport {
  /** 0..1, compared against the tenant's `T_confidence`. */
  readonly confidence: number;
  readonly needsHuman: boolean;
  readonly reason: string | null;
}

/**
 * One event from a generation.
 *
 * A failure is a chunk rather than a throw, matching the Result convention in
 * `shared`: the reply may already be half-streamed when the model dies, so the
 * caller needs to handle it in the same loop it handles text, not in a catch.
 */
export type GenerationChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "self-report"; readonly report: SelfReport }
  | { readonly type: "error"; readonly error: GenerationError };

export type GenerationError =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "malformed_output"; readonly message: string }
  | { readonly kind: "rate_limited"; readonly message: string };

/**
 * The seam in front of Workers AI / AI Gateway. `modelId` is carried as data
 * because ADR-005 requires the model id to be config, never hardcoded in the
 * loop.
 *
 * The Result wraps starting the stream, which can fail outright; anything that
 * goes wrong after the first chunk arrives as an `error` chunk instead.
 */
export interface Generator {
  readonly modelId: string;
  stream(input: GenerationInput): Promise<Result<AsyncIterable<GenerationChunk>, GenerationError>>;
}
