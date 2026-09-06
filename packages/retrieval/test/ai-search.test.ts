import { newTenantId } from "@cf-chat/shared";
import { describe, expect, it } from "vitest";
import {
  AISearchIndexer,
  AISearchRetriever,
  type AiSearchInstanceLike,
  type AiSearchNamespaceLike,
  type AiSearchQueryNamespaceLike,
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

  it.each(["timeout_error", "workers_ai_timeout_error"])(
    "treats %s reported *on an item* as terminal, not as work still in flight",
    async (code) => {
      // An item that reports status `error` has a verdict. Re-reading it returns
      // the same answer, so a caller that treats this as retryable re-polls a
      // finished failure until its check budget runs out. That is exactly what
      // happened to a 5MB PDF: it failed instantly and we polled for 10 minutes.
      const fake = fakeNamespace({
        item: { id: "i", key: "f", status: "error", error: code },
      });

      const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
        name: "f",
        content: "hi",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "rejected", reason: "processing_timeout" },
      });
    },
  );

  it("treats an unrecognised code on a failed item as terminal too", async () => {
    const fake = fakeNamespace({
      item: { id: "i", key: "f", status: "error", error: "some_future_error_code" },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "f",
      content: "hi",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "rejected", reason: "processing_failed" },
    });
  });

  it("still treats a thrown timeout as work in flight, not as a verdict", async () => {
    // The mirror of the case above, and the reason the two classifiers are
    // separate: a thrown timeout is our poll giving up, not the item failing.
    const fake = fakeNamespace({
      uploadThrows: new Error("uploadAndPoll timed out after 30000ms"),
      listResult: { result: [{ id: "item-9", key: "f", status: "running", chunks_count: null }] },
    });

    const result = await new AISearchIndexer(fake.namespace).upload(tenantId, {
      name: "f",
      content: "hi",
    });

    expect(result).toMatchObject({ ok: true, value: { status: "running" } });
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

interface FakeSearchOptions {
  readonly response?: unknown;
  readonly throws?: Error;
}

function fakeSearchNamespace(options: FakeSearchOptions = {}) {
  const calls: Array<{ instance: string; params: unknown }> = [];

  const namespace: AiSearchQueryNamespaceLike = {
    get: (name) => ({
      search: async (params) => {
        calls.push({ instance: name, params });
        if (options.throws) throw options.throws;
        return options.response ?? { chunks: [] };
      },
    }),
  };

  return { namespace, calls };
}

/** One chunk in the shape the binding actually returns. */
function rawChunk(overrides: Record<string, unknown> = {}) {
  return {
    id: "chunk-1",
    text: "Refunds are issued within 14 days.",
    score: 0.42,
    item: { key: "src-uuid-billing-faq.md", metadata: { source_id: "src-uuid" } },
    scoring_details: { reranking_score: 0.91 },
    ...overrides,
  };
}

describe("AISearchRetriever", () => {
  const ask = [{ role: "user" as const, content: "how do refunds work" }];

  it("thresholds on the reranker score, not the fused one", async () => {
    const fake = fakeSearchNamespace({ response: { chunks: [rawChunk()] } });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.score).toBe(0.91);
    expect(result.value[0]?.scoreKind).toBe("reranker");
  });

  it("marks the score fused when reranking is off, rather than passing it off as a reranker score", async () => {
    // The failure this guards against is silent: without `scoreKind`, signal 1
    // would gate on a rank-derived number that means nothing across queries.
    const fake = fakeSearchNamespace({
      response: { chunks: [rawChunk({ scoring_details: undefined })] },
    });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.score).toBe(0.42);
    expect(result.value[0]?.scoreKind).toBe("fused");
  });

  it("strips the source id prefix so a citation shows the filename", async () => {
    const fake = fakeSearchNamespace({ response: { chunks: [rawChunk()] } });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.source).toEqual({
      id: "src-uuid",
      title: "billing-faq.md",
      url: null,
    });
  });

  it("falls back to the raw key when the item carries no source id", async () => {
    const fake = fakeSearchNamespace({
      response: { chunks: [rawChunk({ item: { key: "orphan.md" } })] },
    });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok && result.value[0]?.source.title).toBe("orphan.md");
  });

  it("sends the whole window with hybrid retrieval, reranking and rewriting on", async () => {
    const fake = fakeSearchNamespace();
    const window = [
      { role: "user" as const, content: "what plans are there" },
      { role: "assistant" as const, content: "Free and pro." },
      { role: "user" as const, content: "what about the pro plan?" },
    ];

    await new AISearchRetriever(fake.namespace).search(tenantId, window, { limit: 3 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.instance).toBe(instanceId(tenantId));
    expect(fake.calls[0]?.params).toEqual({
      messages: window,
      ai_search_options: {
        retrieval: { retrieval_type: "hybrid", max_num_results: 3 },
        reranking: { enabled: true },
        query_rewrite: { enabled: true },
      },
    });
  });

  it("does not spend a rewrite on an empty question", async () => {
    const fake = fakeSearchNamespace();

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, [
      { role: "user", content: "   " },
    ]);

    expect(result.ok && result.value).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a missing instance as configuration, not an outage", async () => {
    // A tenant that has never uploaded anything has no instance. That is a
    // thing the dashboard can tell them to fix, unlike an outage.
    const missing = new Error("instance_not_found");
    missing.name = "AiSearchNotFoundError";
    const fake = fakeSearchNamespace({ throws: missing });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_configured");
  });

  it("reports an unexpected throw as unavailable so the loop escalates", async () => {
    const fake = fakeSearchNamespace({ throws: new Error("connection reset") });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });

  it("rejects a response in an unrecognised shape rather than inventing chunks", async () => {
    const fake = fakeSearchNamespace({ response: { results: [] } });

    const result = await new AISearchRetriever(fake.namespace).search(tenantId, ask);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });
});
