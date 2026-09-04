/**
 * Result type for expected domain failures.
 *
 * Convention (ADR pending, see docs/plan.md): the API layer throws `AppError`
 * and lets Hono's `onError` map it. Packages that have to degrade rather than
 * fail the request (retrieval, reply-loop) return `Result` instead, so the
 * caller is forced to handle the failure path in the type system.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

/** Unwrap, falling back to `fallback` on failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
