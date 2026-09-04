import { AppError } from "@cf-chat/shared";
import { type ZodType, z } from "zod";

/** Structural rather than Hono's `Context`, so it stays usable from tests without a full context. */
interface JsonRequest {
  readonly req: { json(): Promise<unknown> };
}

export async function parseBody<T>(c: JsonRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("validation", "Request body must be JSON");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "validation",
      "Request body failed validation",
      z.treeifyError(parsed.error),
    );
  }
  return parsed.data;
}
