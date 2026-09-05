import { env } from "cloudflare:workers";
import { insertSource, listSources, markSourceDeleting, withTenant } from "@cf-chat/db";
import type { SourceRow } from "@cf-chat/db/schema";
import {
  AppError,
  contentTypeForSourceFile,
  INBOUND_MAX_BYTES,
  isSupportedSourceFile,
  newSourceId,
  type SourceId,
  sanitizeFilename,
  sourceIdSchema,
  type TenantId,
} from "@cf-chat/shared";
import { Hono } from "hono";
import { withDb } from "../db.ts";
import { requireSession, type SessionVariables } from "../middleware/session.ts";

const sources = new Hono<{ Variables: SessionVariables }>();

/**
 * The active tenant, or a 403. A user with no memberships has a null tenant on
 * the session, and every route here is tenant-owned.
 */
function activeTenant(tenantId: TenantId | null): TenantId {
  if (!tenantId) {
    throw new AppError("forbidden", "Select a workspace before managing knowledge sources");
  }
  return tenantId;
}

/** R2 keys are derived server-side. The tenant segment never comes from the client. */
function r2KeyFor(tenantId: TenantId, sourceId: SourceId, filename: string): string {
  return `${tenantId}/sources/${sourceId}/${filename}`;
}

/** The client has no use for the R2 key, so it does not get one. */
function toSummary(row: SourceRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    chunkCount: row.chunkCount,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

sources.get("/", requireSession, async (c) => {
  const tenantId = activeTenant(c.get("session").tenantId);
  const rows = await withDb((db) => listSources(db, tenantId));
  return c.json({ sources: rows.map(toSummary) });
});

/**
 * Raw body upload rather than multipart (ADR-011): AI Search caps files at 4MB,
 * so there are no large bytes to keep out of the Worker, and Workers bills CPU
 * rather than duration. Streaming `request.body` straight into R2 costs about a
 * millisecond of CPU, where parsing multipart in JS would cost real work.
 *
 * Everything is validated before a byte reaches R2, which is the property a
 * presigned upload cannot offer.
 */
sources.put("/", requireSession, async (c) => {
  const tenantId = activeTenant(c.get("session").tenantId);

  const filename = sanitizeFilename(c.req.header("x-filename") ?? "");
  if (!filename) {
    throw new AppError("validation", "The x-filename header is missing or not a usable filename");
  }
  if (!isSupportedSourceFile(filename)) {
    throw new AppError("validation", `${filename} is not a supported file type`);
  }

  // Content-Length is the only way to reject an oversized body before storing
  // it. A chunked upload without one is refused rather than streamed blindly.
  const declaredLength = Number(c.req.header("content-length"));
  if (!Number.isInteger(declaredLength) || declaredLength <= 0) {
    throw new AppError("validation", "A content-length header is required");
  }
  if (declaredLength > INBOUND_MAX_BYTES) {
    throw new AppError(
      "validation",
      `File is larger than the ${Math.floor(INBOUND_MAX_BYTES / 1024 / 1024)}MB limit`,
    );
  }

  const body = c.req.raw.body;
  if (!body) {
    throw new AppError("validation", "Request body is empty");
  }

  const sourceId = newSourceId();
  const contentType = contentTypeForSourceFile(filename);
  const r2Key = r2KeyFor(tenantId, sourceId, filename);

  const object = await env.KNOWLEDGE.put(r2Key, body, {
    httpMetadata: { contentType },
  });
  if (!object) {
    throw new AppError("internal", "Could not store the uploaded file");
  }

  // R2 reports the true size; the header was only ever a claim.
  const row = await withDb((db) =>
    withTenant(db, tenantId, (tx) =>
      insertSource(tx, tenantId, {
        id: sourceId,
        filename,
        contentType,
        sizeBytes: object.size,
        r2Key,
      }),
    ),
  );

  try {
    await env.INGEST.send({ kind: "index", tenantId, sourceId });
  } catch (cause) {
    // The row stays in `uploaded` and the object stays in R2, so nothing is
    // lost and nothing is duplicated. Recovering it belongs to the cron sweep
    // in build step 8; failing the request here would strand the object with
    // no row instead. See the open item in docs/plan.md.
    console.error("Could not enqueue ingest for source", sourceId, cause);
  }

  return c.json(toSummary(row), 201);
});

sources.delete("/:id", requireSession, async (c) => {
  const tenantId = activeTenant(c.get("session").tenantId);

  const parsed = sourceIdSchema.safeParse(c.req.param("id"));
  if (!parsed.success) {
    throw new AppError("validation", "Not a valid source id");
  }
  const sourceId = parsed.data;

  // The row is the record of what exists, so the delete is decided here and
  // nowhere else. Removing the index item and the R2 object happens afterwards
  // on the queue and cannot change this answer: before ADR-013 a transient AI
  // Search error meant the row could not be deleted at all, because the least
  // authoritative system was gating the authoritative write.
  const marked = await withDb((db) =>
    withTenant(db, tenantId, (tx) => markSourceDeleting(tx, tenantId, sourceId)),
  );
  if (!marked) {
    throw new AppError("not_found", "No such knowledge source");
  }

  try {
    await env.INGEST.send({ kind: "delete", tenantId, sourceId });
  } catch (cause) {
    // The tombstone is committed, so the source is gone as far as the product
    // is concerned and the caller gets its 204 either way. The row stays
    // `deleting` for the step 8 sweep to pick up. See docs/plan.md.
    console.error("Could not enqueue cleanup for source", sourceId, cause);
  }

  return c.body(null, 204);
});

export default sources;
