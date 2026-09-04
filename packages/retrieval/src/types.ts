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

export interface IndexableDocument {
  /**
   * Becomes the item key in the index, and upload is an upsert keyed on it, so
   * it must be unique per source and stable across retries. Two sources with
   * the same filename must not collide.
   */
  readonly name: string;
  readonly content: ReadableStream | Blob | string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface IndexedItem {
  readonly itemId: string;
  readonly key: string;
  /**
   * `completed` means searchable now. `queued` and `running` mean indexing
   * outlived our poll window, which is not a failure: the item keeps indexing
   * and a delayed check message settles the row later by calling `status`.
   */
  readonly status: "queued" | "running" | "completed";
  readonly chunkCount: number | null;
}

export type IndexError =
  | { readonly kind: "unavailable"; readonly message: string }
  | {
      readonly kind: "rejected";
      /**
       * `not_found` is terminal like the rest: the index no longer holds the
       * item, so no amount of waiting brings it back. Without it a status check
       * would treat a deleted item as a transient failure and re-arm forever.
       */
      readonly reason: "too_large" | "unsupported_type" | "empty" | "not_found";
      readonly message: string;
    };

/**
 * The write half of the retrieval seam, symmetrical with `Retriever` so both
 * sides of ADR-002's escape hatch are swappable rather than just the read side.
 * See ADR-012 for what a non-AI-Search implementation would have to provide.
 *
 * Returns a Result for the same reason `Retriever` does: an ingest failure is
 * an expected outcome that belongs on the source row, not an exception that
 * poisons a queue batch.
 */
export interface Indexer {
  upload(tenantId: TenantId, doc: IndexableDocument): Promise<Result<IndexedItem, IndexError>>;
  /**
   * Where an item got to since `upload` stopped watching. On the interface
   * rather than in a reader of its own because any implementation that can
   * index has to be able to answer this to be swappable at all.
   */
  status(tenantId: TenantId, itemId: string): Promise<Result<IndexedItem, IndexError>>;
  remove(tenantId: TenantId, itemId: string): Promise<Result<void, IndexError>>;
}
