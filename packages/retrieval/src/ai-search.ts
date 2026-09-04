import { err, ok, type Result, type TenantId } from "@cf-chat/shared";
import { z } from "zod";
import type { IndexableDocument, IndexError, IndexedItem, Indexer } from "./types.ts";

/**
 * Structural view of the `ai_search_namespaces` binding, covering only what we
 * call. Declared here rather than leaning on the ambient Workers global so this
 * package stays free of a workers-types dependency and stays trivially fakeable.
 */
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
function classify(message: string): IndexError {
  const normalised = message.toLowerCase();
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
      return err(classify(cause instanceof Error ? cause.message : String(cause)));
    }

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

    // `outdated` marks a previously indexed item as stale, which cannot apply to
    // a fresh upload. Fold it into `queued` rather than inventing a state.
    const status = item.status === "outdated" ? "queued" : item.status;

    return ok({
      itemId: item.id,
      key: item.key,
      status,
      chunkCount: item.chunks_count ?? null,
    });
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
