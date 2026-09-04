import { z } from "zod";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * Branded ids. The tenant hard rule ("`tenantId` on every binding call, never
 * query without it") is enforced at the type level: repository functions take a
 * `TenantId`, and a bare `string` will not satisfy it, so a forgotten tenant
 * predicate is a compile error rather than a data leak.
 */
export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;

const uuid = z.uuid();

/**
 * The single place a bare string becomes a branded id. Callers are trusted
 * sources only: values already read out of Postgres, or values that have just
 * been through `parse*Id`. Everything crossing a boundary goes through zod.
 */
export const unsafeTenantId = (value: string): TenantId => value as TenantId;
export const unsafeUserId = (value: string): UserId => value as UserId;
export const unsafeSessionId = (value: string): SessionId => value as SessionId;

export const tenantIdSchema = uuid.transform(unsafeTenantId);
export const userIdSchema = uuid.transform(unsafeUserId);
export const sessionIdSchema = uuid.transform(unsafeSessionId);

export function newTenantId(): TenantId {
  return unsafeTenantId(crypto.randomUUID());
}

export function newUserId(): UserId {
  return unsafeUserId(crypto.randomUUID());
}

export function newSessionId(): SessionId {
  return unsafeSessionId(crypto.randomUUID());
}
