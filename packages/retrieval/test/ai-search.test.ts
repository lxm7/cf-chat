import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import {
  AISearchIndexer,
  type AiSearchInstanceLike,
  type AiSearchNamespaceLike,
  instanceId,
} from "../src/ai-search.ts";

const tenantId = newTenantId();

interface FakeOptions {
  readonly item?: unknown;
  readonly createThrows?: boolean;
  readonly uploadThrows?: Error;
  readonly info?: unknown;
  readonly infoThrows?: Error;
  /** What `items.list` returns, for the post-timeout lookup by key. */
  readonly listResult?: unknown;
  readonly listThrows?: Error;
}

/** Records what the binding was asked to do, so the calls can be asserted on. */
function fakeNamespace(options: FakeOptions = {}) {
  const created: string[] = [];
  const gotten: string[] = [];
  const uploads: Array<{ name: string; instance: string }> = [];
  const listed: Array<{ key: string | undefined; instance: string }> = [];
  const inspected: Array<{ itemId: string; instance: string }> = [];
  const deleted: string[] = [];

  const instance = (id: string): AiSearchInstanceLike => ({
    items: {
      uploadAndPoll: async (name) => {
        if (options.uploadThrows) throw options.uploadThrows;
        uploads.push({ name, instance: id });
        return options.item ?? { id: "item-1", key: name, status: "completed", chunks_count: 3 };
      },
      list: async (params) => {
        listed.push({ key: params?.key, instance: id });
        if (options.listThrows) throw options.listThrows;
        return options.listResult ?? { result: [] };
      },
      get: (itemId) => {
        inspected.push({ itemId, instance: id });
        return {
          info: async () => {
            if (options.infoThrows) throw options.infoThrows;
            return (
              options.info ?? {
                id: itemId,
                key: "faq.md",
                status: "completed",
                chunks_count: 3,
              }
            );
          },
        };
      },
      delete: async (itemId) => {
        deleted.push(itemId);
      },
    },
  });

  const namespace: AiSearchNamespaceLike = {
    create: async (config) => {
      if (options.createThrows) throw new Error("already exists");
      created.push(config.id);
      return instance(config.id);
    },
    get: (name) => {
      gotten.push(name);
      return instance(name);
    },
  };

  return { namespace, created, gotten, uploads, listed, inspected, deleted };
}

describe("instanceId", () => {
  it("fits the 1-32 character id limit that a raw uuid breaks", () => {
    const id = instanceId(tenantId);
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/);
  });

  it("is deterministic, so a retry addresses the same instance", () => {
    expect(instanceId(tenantId)).toBe(instanceId(tenantId));
  });
});

describe("AISearchIndexer", () => {
  it("creates the instance with hybrid indexing and reranking, both off by default", async () => {
    const fake = fakeNamespace();
    let captured: unknown;
    const namespace: AiSearchNamespaceLike = {
      create: async (config) => {
        captured = config;
        return fake.namespace.create(config);
      },
      get: fake.namespace.get,
    };

    await new AISearchIndexer(namespace).upload(tenantId, { name: "faq.md", content: "hi" });

    expect(captured).toMatchObject({
      index_method: { vector: true, keyword: true },
      reranking: true,
    });
  });

  it("falls back to get when the instance already exists", async () => {
    const fake = fakeNamespace({ createThrows: true });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result.ok).toBe(true);
    expect(fake.created).toEqual([]);
    expect(fake.gotten).toEqual([instanceId(tenantId)]);
  });

  it("returns the indexed item on success", async () => {
    const fake = fakeNamespace();

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toEqual({
      ok: true,
      value: { itemId: "item-1", key: "faq.md", status: "completed", chunkCount: 3 },
    });
  });

  it("classifies an oversized file as rejected, not as an outage", async () => {
    const fake = fakeNamespace({
      item: { id: "i", key: "big.pdf", status: "error", error: "over_size" },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "big.pdf",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "rejected", reason: "too_large" } });
  });

  it("treats a thrown binding error as an outage worth retrying", async () => {
    const fake = fakeNamespace({ uploadThrows: new Error("connection reset") });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });

  it.each([
    ["unable_to_convert_to_markdown", "unsupported_type"],
    ["invalid_pdf", "unsupported_type"],
    ["file_is_corrupt", "unreadable"],
    ["file_is_password_locked", "unreadable"],
    ["file_content_empty", "empty"],
    ["markdown_conversion_empty", "empty"],
    ["markdown_too_large", "too_large"],
    ["chunk_too_large_for_storage", "too_large"],
  ])("treats the documented code %s as a terminal %s", async (code, reason) => {
    // These all fail identically on every retry. Read as an outage, each one
    // burns three attempts and then dead-letters a file we could have rejected
    // immediately with a message the user can act on.
    const fake = fakeNamespace({ item: { id: "i", key: "f", status: "error", error: code } });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "f",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "rejected", reason } });
  });

  it("treats the documented timeout_error code as retryable, not terminal", async () => {
    const fake = fakeNamespace({
      item: { id: "i", key: "f", status: "error", error: "timeout_error" },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "f",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("recovers a timed-out upload by finding the item it created", async () => {
    // `uploadAndPoll` gives up by throwing, but the item is still indexing.
    // Reported as a failure, the retry re-sends the bytes for work already in
    // flight, three times, then dead-letters a file that was fine.
    const fake = fakeNamespace({
      uploadThrows: new Error("uploadAndPoll timed out after 30000ms"),
      listResult: {
        result: [{ id: "item-9", key: "faq.md", status: "running", chunks_count: null }],
      },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    // Pending, not failed: the caller records the id and arms a check.
    expect(result).toEqual({
      ok: true,
      value: { itemId: "item-9", key: "faq.md", status: "running", chunkCount: null },
    });
    expect(fake.listed.at(-1)?.key).toBe("faq.md");
  });

  it("reports the timeout when the item cannot be found afterwards", async () => {
    const fake = fakeNamespace({
      uploadThrows: new Error("uploadAndPoll timed out after 30000ms"),
      listResult: { result: [] },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("does not reconcile against an item with a different key", async () => {
    // A widened match on the server side would otherwise attach this row to
    // some other tenant's item and report it ready.
    const fake = fakeNamespace({
      uploadThrows: new Error("uploadAndPoll timed out after 30000ms"),
      listResult: { result: [{ id: "other", key: "somebody-else.md", status: "completed" }] },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("keeps the timeout when the lookup itself fails", async () => {
    const fake = fakeNamespace({
      uploadThrows: new Error("uploadAndPoll timed out after 30000ms"),
      listThrows: new Error("list is down too"),
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("does not look anything up when the failure is not a timeout", async () => {
    const fake = fakeNamespace({ uploadThrows: new Error("connection reset") });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(fake.listed).toEqual([]);
  });

  it("classifies a timeout by error name as well as message", async () => {
    const named = new Error("gave up waiting");
    named.name = "TimeoutError";
    const fake = fakeNamespace({ uploadThrows: named });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("keeps the original message on every classification, so nothing is lost", async () => {
    const fake = fakeNamespace({ uploadThrows: new Error("connection reset by peer") });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("connection reset by peer");
    }
  });

  it("refuses to trust a response in an unexpected shape", async () => {
    const fake = fakeNamespace({ item: { unexpected: true } });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });

  it("folds `outdated` into queued rather than inventing a state", async () => {
    const fake = fakeNamespace({
      item: { id: "i", key: "faq.md", status: "outdated", chunks_count: null },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "faq.md",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: true, value: { status: "queued", chunkCount: null } });
  });

  it("reports an item that has finished indexing since the upload gave up", async () => {
    const fake = fakeNamespace({
      info: { id: "item-9", key: "faq.md", status: "completed", chunks_count: 7 },
    });

    const result = await new AISearchIndexer(fake.namespace).status(tenantId, "item-9");

    expect(result).toEqual({
      ok: true,
      value: { itemId: "item-9", key: "faq.md", status: "completed", chunkCount: 7 },
    });
    // Through get, not create: a status read has no business provisioning.
    expect(fake.created).toEqual([]);
    expect(fake.inspected).toEqual([{ itemId: "item-9", instance: instanceId(tenantId) }]);
  });

  it("reports an item that is still indexing as unfinished rather than failed", async () => {
    const fake = fakeNamespace({
      info: { id: "item-9", key: "faq.md", status: "running", chunks_count: null },
    });

    const result = await new AISearchIndexer(fake.namespace).status(tenantId, "item-9");

    expect(result).toMatchObject({ ok: true, value: { status: "running", chunkCount: null } });
  });

  it("turns an item that failed indexing into a rejection", async () => {
    const fake = fakeNamespace({
      info: { id: "item-9", key: "faq.md", status: "error", error: "unsupported content type" },
    });

    const result = await new AISearchIndexer(fake.namespace).status(tenantId, "item-9");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "rejected", reason: "unsupported_type" },
    });
  });

  it("treats a vanished item as terminal, so a check cannot wait on it forever", async () => {
    const notFound = new Error("item_not_found");
    notFound.name = "AiSearchNotFoundError";
    const fake = fakeNamespace({ infoThrows: notFound });

    const result = await new AISearchIndexer(fake.namespace).status(tenantId, "item-9");

    expect(result).toMatchObject({ ok: false, error: { kind: "rejected", reason: "not_found" } });
  });

  it("treats any other thrown error on a status read as an outage", async () => {
    const fake = fakeNamespace({ infoThrows: new Error("connection reset") });

    const result = await new AISearchIndexer(fake.namespace).status(tenantId, "item-9");

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  });

  it("deletes through the tenant's own instance", async () => {
    const fake = fakeNamespace();

    const result = await new AISearchIndexer(fake.namespace).remove(tenantId, "item-9");

    expect(result.ok).toBe(true);
    expect(fake.deleted).toEqual(["item-9"]);
    expect(fake.gotten).toEqual([instanceId(tenantId)]);
  });
});
