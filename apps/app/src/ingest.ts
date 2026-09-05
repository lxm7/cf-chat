import { env } from "cloudflare:workers";
import type { SourceStatusUpdate } from "@cf-chat/db";
import { deleteSource, findSource, updateSourceStatus, withTenant } from "@cf-chat/db";
import type { SourceRow } from "@cf-chat/db/schema";
import { AISearchIndexer, type Indexer } from "@cf-chat/retrieval";
import {
  AI_SEARCH_MAX_BYTES,
  INDEX_CHECK_DELAY_SECONDS,
  MAX_INDEX_CHECKS,
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
 *
 * Two kinds ride the same queue. `index` uploads the R2 object; `check` asks
 * AI Search whether an upload that outlived the poll window has finished. They
 * are a union rather than one shape with optional fields so the consumer cannot
 * read `attempt` on a message that has no business carrying one.
 */
const indexMessage = z.object({
  kind: z.literal("index"),
  tenantId: tenantIdSchema,
  sourceId: sourceIdSchema,
});

const checkMessage = z.object({
  kind: z.literal("check"),
  tenantId: tenantIdSchema,
  sourceId: sourceIdSchema,
  /** 1 for the check armed by the upload itself, incrementing from there. */
  attempt: z.number().int().positive(),
});

/**
 * Cleanup behind a tombstone. The row is already marked `deleting` by the time
 * this is enqueued, so the message carries no state of its own: everything the
 * cleanup needs is on the row, and the row is what proves the cleanup is still
 * outstanding. See ADR-013.
 */
const deleteMessage = z.object({
  kind: z.literal("delete"),
  tenantId: tenantIdSchema,
  sourceId: sourceIdSchema,
});

/**
 * `kind` did not exist when the first messages were enqueued, so a body without
 * one is an upload from the older producer. Defaulting it keeps anything
 * already sitting in a queue working instead of being discarded as malformed.
 */
const ingestMessage = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null && !("kind" in raw) ? { ...raw, kind: "index" } : raw,
  z.discriminatedUnion("kind", [indexMessage, checkMessage, deleteMessage]),
);

export type IngestMessage = z.infer<typeof ingestMessage>;
type IndexMessage = z.infer<typeof indexMessage>;
type CheckMessage = z.infer<typeof checkMessage>;
type DeleteMessage = z.infer<typeof deleteMessage>;

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
  readonly storage: Pick<R2Bucket, "get" | "delete">;
  readonly convert: (filename: string, blob: Blob) => Promise<string>;
  readonly findSource: (tenantId: TenantId, sourceId: SourceId) => Promise<SourceRow | undefined>;
  readonly setStatus: (
    tenantId: TenantId,
    sourceId: SourceId,
    update: SourceStatusUpdate,
  ) => Promise<void>;
  /** Enqueues a delayed `check` for a row that is still indexing. */
  readonly scheduleCheck: (
    tenantId: TenantId,
    sourceId: SourceId,
    attempt: number,
  ) => Promise<void>;
  /** Reaps the tombstone once the index item and the R2 object are gone. */
  readonly hardDelete: (tenantId: TenantId, sourceId: SourceId) => Promise<void>;
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

/** How long the delayed checks cover before a row is called failed. */
const INDEX_TIMEOUT_MINUTES = Math.round((MAX_INDEX_CHECKS * INDEX_CHECK_DELAY_SECONDS) / 60);

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

  const message = parsed.data;
  switch (message.kind) {
    case "index":
      return handleIndex(message, deps);
    case "check":
      return handleCheck(message, deps);
    case "delete":
      return handleDelete(message, deps);
    default: {
      const never: never = message;
      throw new Error(`Unhandled ingest message ${JSON.stringify(never)}`);
    }
  }
}

/** Upload the stored object into the index. */
async function handleIndex(message: IndexMessage, deps: IngestDeps): Promise<boolean> {
  const { tenantId, sourceId } = message;

  const row = await deps.findSource(tenantId, sourceId);
  if (!row) {
    console.error("Ingest message for a source that no longer exists", sourceId);
    return true; // Deleted while queued.
  }
  if (row.status === "deleting") {
    // Tombstoned while this was queued. The delete message owns the row now,
    // and indexing a file on its way out would race that cleanup.
    return true;
  }
  if (row.status === "ready") {
    return true; // Already indexed by an earlier delivery.
  }
  // A duplicate delivery of a row already handed to AI Search must not send the
  // bytes again. Asking where that item got to is both cheaper and the same
  // question the check messages ask.
  if (row.status === "indexing" && row.aiSearchItemId) {
    return settle(tenantId, sourceId, row.aiSearchItemId, 1, deps);
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
  if (item.status !== "completed") {
    // Indexing outlived the poll window, which is not a failure: the item keeps
    // indexing without us. Record the id we will need to ask about it, then arm
    // the first check.
    await deps.setStatus(tenantId, sourceId, {
      status: "indexing",
      aiSearchItemId: item.itemId,
      chunkCount: item.chunkCount,
      errorCode: null,
      errorMessage: null,
    });
    await deps.scheduleCheck(tenantId, sourceId, 1);
    return true;
  }

  await deps.setStatus(tenantId, sourceId, {
    status: "ready",
    aiSearchItemId: item.itemId,
    chunkCount: item.chunkCount,
    errorCode: null,
    errorMessage: null,
  });
  return true;
}

/** Ask AI Search whether an item that was still indexing has settled. */
async function handleCheck(message: CheckMessage, deps: IngestDeps): Promise<boolean> {
  const { tenantId, sourceId, attempt } = message;

  const row = await deps.findSource(tenantId, sourceId);
  if (!row) {
    return true; // Deleted while the check was waiting.
  }
  if (row.status === "ready" || row.status === "error") {
    return true; // Settled by another delivery.
  }
  if (row.status === "deleting") {
    return true; // Tombstoned while the check was waiting.
  }
  if (!row.aiSearchItemId) {
    // The row went backwards, which means an index message is in flight and
    // owns it. Dropping this check avoids two messages racing on one row.
    console.error("Check for a source with no index item", sourceId);
    return true;
  }

  return settle(tenantId, sourceId, row.aiSearchItemId, attempt, deps);
}

/**
 * Cleanup behind a tombstone: index item, then R2 object, then the row.
 *
 * The row is reaped last because it is the only record that cleanup is still
 * outstanding. Deleting it first would leave an index item and an object with
 * nothing left to find them, which is the failure mode the tombstone exists to
 * avoid (ADR-013).
 */
async function handleDelete(message: DeleteMessage, deps: IngestDeps): Promise<boolean> {
  const { tenantId, sourceId } = message;

  const row = await deps.findSource(tenantId, sourceId);
  if (!row) {
    return true; // Cleanup finished on an earlier delivery.
  }
  if (row.status !== "deleting") {
    // The tombstone is what authorises destruction. A delete message for a live
    // row means something enqueued out of band, and acting on it would remove a
    // source nobody asked to remove.
    console.error("Delete message for a source that is not marked deleting", sourceId);
    return true;
  }

  if (row.aiSearchItemId) {
    const removed = await deps.indexer.remove(tenantId, row.aiSearchItemId);
    // An item the index no longer holds is the state this is trying to reach.
    // An outage says nothing about the item, so that one goes back on the queue.
    if (!removed.ok && removed.error.kind === "unavailable") {
      return false;
    }
  }

  await deps.storage.delete(row.r2Key);
  await deps.hardDelete(tenantId, sourceId);
  return true;
}

/**
 * The shared tail of both handlers: read the item, write a terminal status, or
 * arm the next check.
 */
async function settle(
  tenantId: TenantId,
  sourceId: SourceId,
  itemId: string,
  attempt: number,
  deps: IngestDeps,
): Promise<boolean> {
  const checked = await deps.indexer.status(tenantId, itemId);

  if (!checked.ok) {
    const failure = checked.error;
    // An outage says nothing about this file, so it must not consume the row.
    // Re-arming rather than retrying the message keeps one retry budget and one
    // cap, and keeps an AI Search outage out of the dead letter queue.
    if (failure.kind === "unavailable") {
      return rearm(tenantId, sourceId, attempt, deps);
    }
    await deps.setStatus(tenantId, sourceId, {
      status: "error",
      errorCode: failure.reason,
      errorMessage: failure.message,
    });
    return true;
  }

  const item = checked.value;
  if (item.status !== "completed") {
    return rearm(tenantId, sourceId, attempt, deps);
  }

  await deps.setStatus(tenantId, sourceId, {
    status: "ready",
    aiSearchItemId: item.itemId,
    chunkCount: item.chunkCount,
    errorCode: null,
    errorMessage: null,
  });
  return true;
}

/**
 * Schedule the next check, or give up. Giving up is a claim about our patience
 * rather than about the file, so the message says the index may still finish.
 */
async function rearm(
  tenantId: TenantId,
  sourceId: SourceId,
  attempt: number,
  deps: IngestDeps,
): Promise<boolean> {
  if (attempt >= MAX_INDEX_CHECKS) {
    await deps.setStatus(tenantId, sourceId, {
      status: "error",
      errorCode: "index_timeout",
      errorMessage: `Still indexing after ${INDEX_TIMEOUT_MINUTES} minutes. It may finish on its own; upload the file again if it does not.`,
    });
    return true;
  }

  await deps.scheduleCheck(tenantId, sourceId, attempt + 1);
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
    scheduleCheck: async (tenantId, sourceId, attempt) => {
      await env.INGEST.send(
        { kind: "check", tenantId, sourceId, attempt },
        { delaySeconds: INDEX_CHECK_DELAY_SECONDS },
      );
    },
    hardDelete: async (tenantId, sourceId) => {
      await withDb((db) => withTenant(db, tenantId, (tx) => deleteSource(tx, tenantId, sourceId)));
    },
  };
}

/**
 * A message that has exhausted the consumer's retries and landed in the dead
 * letter queue. Without a consumer of its own the message dies silently and the
 * row sits in `uploaded` or `indexing` forever, which the dashboard renders as a
 * file that is permanently about to be ready.
 *
 * The only job here is to write a terminal status. Nothing is retried: the
 * message already had three attempts on the main queue.
 */
export async function deadLetterOne(raw: unknown, deps: IngestDeps): Promise<boolean> {
  const parsed = ingestMessage.safeParse(raw);
  if (!parsed.success) {
    console.error("Unparseable message in the dead letter queue", raw);
    return true;
  }

  const { tenantId, sourceId } = parsed.data;
  const row = await deps.findSource(tenantId, sourceId);
  if (!row) {
    return true; // Deleted, or its cleanup finished, while this was failing.
  }
  if (row.status === "ready" || row.status === "error") {
    return true; // A delivery that did succeed got there first.
  }
  if (row.status === "deleting") {
    // The user deleted this source and the cleanup behind it ran out of
    // attempts. Writing `error` here would resurrect a deleted file in the
    // dashboard, so the tombstone stays for the step 8 sweep instead.
    console.error("Cleanup exhausted its retries, leaving the tombstone", sourceId);
    return true;
  }

  await deps.setStatus(tenantId, sourceId, {
    status: "error",
    errorCode: "dlq",
    errorMessage: "Indexing failed repeatedly and was given up on. Upload the file again.",
  });
  return true;
}

/** Must match the queue names in `wrangler.jsonc`. */
const INGEST_QUEUE = "cf-chat-ingest";
const INGEST_DLQ = "cf-chat-ingest-dlq";

/**
 * The queue consumer, attached to the default export in `src/server.ts` per
 * ADR-010. One Worker consumes both the `ingest` queue and its dead letter
 * queue, so the batch's own queue name is what separates them.
 */
export async function handleIngestBatch(batch: MessageBatch<unknown>): Promise<void> {
  // Deliberately not a defaulted second parameter: the runtime calls
  // queue(batch, env, ctx), so a defaulted `deps` would be silently replaced by
  // the env object at runtime while still typechecking.
  const deps = liveDeps();

  switch (batch.queue) {
    case INGEST_DLQ:
      return settleBatch(batch, (raw) => deadLetterOne(raw, deps));
    case INGEST_QUEUE:
      return ingestBatch(batch, deps);
    default:
      // Acked rather than thrown: a throw retries a batch that nobody is going
      // to handle any better on the second attempt.
      console.error("Batch from an unknown queue", batch.queue);
      batch.ackAll();
      return;
  }
}

export async function ingestBatch(batch: MessageBatch<unknown>, deps: IngestDeps): Promise<void> {
  return settleBatch(batch, (raw) => ingestOne(raw, deps));
}

export async function deadLetterBatch(
  batch: MessageBatch<unknown>,
  deps: IngestDeps,
): Promise<void> {
  return settleBatch(batch, (raw) => deadLetterOne(raw, deps));
}

/**
 * Messages are acked individually so a single poison file cannot drag a whole
 * batch back onto the queue, and are processed concurrently because each one
 * spends most of its time waiting on AI Search rather than burning CPU.
 */
async function settleBatch(
  batch: MessageBatch<unknown>,
  handle: (raw: unknown) => Promise<boolean>,
): Promise<void> {
  // The catch sits inside the map so the message reference survives a throw.
  // Both handlers are written not to throw, so reaching it means a bug or an
  // infrastructure failure, both of which deserve a retry rather than a drop.
  const outcomes = await Promise.all(
    batch.messages.map(async (message) => {
      try {
        return { message, done: await handle(message.body) };
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
