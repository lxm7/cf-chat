import type { RetrievedChunk } from "@cf-chat/retrieval";
import type { Result, TenantId } from "@cf-chat/shared";

export interface GeneratorMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface GenerationInput {
  readonly tenantId: TenantId;
  readonly messages: readonly GeneratorMessage[];
  readonly chunks: readonly RetrievedChunk[];
}

/** The structured tail from ADR-006 signal 2. */
export interface GenerationOutput {
  readonly answer: string;
  /** Model self-report, 0..1. Compared against the tenant's `T_confidence`. */
  readonly confidence: number;
  readonly needsHuman: boolean;
}

export type GenerationError =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "malformed_output"; readonly message: string }
  | { readonly kind: "rate_limited"; readonly message: string };

/**
 * The seam in front of Workers AI / AI Gateway. `modelId` is carried as data
 * because ADR-005 requires the model id to be config, never hardcoded in the
 * loop.
 *
 * Streaming is not on this interface yet. It arrives with the `AIChatAgent` at
 * build step 4, where the streaming shape is driven by what the agent needs
 * rather than by a guess made here.
 */
export interface Generator {
  readonly modelId: string;
  generate(input: GenerationInput): Promise<Result<GenerationOutput, GenerationError>>;
}
