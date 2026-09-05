/**
 * Knowledge source domain rules, shared between the upload boundary, the ingest
 * consumer and the dashboard.
 */

/**
 * `deleting` is a tombstone, not a state a file rests in: the row is the record
 * of what exists, so a delete writes it here first and the index item and the R2
 * object are removed afterwards by the consumer, which then hard deletes the
 * row. See ADR-013.
 *
 * Appended rather than slotted next to `ready` so the enum migration is a plain
 * `ADD VALUE` with no `BEFORE` clause. The order carries no meaning.
 */
export const SOURCE_STATUSES = ["uploaded", "indexing", "ready", "error", "deleting"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * AI Search refuses anything larger, on both Workers plans. Files between this
 * and INBOUND_MAX_BYTES are converted to markdown before upload, which brings
 * almost anything text-bearing back under the cap.
 */
export const AI_SEARCH_MAX_BYTES = 4 * 1024 * 1024;

/** Our own boundary cap, enforced from Content-Length before a byte reaches R2. */
export const INBOUND_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `uploadAndPoll` gives up after 30 seconds, which is not a failure: the item
 * keeps indexing after we stop watching. These two govern the delayed check
 * that settles the row afterwards.
 */
export const INDEX_CHECK_DELAY_SECONDS = 30;

/**
 * 20 checks at 30 seconds is 10 minutes, after which the row is called failed.
 * The item may still finish indexing on AI Search's side, so the message says
 * so rather than claiming the file is broken.
 */
export const MAX_INDEX_CHECKS = 20;

/**
 * Convenience allowlist, not a correctness boundary. It exists so the dashboard
 * can reject an obviously wrong file immediately rather than after a queue
 * round trip. Anything that slips through still comes back from AI Search as
 * `unsupported_type`, which the consumer records on the row.
 *
 * The authoritative list is `env.AI.toMarkdown().supported()` and
 * https://developers.cloudflare.com/ai-search/configuration/data-source/
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".numbers": "application/vnd.apple.numbers",
};

export const SUPPORTED_SOURCE_EXTENSIONS = Object.keys(CONTENT_TYPE_BY_EXTENSION);

/** Lowercased, including the dot. Empty string when the name has no extension. */
export function sourceFileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function isSupportedSourceFile(filename: string): boolean {
  return sourceFileExtension(filename) in CONTENT_TYPE_BY_EXTENSION;
}

/**
 * Derived from the extension, never from the client's content-type header: the
 * header is attacker-controlled and AI Search dispatches its converter on type.
 */
export function contentTypeForSourceFile(filename: string): string {
  return CONTENT_TYPE_BY_EXTENSION[sourceFileExtension(filename)] ?? "application/octet-stream";
}

/**
 * Filenames arrive in a header, so they are untrusted input that ends up in an
 * R2 key. Strips any directory component, control characters and leading dots,
 * then truncates the stem while keeping the extension intact.
 *
 * Returns null when nothing usable survives, which the caller turns into a 400.
 */
export function sanitizeFilename(raw: string): string | null {
  // Take the basename: a client is free to send "../../etc/passwd".
  const basename = raw.split(/[/\\]/).pop() ?? "";

  const cleaned = basename
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replaceAll(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/^[.\s]+|\s+$/g, "")
    .trim();

  if (cleaned.length === 0) {
    return null;
  }

  // Stripping the leading dots above turns ".md" into "md" and ".gitignore"
  // into "gitignore", neither of which is a real upload. Every source file has
  // an extension, so demanding one rejects both rather than inventing a name.
  const extension = sourceFileExtension(cleaned);
  if (extension === "") {
    return null;
  }

  const stem = cleaned.slice(0, -extension.length);
  if (stem.length === 0) {
    return null;
  }

  const maxStem = 255 - extension.length;
  return `${stem.slice(0, maxStem)}${extension}`;
}
