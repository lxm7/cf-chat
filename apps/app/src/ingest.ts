import { env } from "cloudflare:workers";
import type { SourceStatusUpdate } from "@cf-chat/db";
import { findSource, updateSourceStatus, withTenant } from "@cf-chat/db";
import type { SourceRow } from "@cf-chat/db/schema";
import { AISearchIndexer, type Indexer } from "@cf-chat/retrieval";
import {
  AI_SEARCH_MAX_BYTES,
  type SourceId,
  sourceIdSchema,
  type TenantId,
  tenantIdSchema,
} from "@cf-chat/shared";
import { z } from "zod";
import { withDb } from "./api/db.ts";

/**
 * Queue messages cross a trust boundary like any other input: a malformed or
 * stale message must not take the consumer down, it must be dealt with.
 */
const ingestMessage = z.object({
  tenantId: tenantIdSchema,
  sourceId: sourceIdSchema,
});

export type IngestMessage = z.infer<typeof ingestMessage>;

/**
 * Everything the ingest step touches, injected rather than reached for.
 *
 * Hyperdrive has no local emulation and AI Search has none either, so a
 * consumer that closed over its bindings could only be tested against live
 * services. With these passed in, the whole decision tree is exercised by
 * fixtures and the emulated R2 binding.
 */
export interface IngestDeps {
  readonly indexer: Indexer;
  readonly storage: Pick<R2Bucket, "get">;
  readonly convert: (filename: string, blob: Blob) => Promise<string>;
  readonly findSource: (tenantId: TenantId, sourceId: SourceId) => Promise<SourceRow | undefined>;
  readonly setStatus: (
    tenantId: TenantId,
    sourceId: SourceId,
    update: SourceStatusUpdate,
  ) => Promise<void>;
}

/**
 * The item name doubles as the upsert key in AI Search, so it is derived from
 * the source id rather than the filename: two sources may share a filename, and
 * a retry of the same source must overwrite rather than duplicate.
 */
export function itemName(sourceId: SourceId, filename: string): string {
  return `${sourceId}-${filename}`;
}

/**
 * AI Search refuses anything over 4MB, and converts what it does accept anyway.
 * Converting first turns an oversized PDF into markdown that comfortably fits,
 * and gives better chunking for PDFs of any size. See ADR-011.
 */
export function needsConversion(contentType: string, sizeBytes: number): boolean {
  return sizeBytes > AI_SEARCH_MAX_BYTES || contentType === "application/pdf";
}

/**
 * One message. Never throws: every outcome is either "done, ack it" (true) or
 * "transient, put it back" (false), so a poison file cannot stall the queue.
 */
export async function ingestOne(raw: unknown, deps: IngestDeps): Promise<boolean> {
  const parsed = ingestMessage.safeParse(raw);
  if (!parsed.success) {
    // Acking a malformed message: no number of retries will fix its shape.
    console.error("Discarding unparseable ingest message", raw);
    return true;
  }
  const { tenantId, sourceId } = parsed.data;

  const row = await deps.findSource(tenantId, sourceId);
  if (!row) {
    console.error("Ingest message for a source that no longer exists", sourceId);
    return true; // Deleted while queued.
  }
  if (row.status === "ready") {
    return true; // Already indexed by an earlier delivery.
  }

  await deps.setStatus(tenantId, sourceId, { status: "indexing" });

  const object = await deps.storage.get(row.r2Key);
  if (!object) {
    await deps.setStatus(tenantId, sourceId, {
      status: "error",
      errorCode: "missing_object",
      errorMessage: "The uploaded file is no longer in storage",
    });
    return true;
  }

  let content: ReadableStream | string;
  try {
    content = needsConversion(row.contentType, row.sizeBytes)
      ? await deps.convert(row.filename, await object.blob())
      : object.body;
  } catch (cause) {
    await deps.setStatus(tenantId, sourceId, {
      status: "error",
      errorCode: "conversion_failed",
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
    return true;
  }

  const uploaded = await deps.indexer.upload(tenantId, {
    name: itemName(sourceId, row.filename),
    content,
    metadata: { source_id: sourceId, tenant_id: tenantId },
  });

  if (!uploaded.ok) {
    const failure = uploaded.error;
    // A rejection is about this file and fails identically on every retry.
    // An outage is not, so that one goes back on the queue.
    if (failure.kind === "unavailable") {
      await deps.setStatus(tenantId, sourceId, {
        status: "uploaded",
        errorCode: "retrying",
        errorMessage: failure.message,
      });
      return false;
    }
    await deps.setStatus(tenantId, sourceId, {
      status: "error",
      errorCode: failure.reason,
      errorMessage: failure.message,
    });
    return true;
  }

  const item = uploaded.value;
  await deps.setStatus(tenantId, sourceId, {
    // Indexing can outlive the poll window without having failed. Leaving the
    // row in `indexing` is honest; a later delivery settles it.
    status: item.status === "completed" ? "ready" : "indexing",
    aiSearchItemId: item.itemId,
    chunkCount: item.chunkCount,
    errorCode: null,
    errorMessage: null,
  });
  return true;
}

/** The production wiring: real bindings, real database, real index. */
function liveDeps(): IngestDeps {
  return {
    indexer: new AISearchIndexer(env.AI_SEARCH),
    storage: env.KNOWLEDGE,
    convert: async (filename, blob) => {
      const converted = await env.AI.toMarkdown({ name: filename, blob });
      const result = Array.isArray(converted) ? converted[0] : converted;
      if (!result?.data) {
        throw new Error(`Markdown conversion produced no text for ${filename}`);
      }
      return result.data;
    },
    findSource: (tenantId, sourceId) => withDb((db) => findSource(db, tenantId, sourceId)),
    // Writes go through withTenant because the RLS policies require the GUC.
    setStatus: async (tenantId, sourceId, update) => {
      await withDb((db) =>
        withTenant(db, tenantId, (tx) => updateSourceStatus(tx, tenantId, sourceId, update)),
      );
    },
  };
}

/**
 * The `ingest` queue consumer, attached to the default export in `src/server.ts`
 * per ADR-010.
 *
 * Messages are acked individually so a single poison file cannot drag a whole
 * batch back onto the queue, and are processed concurrently because each one
 * spends most of its time waiting on AI Search rather than burning CPU.
 */
export async function handleIngestBatch(batch: MessageBatch<unknown>): Promise<void> {
  // Deliberately not a defaulted second parameter: the runtime calls
  // queue(batch, env, ctx), so a defaulted `deps` would be silently replaced by
  // the env object at runtime while still typechecking.
  return ingestBatch(batch, liveDeps());
}

export async function ingestBatch(batch: MessageBatch<unknown>, deps: IngestDeps): Promise<void> {
  // The catch sits inside the map so the message reference survives a throw.
  // ingestOne is written not to throw, so reaching it means a bug or an
  // infrastructure failure, both of which deserve a retry rather than a drop.
  const outcomes = await Promise.all(
    batch.messages.map(async (message) => {
      try {
        return { message, done: await ingestOne(message.body, deps) };
      } catch (cause) {
        console.error("Ingest threw unexpectedly", cause);
        return { message, done: false };
      }
    }),
  );

  for (const { message, done } of outcomes) {
    if (done) {
      message.ack();
    } else {
      message.retry();
    }
  }
}
