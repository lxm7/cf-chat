import type { Result, TenantId } from "@cf-chat/shared";

export interface ChunkSource {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
}

export interface RetrievedChunk {
  readonly id: string;
  /**
   * Retrieved text. Treated as data, never as instructions: the reply loop
   * wraps it in delimiters before it reaches the model.
   */
  readonly content: string;
  /**
   * Reranker cross-encoder score. This is the one score worth thresholding on;
   * the fused hybrid score is rank-derived and not comparable across queries
   * (ADR-006).
   */
  readonly score: number;
  readonly source: ChunkSource;
}

export interface SearchOptions {
  /** Defaults to 8, matching the reply loop's k in architecture.md. */
  readonly limit?: number;
}

export type RetrievalError =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "not_configured"; readonly message: string };

/**
 * The seam that keeps AI Search swappable for Vectorize (ADR-002). Returns a
 * Result rather than throwing: a retrieval failure has to degrade into an
 * escalation, not a 500.
 */
export interface Retriever {
  search(
    tenantId: TenantId,
    query: string,
    options?: SearchOptions,
  ): Promise<Result<RetrievedChunk[], RetrievalError>>;
}

export const DEFAULT_SEARCH_LIMIT = 8;
