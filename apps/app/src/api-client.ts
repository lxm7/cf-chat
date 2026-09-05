/** Minimal typed fetch wrapper for the browser. Cookies carry the session, so credentials are always included. */
import type { SourceStatus } from "@cf-chat/shared";

export type { SourceStatus };

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    let body: ApiErrorBody = { error: "internal", message: `Request failed (${response.status})` };
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Keep the fallback message.
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface TenantSummary {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
  readonly role: string;
}

export interface MeResponse {
  readonly userId: string;
  readonly activeTenantId: string | null;
  readonly tenants: readonly TenantSummary[];
}

export interface SourceSummary {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: SourceStatus;
  readonly chunkCount: number | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SourcesResponse {
  readonly sources: readonly SourceSummary[];
}
