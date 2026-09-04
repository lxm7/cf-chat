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
import { type IngestDeps, ingestOne, itemName, needsConversion } from "../src/ingest.ts";

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
    findSource: async (_tenant, id) => (id === sourceId ? row : undefined),
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
  };

  return { sourceId, row, deps, indexer, updates, checks };
}

function message(tenantId: TenantId, sourceId: SourceId): unknown {
  return { kind: "index", tenantId, sourceId };
}

function check(tenantId: TenantId, sourceId: SourceId, attempt: number): unknown {
  return { kind: "check", tenantId, sourceId, attempt };
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

  it("converts anything over the AI Search cap before uploading", () => {
    expect(needsConversion("text/markdown", 5 * 1024 * 1024)).toBe(true);
    expect(needsConversion("application/pdf", 1024)).toBe(true);
    expect(needsConversion("text/markdown", 1024)).toBe(false);
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
      row: { contentType: "application/pdf" },
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
