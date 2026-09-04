import { err, ok, type Result, type TenantId } from "@cf-chat/shared";
import { z } from "zod";
import type { IndexableDocument, IndexError, IndexedItem, Indexer } from "./types.ts";

/**
 * Structural view of the `ai_search_namespaces` binding, covering only what we
 * call. Declared here rather than leaning on the ambient Workers global so this
 * package stays free of a workers-types dependency and stays trivially fakeable.
 */
export interface AiSearchItem {
  info(): Promise<unknown>;
}

export interface AiSearchItems {
  uploadAndPoll(
    name: string,
    content: ReadableStream | Blob | string,
    options?: {
      metadata?: Record<string, unknown>;
      pollIntervalMs?: number;
      timeoutMs?: number;
    },
  ): Promise<unknown>;
  get(itemId: string): AiSearchItem;
  delete(itemId: string): Promise<unknown>;
}

export interface AiSearchInstanceLike {
  readonly items: AiSearchItems;
}

export interface AiSearchNamespaceLike {
  create(config: {
    id: string;
    index_method?: { vector?: boolean; keyword?: boolean };
    reranking?: boolean;
  }): Promise<AiSearchInstanceLike>;
  get(name: string): AiSearchInstanceLike;
}

/**
 * The single place the tenant -> instance mapping lives.
 *
 * `architecture.md` says "instance id = tenantId", which does not fit: AI Search
 * ids are 1-32 characters matching ^[a-z0-9_]+(?:-[a-z0-9_]+)*$ and a uuid is 36.
 * Stripping the hyphens gives exactly 32 lowercase hex characters, which is
 * inside the limit, collision-free and reversible. See ADR-011.
 */
export function instanceId(tenantId: TenantId): string {
  return tenantId.replaceAll("-", "");
}

/**
 * The binding's response shape is not in our control, so it gets parsed like
 * any other boundary. A silent shape change would otherwise surface as an
 * undefined item id written to the source row, which we would only notice when
 * a delete failed months later.
 */
const itemInfo = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "error", "skipped", "outdated"]),
  chunks_count: z.number().int().nonnegative().nullish(),
  error: z.string().nullish(),
});

/** Map AI Search's own error text onto the reasons the dashboard can act on. */
function classify(message: string, errorName?: string): IndexError {
  const normalised = message.toLowerCase();
  // Error 7041, or the binding's own not-found error class. Terminal: the item
  // is gone, so a caller waiting for it to finish indexing never will.
  if (
    errorName === "AiSearchNotFoundError" ||
    normalised.includes("item_not_found") ||
    normalised.includes("not found")
  ) {
    return { kind: "rejected", reason: "not_found", message };
  }
  if (normalised.includes("over_size") || normalised.includes("maximum size")) {
    return { kind: "rejected", reason: "too_large", message };
  }
  if (normalised.includes("unsupported") || normalised.includes("content type")) {
    return { kind: "rejected", reason: "unsupported_type", message };
  }
  if (normalised.includes("empty") || normalised.includes("conversion_empty")) {
    return { kind: "rejected", reason: "empty", message };
  }
  return { kind: "unavailable", message };
}

/** Every throw from the binding reaches `classify` the same way. */
function fromThrown(cause: unknown): IndexError {
  return cause instanceof Error ? classify(cause.message, cause.name) : classify(String(cause));
}

/**
 * `upload` and `status` are handed the same item shape, so they settle it the
 * same way: parse it, turn a terminal status into a rejection, and fold
 * `outdated` into `queued`.
 */
function toIndexedItem(raw: unknown): Result<IndexedItem, IndexError> {
  const parsed = itemInfo.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "unavailable",
      message: "AI Search returned an item in an unrecognised shape",
    });
  }

  const item = parsed.data;
  if (item.status === "error" || item.status === "skipped") {
    return err(classify(item.error ?? `AI Search reported status ${item.status}`));
  }

  // `outdated` means a previously indexed item has gone stale and is due to be
  // reindexed. For both callers that is the same "not settled yet" as `queued`,
  // so it folds in rather than becoming a state of its own.
  const status = item.status === "outdated" ? "queued" : item.status;

  return ok({
    itemId: item.id,
    key: item.key,
    status,
    chunkCount: item.chunks_count ?? null,
  });
}

export class AISearchIndexer implements Indexer {
  readonly #namespace: AiSearchNamespaceLike;
  readonly #timeoutMs: number;

  constructor(namespace: AiSearchNamespaceLike, options?: { timeoutMs?: number }) {
    this.#namespace = namespace;
    this.#timeoutMs = options?.timeoutMs ?? 30_000;
  }

  /**
   * Create-or-get. Provisioning is lazy (ADR-011): an instance with no
   * documents does nothing, so the first ingest is the first moment one is
   * needed. `create` failing because the instance already exists is the common
   * case rather than an error, and the consumer's retry makes any other
   * failure self-healing.
   *
   * Both flags matter and both default off. `index_method.keyword` is what
   * makes retrieval hybrid rather than vector-only, and `reranking` is what
   * produces the cross-encoder score that ADR-006 thresholds escalation on.
   */
  async #instance(tenantId: TenantId): Promise<AiSearchInstanceLike> {
    const id = instanceId(tenantId);
    try {
      return await this.#namespace.create({
        id,
        index_method: { vector: true, keyword: true },
        reranking: true,
      });
    } catch {
      return this.#namespace.get(id);
    }
  }

  /**
   * `uploadAndPoll` is an upsert keyed on the item name, so a retry after a
   * partial failure overwrites rather than duplicating. That is why the caller
   * passes a name derived from the source id and does not have to delete first.
   */
  async upload(
    tenantId: TenantId,
    doc: IndexableDocument,
  ): Promise<Result<IndexedItem, IndexError>> {
    let raw: unknown;
    try {
      const instance = await this.#instance(tenantId);
      raw = await instance.items.uploadAndPoll(doc.name, doc.content, {
        ...(doc.metadata ? { metadata: { ...doc.metadata } } : {}),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      return err(fromThrown(cause));
    }

    return toIndexedItem(raw);
  }

  /**
   * Where the item got to after `upload` stopped polling, which is what turns a
   * row left in `indexing` into a terminal state.
   *
   * Reads through `get` rather than create-or-get: by the time anything asks,
   * the upload has already created the instance, and a status read has no
   * business creating one.
   */
  async status(tenantId: TenantId, itemId: string): Promise<Result<IndexedItem, IndexError>> {
    let raw: unknown;
    try {
      raw = await this.#namespace.get(instanceId(tenantId)).items.get(itemId).info();
    } catch (cause) {
      return err(fromThrown(cause));
    }

    return toIndexedItem(raw);
  }

  async remove(tenantId: TenantId, itemId: string): Promise<Result<void, IndexError>> {
    try {
      await this.#namespace.get(instanceId(tenantId)).items.delete(itemId);
      return ok(undefined);
    } catch (cause) {
      return err({
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
