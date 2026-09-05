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
  /**
   * Declared structurally like the rest of this file rather than pulled from
   * workers-types. Only `key` is used here: the binding documents it as the
   * item's exact object key, unique per source.
   */
  list(params?: { key?: string; per_page?: number }): Promise<unknown>;
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

/**
 * The list endpoint's envelope. Parsed at the boundary like every other binding
 * response: this one is only read after a timeout, which is exactly when a
 * surprise in the shape would be least welcome.
 */
const listItems = z.object({
  result: z.array(itemInfo),
});

/** Map AI Search's own error text onto the reasons the dashboard can act on. */
function classify(message: string, errorName?: string): IndexError {
  const normalised = message.toLowerCase();

  // Matched against AI Search's published indexing error codes rather than
  // guessed from prose, so a wording change upstream cannot silently reclassify
  // a permanent failure as a retryable one:
  // developers.cloudflare.com/ai-search/troubleshooting/indexing-error-codes/
  const has = (...codes: readonly string[]) => codes.some((code) => normalised.includes(code));

  // Terminal: the item is gone, so a caller waiting for it to finish never will.
  if (errorName === "AiSearchNotFoundError" || has("item_not_found", "not found")) {
    return { kind: "rejected", reason: "not_found", message };
  }
  // Terminal: too big at some stage of the pipeline. Re-sending the same bytes
  // produces the same verdict.
  if (has("over_size", "maximum size", "markdown_too_large", "chunk_too_large_for_storage")) {
    return { kind: "rejected", reason: "too_large", message };
  }
  // Terminal: AI Search cannot turn this format into text. `unable_to_convert_to_markdown`
  // is the one that used to fall through to `unavailable` and burn three retries.
  if (has("unable_to_convert_to_markdown", "invalid_pdf", "unsupported", "content type")) {
    return { kind: "rejected", reason: "unsupported_type", message };
  }
  // Terminal, and distinct from an unsupported type: the format is fine and this
  // particular file is not, so the fix is a different file rather than a
  // different format.
  if (has("file_is_corrupt", "file_is_password_locked")) {
    return { kind: "rejected", reason: "unreadable", message };
  }
  // Terminal: converted, but there was nothing in it to index.
  if (has("file_content_empty", "markdown_conversion_empty", "conversion_empty", "empty")) {
    return { kind: "rejected", reason: "empty", message };
  }
  // `uploadAndPoll` gives up by throwing, not by returning a pending item, so
  // without this a slow index is indistinguishable from an outage and gets its
  // bytes re-sent on every retry until the message dead-letters.
  if (errorName === "TimeoutError" || has("timeout_error", "timed out", "timeout")) {
    return { kind: "timeout", message };
  }
  // Anything unrecognised is assumed transient. That is the safe default for a
  // queue, but it means a novel permanent failure burns three retries before
  // surfacing, so the message is logged by the caller rather than discarded.
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
    // Resolved in its own step so the catch below can rely on having an
    // instance to look the item up through. Folding both into one try would
    // mean the recovery path referencing a binding that may never have been
    // assigned.
    let instance: AiSearchInstanceLike;
    try {
      instance = await this.#instance(tenantId);
    } catch (cause) {
      return err(fromThrown(cause));
    }

    let raw: unknown;
    try {
      raw = await instance.items.uploadAndPoll(doc.name, doc.content, {
        ...(doc.metadata ? { metadata: { ...doc.metadata } } : {}),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      const failure = fromThrown(cause);
      // `uploadAndPoll` gives up by throwing, but the item it created is still
      // indexing: the binding's own message says to inspect the item status.
      // Reporting that as a failure would re-send the bytes on every retry for
      // work already in flight. Look the item up by key and hand it back as
      // pending, so the caller takes the same reconcile path it takes when the
      // poll returns an unfinished item (ADR-011.8).
      if (failure.kind === "timeout") {
        const pending = await this.#findByKey(instance, doc.name);
        if (pending) {
          return pending;
        }
      }
      return err(failure);
    }

    return toIndexedItem(raw);
  }

  /**
   * The item behind a key, or null when the lookup itself fails or finds
   * nothing. Returns null rather than an error because the only caller is a
   * best-effort recovery: if this cannot answer, the original failure stands.
   */
  async #findByKey(
    instance: AiSearchInstanceLike,
    key: string,
  ): Promise<Result<IndexedItem, IndexError> | null> {
    let raw: unknown;
    try {
      raw = await instance.items.list({ key, per_page: 1 });
    } catch {
      return null;
    }

    const parsed = listItems.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    // Filtered again on the exact key: `key` is documented as an exact filter,
    // but a widened match would otherwise reconcile against the wrong item.
    const match = parsed.data.result.find((item) => item.key === key);
    return match ? toIndexedItem(match) : null;
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

  /**
   * Classified like its siblings rather than reporting every throw as an
   * outage. The distinction is what the delete cleanup decides on: `not_found`
   * is the state a delete is trying to reach, so it acks, where `unavailable`
   * is an outage that has to go back on the queue.
   */
  async remove(tenantId: TenantId, itemId: string): Promise<Result<void, IndexError>> {
    try {
      await this.#namespace.get(instanceId(tenantId)).items.delete(itemId);
      return ok(undefined);
    } catch (cause) {
      return err(fromThrown(cause));
    }
  }
}
