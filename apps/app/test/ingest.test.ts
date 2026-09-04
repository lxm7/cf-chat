import { env } from "cloudflare:test";
import type { SourceRow } from "@cf-chat/db/schema";
import { FixtureIndexer } from "@cf-chat/retrieval";
import {
  newSourceId,
  newTenantId,
  type SourceId,
  type SourceStatus,
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
  const updates: Array<{ status: SourceStatus; errorCode: string | null | undefined }> = [];

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
    setStatus: async (_tenant, _id, update) => {
      updates.push({ status: update.status, errorCode: update.errorCode });
      row.status = update.status;
    },
  };

  return { sourceId, row, deps, indexer, updates };
}

function message(tenantId: TenantId, sourceId: SourceId): unknown {
  return { tenantId, sourceId };
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
});
