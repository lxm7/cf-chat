import { err, ok, type Result, type TenantId } from "@cf-chat/shared";
import { z } from "zod";
import {
  DEFAULT_SEARCH_LIMIT,
  type IndexableDocument,
  type IndexError,
  type IndexedItem,
  type Indexer,
  latestUserMessage,
  type RetrievalError,
  type RetrievalMessage,
  type RetrievedChunk,
  type Retriever,
  type ScoreKind,
  type SearchOptions,
} from "./types.ts";

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
 * The read side of the binding, kept separate from `AiSearchInstanceLike`
 * rather than added to it. The real `env.AI_SEARCH` satisfies both, but the two
 * halves are used by different classes and faked independently in tests, so
 * widening the write-side interface would force every existing indexer fake to
 * grow a `search` it never calls.
 */
export interface AiSearchSearchable {
  search(params: {
    // Narrower than the binding accepts, deliberately: a parameter type wider
    // than the real one would make the real binding fail to satisfy this.
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    ai_search_options?: {
      retrieval?: {
        retrieval_type?: "vector" | "keyword" | "hybrid";
        max_num_results?: number;
        match_threshold?: number;
      };
      reranking?: { enabled?: boolean; model?: string };
      query_rewrite?: { enabled?: boolean };
    };
  }): Promise<unknown>;
}

export interface AiSearchQueryNamespaceLike {
  get(name: string): AiSearchSearchable;
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

/**
 * An error the index reports *about an item*, as opposed to one thrown at us.
 *
 * The distinction is load-bearing and getting it wrong cost ten minutes of
 * pointless polling per file: a thrown timeout means the item is still in
 * flight and should be reconciled, while `status: "error"` means AI Search
 * finished and reached a verdict. Re-reading that verdict returns the same
 * answer however many times we ask, so nothing here is ever retryable.
 *
 * Cloudflare's own guidance agrees: the recommended action for `timeout_error`
 * is to sync the item again, not to wait for it.
 */
function classifyItemError(message: string): IndexError {
  const classified = classify(message);
  switch (classified.kind) {
    case "rejected":
      return classified;
    case "timeout":
      return { kind: "rejected", reason: "processing_timeout", message };
    // An unrecognised code on a failed item is still a failed item. Reporting it
    // as an outage sends the caller back to poll an item that has already
    // finished failing.
    case "unavailable":
      return { kind: "rejected", reason: "processing_failed", message };
    default: {
      const exhaustive: never = classified;
      throw new Error(`Unhandled index error: ${JSON.stringify(exhaustive)}`);
    }
  }
}

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
    return err(classifyItemError(item.error ?? `AI Search reported status ${item.status}`));
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
        const pending = await this.#findByKeyOn(instance, doc.name);
        // Only a found item helps here. A failed lookup, or an index that holds
        // nothing under the key, both leave the original timeout standing.
        if (pending.ok && pending.value) {
          return ok(pending.value);
        }
      }
      return err(failure);
    }

    return toIndexedItem(raw);
  }

  /**
   * The item stored under a key. `ok(null)` means the index holds nothing there,
   * which is a real answer rather than a failure: a delete asking after an item
   * that was never created is already in the state it wants.
   */
  async findByKey(
    tenantId: TenantId,
    key: string,
  ): Promise<Result<IndexedItem | null, IndexError>> {
    let instance: AiSearchInstanceLike;
    try {
      instance = this.#namespace.get(instanceId(tenantId));
    } catch (cause) {
      return err(fromThrown(cause));
    }
    return this.#findByKeyOn(instance, key);
  }

  /**
   * The lookup against an instance we already hold, so the post-timeout path in
   * `upload` does not resolve the instance a second time.
   */
  async #findByKeyOn(
    instance: AiSearchInstanceLike,
    key: string,
  ): Promise<Result<IndexedItem | null, IndexError>> {
    let raw: unknown;
    try {
      raw = await instance.items.list({ key, per_page: 1 });
    } catch (cause) {
      return err(fromThrown(cause));
    }

    const parsed = listItems.safeParse(raw);
    if (!parsed.success) {
      return err({
        kind: "unavailable",
        message: "AI Search returned an item list in an unrecognised shape",
      });
    }
    // Filtered again on the exact key: `key` is documented as an exact filter,
    // but a widened match would otherwise address the wrong item.
    const match = parsed.data.result.find((item) => item.key === key);
    if (!match) {
      return ok(null);
    }
    return toIndexedItem(match);
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

/**
 * The search response, parsed at the boundary like every other binding reply.
 *
 * `scoring_details` is optional because it is the part that disappears when
 * reranking is off, and that absence is exactly what `scoreKind` exists to
 * record. Parsing it as required would turn a misconfigured instance into an
 * "unrecognised shape" outage, which is both wrong and unactionable.
 */
const searchChunk = z.object({
  id: z.string().min(1),
  text: z.string(),
  score: z.number(),
  item: z.object({
    key: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  }),
  scoring_details: z
    .object({
      reranking_score: z.number().nullish(),
    })
    .nullish(),
});

const searchResponse = z.object({
  chunks: z.array(searchChunk),
});

type SearchChunk = z.infer<typeof searchChunk>;

/**
 * The readable name behind an item key.
 *
 * The ingest consumer names items `${sourceId}-${filename}` so that two sources
 * may share a filename (see `itemName` in apps/app/src/ingest.ts). Stripping
 * the prefix back off is what makes a citation say "billing-faq.md" rather than
 * a uuid the visitor has never seen.
 */
function chunkTitle(key: string, sourceId: string | null): string {
  if (sourceId && key.startsWith(`${sourceId}-`)) {
    return key.slice(sourceId.length + 1);
  }
  return key;
}

/** Metadata comes back as unknown, so the one field we wrote is read carefully. */
function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toRetrievedChunk(chunk: SearchChunk): RetrievedChunk {
  const reranked = chunk.scoring_details?.reranking_score;
  // The fused score is only ever a fallback for reporting. ADR-006 forbids
  // thresholding it, which is why the kind travels with the number rather than
  // being inferred by whoever reads it.
  const hasReranker = typeof reranked === "number";
  const scoreKind: ScoreKind = hasReranker ? "reranker" : "fused";
  const sourceId = metadataString(chunk.item.metadata, "source_id");

  return {
    id: chunk.id,
    content: chunk.text,
    score: hasReranker ? reranked : chunk.score,
    scoreKind,
    source: {
      id: sourceId ?? chunk.item.key,
      title: chunkTitle(chunk.item.key, sourceId),
      // Uploaded files have no public URL. Website sources will, when step 3's
      // URL ingestion path grows one.
      url: null,
    },
  };
}

/**
 * The read half of the retrieval seam (ADR-002), sibling to `AISearchIndexer`.
 *
 * Reads through `get` rather than create-or-get: an instance is created by the
 * first ingest, and a search has no business provisioning one. Searching a
 * tenant that has never uploaded anything is a legitimate question with the
 * answer "nothing", which signal 1 turns into an escalation.
 */
export class AISearchRetriever implements Retriever {
  readonly #namespace: AiSearchQueryNamespaceLike;
  readonly #rerankingModel: string | undefined;

  constructor(namespace: AiSearchQueryNamespaceLike, options?: { rerankingModel?: string }) {
    this.#namespace = namespace;
    this.#rerankingModel = options?.rerankingModel;
  }

  async search(
    tenantId: TenantId,
    messages: readonly RetrievalMessage[],
    options?: SearchOptions,
  ): Promise<Result<RetrievedChunk[], RetrievalError>> {
    // An empty question retrieves nothing meaningful, and asking anyway spends a
    // rewrite inference to find that out.
    if (latestUserMessage(messages).trim().length === 0) {
      return ok([]);
    }

    let raw: unknown;
    try {
      raw = await this.#namespace.get(instanceId(tenantId)).search({
        // The whole recent window, not just the last turn: `query_rewrite` is
        // what resolves "what about the pro plan?" into something retrievable,
        // and it can only do that if it can see what came before.
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        ai_search_options: {
          retrieval: {
            retrieval_type: "hybrid",
            max_num_results: options?.limit ?? DEFAULT_SEARCH_LIMIT,
          },
          // Enabled per request as well as at instance creation. Both default
          // off, and the reranker score is the only number signal 1 may gate on.
          reranking: {
            enabled: true,
            ...(this.#rerankingModel ? { model: this.#rerankingModel } : {}),
          },
          query_rewrite: { enabled: true },
        },
      });
    } catch (cause) {
      return err(fromThrownRetrieval(cause));
    }

    const parsed = searchResponse.safeParse(raw);
    if (!parsed.success) {
      return err({
        kind: "unavailable",
        message: "AI Search returned search results in an unrecognised shape",
      });
    }

    return ok(parsed.data.chunks.map(toRetrievedChunk));
  }
}

/**
 * Retrieval has only two failure kinds, so the indexer's richer classification
 * does not transfer. The one distinction worth making is "this tenant has no
 * instance yet", which is a configuration state rather than an outage and which
 * the caller reports differently.
 */
function fromThrownRetrieval(cause: unknown): RetrievalError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";
  const normalised = message.toLowerCase();

  if (
    name === "AiSearchNotFoundError" ||
    normalised.includes("instance_not_found") ||
    normalised.includes("not found")
  ) {
    return {
      kind: "not_configured",
      message: "This workspace has no search index yet. Upload a knowledge source first.",
    };
  }
  return { kind: "unavailable", message };
}
