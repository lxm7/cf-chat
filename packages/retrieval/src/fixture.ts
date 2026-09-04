import { err, ok, type Result, type TenantId } from "@cf-chat/shared";
import {
  DEFAULT_SEARCH_LIMIT,
  type RetrievalError,
  type RetrievedChunk,
  type Retriever,
  type SearchOptions,
} from "./types.ts";

/**
 * Test double. Tests use this, never a live binding (CLAUDE.md): AI Search has
 * no local emulation, so hitting it from tests would burn allowance and make
 * results non-deterministic.
 *
 * Scoring is naive term overlap normalised to 0..1, which is enough to exercise
 * the escalation threshold in ADR-006 without pretending to be a reranker.
 */
export class FixtureRetriever implements Retriever {
  readonly #chunksByTenant: Map<string, readonly RetrievedChunk[]>;
  readonly #failure: RetrievalError | null;

  constructor(
    chunksByTenant: Record<string, readonly RetrievedChunk[]> = {},
    failure: RetrievalError | null = null,
  ) {
    this.#chunksByTenant = new Map(Object.entries(chunksByTenant));
    this.#failure = failure;
  }

  async search(
    tenantId: TenantId,
    query: string,
    options?: SearchOptions,
  ): Promise<Result<RetrievedChunk[], RetrievalError>> {
    if (this.#failure) {
      return err(this.#failure);
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = (this.#chunksByTenant.get(tenantId) ?? [])
      .map((chunk) => {
        const content = chunk.content.toLowerCase();
        const hits = terms.filter((term) => content.includes(term)).length;
        return { ...chunk, score: terms.length === 0 ? 0 : hits / terms.length };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.limit ?? DEFAULT_SEARCH_LIMIT);

    return ok(scored);
  }
}
