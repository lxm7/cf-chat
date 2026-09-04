import { z } from "zod";
import { tenantIdSchema } from "./ids.ts";

const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/** 12 chars is the floor because PBKDF2 is our KDF; see password.ts for why that matters. */
const newPassword = z.string().min(12).max(200);

export const signupInput = z.object({
  email,
  password: newPassword,
  name: z.string().trim().min(1).max(120),
  tenantName: z.string().trim().min(1).max(120),
});

export const loginInput = z.object({
  email,
  password: z.string().min(1).max(200),
});

export const switchTenantInput = z.object({
  tenantId: tenantIdSchema,
});

export type SignupInput = z.infer<typeof signupInput>;
export type LoginInput = z.infer<typeof loginInput>;
export type SwitchTenantInput = z.infer<typeof switchTenantInput>;

export const TENANT_ROLES = ["owner", "admin", "agent"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const TENANT_PLANS = ["free", "pro"] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

/** Lowercase, hyphenated, ascii-only. Collisions are resolved by the caller with a suffix. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
}
