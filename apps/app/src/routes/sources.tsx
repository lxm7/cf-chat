import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, type SourceSummary, type SourcesResponse } from "../api-client.ts";

export const Route = createFileRoute("/sources")({ component: Sources });

/** Poll while anything is still moving. Indexing normally settles in seconds. */
const POLL_MS = 2_000;
// `deleting` is in flight too: the row is a tombstone the consumer is cleaning
// up behind, and it disappears from the list when the cleanup reaps it.
const IN_FLIGHT = new Set(["uploaded", "indexing", "deleting"]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(source: SourceSummary): string {
  switch (source.status) {
    case "uploaded":
      return "Queued";
    case "indexing":
      return "Indexing...";
    case "ready":
      return source.chunkCount === null ? "Ready" : `Ready, ${source.chunkCount} chunks`;
    case "error":
      return source.errorMessage ?? "Failed";
    case "deleting":
      return "Removing...";
    default: {
      // Exhaustiveness: a new status must be handled here rather than rendered raw.
      const never: never = source.status;
      return never;
    }
  }
}

function Sources() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<readonly SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<SourcesResponse>("/api/sources");
      setSources(data.sources);
      return data.sources;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        await navigate({ to: "/login" });
        return [];
      }
      setError(cause instanceof Error ? cause.message : "Could not load knowledge sources");
      return [];
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-poll only while something is in flight, so an idle dashboard is quiet.
  useEffect(() => {
    if (!sources?.some((source) => IN_FLIGHT.has(source.status))) {
      return;
    }
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [sources, load]);

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);
    try {
      // Raw body, not multipart: the Worker streams it straight into R2.
      // The browser sets content-length from the File itself.
      await apiFetch<SourceSummary>("/api/sources", {
        method: "PUT",
        headers: { "x-filename": file.name, "content-type": "application/octet-stream" },
        body: file,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload the file");
    } finally {
      setUploading(false);
      if (fileInput.current) {
        fileInput.current.value = "";
      }
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await apiFetch(`/api/sources/${id}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the source");
    }
  }

  return (
    <main>
      <h1>Knowledge sources</h1>
      <p className="lede">
        Files uploaded here are indexed and become the answers the widget gives. Markdown, text,
        HTML, CSV, PDF and Office documents, up to 10MB each.
      </p>

      <label>
        Add a file
        <input ref={fileInput} type="file" onChange={onPick} disabled={uploading} />
      </label>
      {uploading ? <p className="lede">Uploading...</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {sources === null ? (
        <p className="lede">Loading...</p>
      ) : sources.length === 0 ? (
        <p className="lede">Nothing indexed yet.</p>
      ) : (
        <ul className="tenants">
          {sources.map((source) => (
            // A tombstoned row stays visible, greyed, until the cleanup reaps
            // it. The delete already happened, so the button has nothing left
            // to do and says so rather than offering a second 204.
            <li key={source.id} className={source.status === "deleting" ? "pending" : undefined}>
              <span>
                {source.filename}{" "}
                <span className="role">
                  {formatSize(source.sizeBytes)} &middot; {statusLabel(source)}
                </span>
              </span>
              <button
                type="button"
                className="secondary"
                disabled={source.status === "deleting"}
                onClick={() => void onDelete(source.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <p>
        <Link to="/dashboard">Back to the dashboard</Link>
      </p>
    </main>
  );
}
