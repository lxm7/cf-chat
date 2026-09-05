import { err, ok, type Result, type TenantId } from "@cf-chat/shared";
import {
  DEFAULT_SEARCH_LIMIT,
  type IndexableDocument,
  type IndexError,
  type IndexedItem,
  type Indexer,
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

/**
 * Test double for the write side. Records what was uploaded so a test can
 * assert on it, and can be primed to fail on the nth call to exercise the
 * consumer's retry and error paths.
 */
export class FixtureIndexer implements Indexer {
  readonly uploaded = new Map<string, IndexableDocument & { readonly itemId: string }>();
  readonly removed: string[] = [];
  readonly lookedUp: string[] = [];
  readonly checked: string[] = [];
  #failure: IndexError | null;
  #calls = 0;
  #uploadStatus: IndexedItem["status"] = "completed";
  #statuses: Array<Result<IndexedItem, IndexError>> = [];

  constructor(failure: IndexError | null = null) {
    this.#failure = failure;
  }

  /** Fail the next upload only, then behave normally. Drives the retry test. */
  failOnce(error: IndexError): void {
    this.#failure = error;
    this.#calls = 0;
  }

  /**
   * Make uploads return without having finished indexing, which is the case
   * that leaves a row in `indexing` and arms a check.
   */
  uploadsSettleAs(status: IndexedItem["status"]): void {
    this.#uploadStatus = status;
  }

  /**
   * Script what successive `status` calls return, so a test can walk a row from
   * `running` to `completed` the way the real index would. The last entry
   * repeats once the script runs out.
   */
  statusReturns(...results: Array<Result<IndexedItem, IndexError>>): void {
    this.#statuses = [...results];
  }

  async upload(
    tenantId: TenantId,
    doc: IndexableDocument,
  ): Promise<Result<IndexedItem, IndexError>> {
    this.#calls += 1;
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = null;
      return err(failure);
    }

    const itemId = `item-${tenantId}-${this.#calls}`;
    this.uploaded.set(itemId, { ...doc, itemId });
    const chunks = typeof doc.content === "string" ? Math.ceil(doc.content.length / 512) : 1;
    return ok({
      itemId,
      key: doc.name,
      status: this.#uploadStatus,
      // Nothing is chunked until indexing completes, so an unfinished upload
      // reports no count rather than a made-up one.
      chunkCount: this.#uploadStatus === "completed" ? chunks : null,
    });
  }

  async status(tenantId: TenantId, itemId: string): Promise<Result<IndexedItem, IndexError>> {
    this.checked.push(itemId);

    const scripted = this.#statuses.length > 1 ? this.#statuses.shift() : this.#statuses[0];
    if (scripted) {
      return scripted;
    }

    const doc = this.uploaded.get(itemId);
    if (!doc) {
      return err({
        kind: "rejected",
        reason: "not_found",
        message: `No such item ${itemId} for tenant ${tenantId}`,
      });
    }
    return ok({ itemId, key: doc.name, status: "completed", chunkCount: 1 });
  }

  /**
   * Keyed on the document name the upload was given, which is what the real
   * index keys an item on. Mirrors the production contract: `ok(null)` for a
   * key the index does not hold.
   */
  async findByKey(
    _tenantId: TenantId,
    key: string,
  ): Promise<Result<IndexedItem | null, IndexError>> {
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = null;
      return err(failure);
    }
    this.lookedUp.push(key);

    for (const [itemId, doc] of this.uploaded) {
      if (doc.name === key) {
        return ok({ itemId, key, status: "completed", chunkCount: null });
      }
    }
    return ok(null);
  }

  async remove(_tenantId: TenantId, itemId: string): Promise<Result<void, IndexError>> {
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = null;
      return err(failure);
    }
    this.uploaded.delete(itemId);
    this.removed.push(itemId);
    return ok(undefined);
  }
}
