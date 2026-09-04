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
}

/** Records what the binding was asked to do, so the calls can be asserted on. */
function fakeNamespace(options: FakeOptions = {}) {
  const created: string[] = [];
  const gotten: string[] = [];
  const uploads: Array<{ name: string; instance: string }> = [];
  const deleted: string[] = [];

  const instance = (id: string): AiSearchInstanceLike => ({
    items: {
      uploadAndPoll: async (name) => {
        if (options.uploadThrows) throw options.uploadThrows;
        uploads.push({ name, instance: id });
        return options.item ?? { id: "item-1", key: name, status: "completed", chunks_count: 3 };
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

  return { namespace, created, gotten, uploads, deleted };
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

  it("deletes through the tenant's own instance", async () => {
    const fake = fakeNamespace();

    const result = await new AISearchIndexer(fake.namespace).remove(tenantId, "item-9");

    expect(result.ok).toBe(true);
    expect(fake.deleted).toEqual(["item-9"]);
    expect(fake.gotten).toEqual([instanceId(tenantId)]);
  });
});
