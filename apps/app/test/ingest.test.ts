import { env } from "cloudflare:test";
import type { SourceStatusUpdate } from "@cf-chat/db";
import type { SourceRow } from "@cf-chat/db/schema";
import { FixtureIndexer } from "@cf-chat/retrieval";
import {
  err,
  MAX_INDEX_CHECKS,
  newSourceId,
  newTenantId,
  ok,
  type SourceId,
  type TenantId,
} from "@cf-chat/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deadLetterOne,
  type IngestDeps,
  ingestOne,
  itemName,
  needsConversion,
} from "../src/ingest.ts";

const tenantId = newTenantId();

/**
 * Stands in for the two services with no local emulation. R2 is not stubbed:
 * the pool emulates it, so the consumer reads a real object.
 */
function harness(overrides?: {
  row?: Partial<SourceRow>;
  indexer?: FixtureIndexer;
  convert?: IngestDeps["convert"];
}) {
  const sourceId = newSourceId();
  const indexer = overrides?.indexer ?? new FixtureIndexer();
  const updates: SourceStatusUpdate[] = [];
  const checks: Array<{ sourceId: SourceId; attempt: number }> = [];
  const reaped: SourceId[] = [];

  const row: SourceRow = {
    id: sourceId,
    tenantId,
    filename: "handbook.md",
    contentType: "text/markdown",
    sizeBytes: 24,
    r2Key: `${tenantId}/sources/${sourceId}/handbook.md`,
    aiSearchItemId: null,
    chunkCount: null,
    status: "uploaded",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides?.row,
  };

  const deps: IngestDeps = {
    indexer,
    storage: env.KNOWLEDGE,
    convert: overrides?.convert ?? (async () => "# Converted\n\nBody text."),
    // A reaped row is gone, so later deliveries see what the consumer would.
    findSource: async (_tenant, id) => (id === sourceId && !reaped.includes(id) ? row : undefined),
    // Applied to the row, not just recorded: a check reads back what the
    // upload wrote, so a spy that forgot the item id would test nothing.
    setStatus: async (_tenant, _id, update) => {
      updates.push(update);
      row.status = update.status;
      if (update.aiSearchItemId !== undefined) row.aiSearchItemId = update.aiSearchItemId;
      if (update.chunkCount !== undefined) row.chunkCount = update.chunkCount;
    },
    scheduleCheck: async (_tenant, id, attempt) => {
      checks.push({ sourceId: id, attempt });
    },
    hardDelete: async (_tenant, id) => {
      reaped.push(id);
    },
  };

  return { sourceId, row, deps, indexer, updates, checks, reaped };
}

function message(tenantId: TenantId, sourceId: SourceId): unknown {
  return { kind: "index", tenantId, sourceId };
}

function check(tenantId: TenantId, sourceId: SourceId, attempt: number): unknown {
  return { kind: "check", tenantId, sourceId, attempt };
}

function remove(tenantId: TenantId, sourceId: SourceId): unknown {
  return { kind: "delete", tenantId, sourceId };
}

describe("ingest", () => {
  beforeEach(async () => {
    const listed = await env.KNOWLEDGE.list();
    await Promise.all(listed.objects.map((object) => env.KNOWLEDGE.delete(object.key)));
  });

  it("indexes an uploaded file and marks the row ready", async () => {
    const { sourceId, row, deps, indexer, updates } = harness();
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.map((u) => u.status)).toEqual(["indexing", "ready"]);
    expect([...indexer.uploaded.values()][0]?.name).toBe(itemName(sourceId, "handbook.md"));
  });

  it("names the item by source id so two files can share a filename", async () => {
    const first = newSourceId();
    const second = newSourceId();
    expect(itemName(first, "faq.md")).not.toBe(itemName(second, "faq.md"));
  });

  it("converts on size alone, since AI Search converts what it accepts anyway", () => {
    expect(needsConversion("text/markdown", 5 * 1024 * 1024)).toBe(true);
    expect(needsConversion("application/pdf", 5 * 1024 * 1024)).toBe(true);
    // A PDF under the cap goes up as bytes. Converting it first bought nothing
    // and produced markdown under a `.pdf` key, which AI Search rejected.
    expect(needsConversion("application/pdf", 1024)).toBe(false);
    expect(needsConversion("text/markdown", 1024)).toBe(false);
  });

  it("sends a small PDF as bytes under its own name", async () => {
    const { sourceId, row, deps, indexer, updates } = harness({
      row: { filename: "cv.pdf", contentType: "application/pdf", sizeBytes: 1024 },
    });
    await env.KNOWLEDGE.put(row.r2Key, "%PDF-1.4 body");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "ready" });
    expect([...indexer.uploaded.values()][0]?.name).toBe(itemName(sourceId, "cv.pdf"));
  });

  it("rejects a file whose markdown is still over the indexing cap", async () => {
    // The inbound cap is 10MB and AI Search's is 4MB. Conversion is what
    // bridges them, and nothing guaranteed it succeeded: an oversized result
    // used to be uploaded anyway and come back as an opaque `over_size`.
    const { sourceId, row, deps, indexer, updates } = harness({
      row: { filename: "manual.pdf", contentType: "application/pdf", sizeBytes: 9 * 1024 * 1024 },
      convert: async () => "x".repeat(5 * 1024 * 1024),
    });
    await env.KNOWLEDGE.put(row.r2Key, "%PDF-1.4 body");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);

    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "too_large" });
    // Named as a conversion result, not as an arbitrary rejection.
    expect(updates.at(-1)?.errorMessage).toContain("Converted to");
    // And never sent: the point is to not spend the upload at all.
    expect(indexer.uploaded.size).toBe(0);
  });

  it("accepts a large file whose markdown comes in under the cap", async () => {
    const { sourceId, row, deps, indexer, updates } = harness({
      row: { filename: "manual.pdf", contentType: "application/pdf", sizeBytes: 9 * 1024 * 1024 },
      convert: async () => "# Manual\n\nShort text.",
    });
    await env.KNOWLEDGE.put(row.r2Key, "%PDF-1.4 body");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "ready" });
    expect(indexer.uploaded.size).toBe(1);
  });

  it("names a converted item .md so the key matches what we actually sent", async () => {
    // AI Search dispatches its converter on the key's extension. Markdown under
    // a `.pdf` key comes back `unable_to_convert_to_markdown`.
    const { sourceId, row, deps, indexer } = harness({
      row: {
        filename: "book.pdf",
        contentType: "application/pdf",
        sizeBytes: 5 * 1024 * 1024,
      },
    });
    await env.KNOWLEDGE.put(row.r2Key, "%PDF-1.4 body");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);

    const uploaded = [...indexer.uploaded.values()][0];
    expect(uploaded?.name).toBe(itemName(sourceId, "book.md"));
    expect(uploaded?.name.endsWith(".pdf")).toBe(false);
    expect(typeof uploaded?.content).toBe("string");
  });

  it("retries a transient index failure rather than burning the row", async () => {
    const indexer = new FixtureIndexer();
    indexer.failOnce({ kind: "unavailable", message: "AI Search is down" });
    const { sourceId, row, deps, updates } = harness({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(false);
    expect(updates.at(-1)).toMatchObject({ status: "uploaded", errorCode: "retrying" });
  });

  it("acks a rejected file, because a retry would fail identically", async () => {
    const indexer = new FixtureIndexer();
    indexer.failOnce({ kind: "rejected", reason: "too_large", message: "over_size" });
    const { sourceId, row, deps, updates } = harness({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "x");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "too_large" });
  });

  it("records an error when the object has gone from storage", async () => {
    const { sourceId, deps, updates } = harness();

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "missing_object" });
  });

  it("records an error when conversion produces nothing", async () => {
    const { sourceId, row, deps, updates } = harness({
      // Over the cap, which is the only thing that puts us on the conversion path.
      row: { contentType: "application/pdf", sizeBytes: 5 * 1024 * 1024 },
      convert: async () => {
        throw new Error("Markdown conversion produced no text");
      },
    });
    await env.KNOWLEDGE.put(row.r2Key, "%PDF-1.4");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "conversion_failed" });
  });

  it("does not re-index a source that is already ready", async () => {
    const { sourceId, deps, indexer, updates } = harness({ row: { status: "ready" } });

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates).toEqual([]);
    expect(indexer.uploaded.size).toBe(0);
  });

  it("discards a malformed message instead of retrying it forever", async () => {
    const { deps, updates } = harness();

    expect(await ingestOne({ nope: true }, deps)).toBe(true);
    expect(updates).toEqual([]);
  });

  it("acks a message whose source has been deleted", async () => {
    const { deps } = harness();

    const done = await ingestOne(message(tenantId, newSourceId()), deps);

    expect(done).toBe(true);
  });

  it("treats a message with no kind as an upload, so nothing already queued is lost", async () => {
    const { sourceId, row, deps, updates } = harness();
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne({ tenantId, sourceId }, deps);

    expect(done).toBe(true);
    expect(updates.map((u) => u.status)).toEqual(["indexing", "ready"]);
  });
});

describe("ingest reconciliation", () => {
  beforeEach(async () => {
    const listed = await env.KNOWLEDGE.list();
    await Promise.all(listed.objects.map((object) => env.KNOWLEDGE.delete(object.key)));
  });

  /** A row left mid-flight by an upload that outlived the poll window. */
  function indexing(overrides?: { indexer?: FixtureIndexer }) {
    return harness({
      ...overrides,
      row: { status: "indexing", aiSearchItemId: "item-1" },
    });
  }

  it("arms a check when indexing outlives the poll window", async () => {
    const indexer = new FixtureIndexer();
    indexer.uploadsSettleAs("running");
    const { sourceId, row, deps, updates, checks } = harness({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      status: "indexing",
      aiSearchItemId: expect.any(String),
    });
    expect(checks).toEqual([{ sourceId, attempt: 1 }]);
  });

  it("marks the row ready when the check finds the item completed", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(ok({ itemId: "item-1", key: "k", status: "completed", chunkCount: 6 }));
    const { sourceId, deps, updates, checks } = indexing({ indexer });

    const done = await ingestOne(check(tenantId, sourceId, 1), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "ready", chunkCount: 6, errorCode: null });
    expect(checks).toEqual([]);
    expect(indexer.checked).toEqual(["item-1"]);
  });

  it("re-arms with the next attempt while the item is still indexing", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(ok({ itemId: "item-1", key: "k", status: "running", chunkCount: null }));
    const { sourceId, deps, updates, checks } = indexing({ indexer });

    const done = await ingestOne(check(tenantId, sourceId, 3), deps);

    expect(done).toBe(true);
    expect(updates).toEqual([]); // Nothing to say yet, so the row is left alone.
    expect(checks).toEqual([{ sourceId, attempt: 4 }]);
  });

  it("gives up at the cap and says the index may still finish", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(ok({ itemId: "item-1", key: "k", status: "running", chunkCount: null }));
    const { sourceId, deps, updates, checks } = indexing({ indexer });

    const done = await ingestOne(check(tenantId, sourceId, MAX_INDEX_CHECKS), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "index_timeout" });
    expect(updates.at(-1)?.errorMessage).toContain("may finish on its own");
    expect(checks).toEqual([]);
  });

  it("stops checking an item the index no longer has", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(
      err({ kind: "rejected", reason: "not_found", message: "item_not_found" }),
    );
    const { sourceId, deps, updates, checks } = indexing({ indexer });

    const done = await ingestOne(check(tenantId, sourceId, 1), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "not_found" });
    expect(checks).toEqual([]);
  });

  it("re-arms rather than retrying the message when AI Search is down", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(err({ kind: "unavailable", message: "AI Search is down" }));
    const { sourceId, deps, updates, checks } = indexing({ indexer });

    const done = await ingestOne(check(tenantId, sourceId, 1), deps);

    // Acked, not retried: an outage must not burn the queue's retry budget or
    // land a healthy file in the dead letter queue.
    expect(done).toBe(true);
    expect(updates).toEqual([]);
    expect(checks).toEqual([{ sourceId, attempt: 2 }]);
  });

  it("acks a check for a row that has already settled", async () => {
    const { sourceId, deps, indexer, updates, checks } = harness({
      row: { status: "ready", aiSearchItemId: "item-1" },
    });

    const done = await ingestOne(check(tenantId, sourceId, 1), deps);

    expect(done).toBe(true);
    expect(updates).toEqual([]);
    expect(checks).toEqual([]);
    expect(indexer.checked).toEqual([]);
  });

  it("acks a check whose source has been deleted", async () => {
    const { deps, checks } = indexing();

    expect(await ingestOne(check(tenantId, newSourceId(), 1), deps)).toBe(true);
    expect(checks).toEqual([]);
  });

  it("checks instead of re-uploading when an index message is delivered twice", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns(ok({ itemId: "item-1", key: "k", status: "completed", chunkCount: 2 }));
    const { sourceId, row, deps, updates } = indexing({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(indexer.uploaded.size).toBe(0); // The bytes are not sent a second time.
    expect(updates.at(-1)).toMatchObject({ status: "ready", chunkCount: 2 });
  });
});

/**
 * Cleanup behind a tombstone (ADR-013). The row is already `deleting` by the
 * time any of this runs: the delete was decided in Neon and these tests are
 * about whether the cleanup behind it is safe to retry.
 */
describe("ingest deletion", () => {
  function tombstoned(overrides?: { indexer?: FixtureIndexer }) {
    return harness({
      ...overrides,
      row: { status: "deleting", aiSearchItemId: "item-1", chunkCount: 3 },
    });
  }

  it("removes the index item, the object and then the row", async () => {
    const { sourceId, row, deps, indexer, reaped } = tombstoned();
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(remove(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(indexer.removed).toEqual(["item-1"]);
    expect(await env.KNOWLEDGE.get(row.r2Key)).toBeNull();
    expect(reaped).toEqual([sourceId]);
  });

  it("retries without touching the row when the index is unavailable", async () => {
    const indexer = new FixtureIndexer({ kind: "unavailable", message: "AI Search is down" });
    const { sourceId, row, deps, reaped } = tombstoned({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(remove(tenantId, sourceId), deps);

    // The object and the row survive, so the whole cleanup stays retryable.
    expect(done).toBe(false);
    expect(await env.KNOWLEDGE.get(row.r2Key)).not.toBeNull();
    expect(reaped).toEqual([]);
  });

  it("finishes the cleanup when the index no longer has the item", async () => {
    const indexer = new FixtureIndexer({
      kind: "rejected",
      reason: "not_found",
      message: "item_not_found",
    });
    const { sourceId, row, deps, reaped } = tombstoned({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(remove(tenantId, sourceId), deps);

    // An item the index has already lost is the state the delete wanted.
    expect(done).toBe(true);
    expect(await env.KNOWLEDGE.get(row.r2Key)).toBeNull();
    expect(reaped).toEqual([sourceId]);
  });

  it("cleans up a row that was never indexed", async () => {
    const { sourceId, row, deps, indexer, reaped } = harness({
      row: { status: "deleting", aiSearchItemId: null },
    });
    await env.KNOWLEDGE.put(row.r2Key, "Never made it to the index.");

    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(true);
    expect(indexer.removed).toEqual([]);
    expect(reaped).toEqual([sourceId]);
  });

  it("refuses to destroy a row that is not marked deleting", async () => {
    const { sourceId, row, deps, indexer, reaped } = harness({
      row: { status: "ready", aiSearchItemId: "item-1" },
    });
    await env.KNOWLEDGE.put(row.r2Key, "Still a live source.");

    // Acked rather than retried: no number of redeliveries makes this message
    // legitimate, and the tombstone is what authorises destruction.
    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(true);
    expect(indexer.removed).toEqual([]);
    expect(await env.KNOWLEDGE.get(row.r2Key)).not.toBeNull();
    expect(reaped).toEqual([]);
  });

  it("acks a delete whose cleanup already finished", async () => {
    const { deps, reaped } = tombstoned();

    expect(await ingestOne(remove(tenantId, newSourceId()), deps)).toBe(true);
    expect(reaped).toEqual([]);
  });

  it("does not index a source tombstoned while the upload was queued", async () => {
    const { sourceId, row, deps, indexer, updates } = harness({
      row: { status: "deleting" },
    });
    await env.KNOWLEDGE.put(row.r2Key, "Deleted before the consumer got to it.");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(indexer.uploaded.size).toBe(0);
    expect(updates).toEqual([]);
  });

  it("stops checking a source tombstoned while the check was waiting", async () => {
    const { sourceId, deps, indexer, checks, updates } = tombstoned();

    expect(await ingestOne(check(tenantId, sourceId, 2), deps)).toBe(true);
    expect(indexer.checked).toEqual([]);
    expect(checks).toEqual([]);
    expect(updates).toEqual([]);
  });
});

/**
 * The dead letter queue's own consumer. Everything here has already spent its
 * three attempts on the main queue, so nothing is retried: the only question is
 * what the row should say once we have given up on it.
 */
describe("index timeouts", () => {
  it("does not re-send bytes for an upload that is still indexing", async () => {
    // A poll timeout means the upload was accepted and indexing is in flight.
    // Retrying would upload the same file again, three times, and then dead
    // letter a file that was very likely fine.
    const indexer = new FixtureIndexer({ kind: "timeout", message: "uploadAndPoll timed out" });
    const { sourceId, row, deps, updates } = harness({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    const done = await ingestOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true); // acked, not retried
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "index_timeout" });
    expect(updates.at(-1)?.errorMessage).toContain("timed out");
  });

  it("re-arms rather than consuming the row when a status check times out", async () => {
    const indexer = new FixtureIndexer();
    indexer.statusReturns({ ok: false, error: { kind: "timeout", message: "status timed out" } });
    const { sourceId, deps, updates, checks } = harness({
      indexer,
      row: { status: "indexing", aiSearchItemId: "item-1" },
    });

    expect(await ingestOne(check(tenantId, sourceId, 1), deps)).toBe(true);

    // A slow read says nothing about the file, so the row must survive it.
    expect(checks.at(-1)).toMatchObject({ attempt: 2 });
    expect(updates.some((u) => u.status === "error")).toBe(false);
  });

  it("still fails a genuine rejection rather than waiting on it", async () => {
    const indexer = new FixtureIndexer({
      kind: "rejected",
      reason: "unsupported_type",
      message: "content type not supported",
    });
    const { sourceId, row, deps, updates } = harness({ indexer });
    await env.KNOWLEDGE.put(row.r2Key, "Refunds take five days.");

    expect(await ingestOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "unsupported_type" });
  });
});

describe("deleting a source that never got an item id", () => {
  it("finds the leaked item by key and removes it", async () => {
    // An upload can create the item and then fail, so the row has no id. Those
    // items used to be unreachable and stayed in the index forever, one per
    // failed upload, counting against the per-instance file limit.
    const indexer = new FixtureIndexer();
    const { sourceId, row, deps } = harness({
      indexer,
      row: { filename: "cv.pdf", contentType: "application/pdf", sizeBytes: 1024 },
    });
    // Stand in for the item AI Search created before the upload reported failure.
    await indexer.upload(tenantId, { name: itemName(sourceId, "cv.pdf"), content: "x" });
    row.status = "deleting";
    row.aiSearchItemId = null;

    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(true);

    expect(indexer.lookedUp).toContain(itemName(sourceId, "cv.pdf"));
    expect(indexer.removed).toHaveLength(1);
  });

  it("looks under the .md key for a source that was converted", async () => {
    const indexer = new FixtureIndexer();
    const { sourceId, row, deps } = harness({
      indexer,
      row: {
        filename: "book.pdf",
        contentType: "application/pdf",
        sizeBytes: 9 * 1024 * 1024,
      },
    });
    row.status = "deleting";
    row.aiSearchItemId = null;

    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(true);

    // The key has to match what the upload would have used, or the lookup
    // silently finds nothing and the item leaks anyway.
    expect(indexer.lookedUp).toContain(itemName(sourceId, "book.md"));
  });

  it("still reaps the row when the index holds nothing under the key", async () => {
    const indexer = new FixtureIndexer();
    const { sourceId, row, deps, reaped } = harness({ indexer });
    row.status = "deleting";
    row.aiSearchItemId = null;

    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(true);
    expect(indexer.removed).toEqual([]);
    expect(reaped).toContain(sourceId);
  });

  it("retries rather than reaping the row when the lookup hits an outage", async () => {
    // Reaping here would strand the item: the row is the only thing that still
    // knows the key it was stored under.
    const indexer = new FixtureIndexer({ kind: "unavailable", message: "AI Search is down" });
    const { sourceId, row, deps, reaped } = harness({ indexer });
    row.status = "deleting";
    row.aiSearchItemId = null;

    expect(await ingestOne(remove(tenantId, sourceId), deps)).toBe(false);
    expect(reaped).toEqual([]);
  });
});

describe("ingest dead letter", () => {
  it("writes a terminal status on a row still waiting to be indexed", async () => {
    const { sourceId, deps, updates } = harness({ row: { status: "uploaded" } });

    const done = await deadLetterOne(message(tenantId, sourceId), deps);

    expect(done).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "dlq" });
  });

  it("writes a terminal status on a row left indexing", async () => {
    const { sourceId, deps, updates } = harness({
      row: { status: "indexing", aiSearchItemId: "item-1" },
    });

    expect(await deadLetterOne(check(tenantId, sourceId, 3), deps)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ status: "error", errorCode: "dlq" });
  });

  it("keeps the last real error instead of replacing it with the generic one", async () => {
    // The retry path writes the real failure to the row on every attempt. This
    // handler used to overwrite it, which is what made a dead-lettered file
    // impossible to diagnose from either the row or the logs.
    const { sourceId, deps, updates } = harness({
      row: { status: "uploaded", errorCode: "retrying", errorMessage: "AI Search returned 503" },
    });

    expect(await deadLetterOne(message(tenantId, sourceId), deps)).toBe(true);

    const last = updates.at(-1);
    expect(last).toMatchObject({ status: "error", errorCode: "dlq" });
    expect(last?.errorMessage).toContain("AI Search returned 503");
    expect(last?.errorMessage).toContain("given up on");
  });

  it("still says something useful when there was no recorded error", async () => {
    const { sourceId, deps, updates } = harness({
      row: { status: "uploaded", errorMessage: null },
    });

    expect(await deadLetterOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates.at(-1)?.errorMessage).toContain("given up on");
    expect(updates.at(-1)?.errorMessage).not.toContain("Last error");
  });

  it("ignores a blank recorded error rather than appending an empty tail", async () => {
    const { sourceId, deps, updates } = harness({
      row: { status: "uploaded", errorMessage: "   " },
    });

    expect(await deadLetterOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates.at(-1)?.errorMessage).not.toContain("Last error");
  });

  it("leaves a row that settled on another delivery alone", async () => {
    const { sourceId, deps, updates } = harness({ row: { status: "ready" } });

    expect(await deadLetterOne(message(tenantId, sourceId), deps)).toBe(true);
    expect(updates).toEqual([]);
  });

  it("does not resurrect a deleted source whose cleanup ran out of attempts", async () => {
    const { sourceId, deps, updates } = harness({ row: { status: "deleting" } });

    // Writing `error` here would put a file the user deleted back in the
    // dashboard. The tombstone stays for the sweep instead.
    expect(await deadLetterOne(remove(tenantId, sourceId), deps)).toBe(true);
    expect(updates).toEqual([]);
  });

  it("acks a message whose row is already gone", async () => {
    const { deps, updates } = harness();

    expect(await deadLetterOne(message(tenantId, newSourceId()), deps)).toBe(true);
    expect(updates).toEqual([]);
  });

  it("acks an unparseable message rather than dropping the batch", async () => {
    const { deps, updates } = harness();

    expect(await deadLetterOne({ nope: true }, deps)).toBe(true);
    expect(updates).toEqual([]);
  });
});
