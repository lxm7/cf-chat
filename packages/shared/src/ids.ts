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
export type SourceId = Brand<string, "SourceId">;
export type ConversationId = Brand<string, "ConversationId">;
/**
 * A widget visitor. Not a user: nobody signs in to ask a support question, and
 * the id is minted by the widget and carried in a cookie.
 */
export type VisitorId = Brand<string, "VisitorId">;

const uuid = z.uuid();

/**
 * The single place a bare string becomes a branded id. Callers are trusted
 * sources only: values already read out of Postgres, or values that have just
 * been through `parse*Id`. Everything crossing a boundary goes through zod.
 */
export const unsafeTenantId = (value: string): TenantId => value as TenantId;
export const unsafeUserId = (value: string): UserId => value as UserId;
export const unsafeSessionId = (value: string): SessionId => value as SessionId;
export const unsafeSourceId = (value: string): SourceId => value as SourceId;
export const unsafeConversationId = (value: string): ConversationId => value as ConversationId;
export const unsafeVisitorId = (value: string): VisitorId => value as VisitorId;

export const tenantIdSchema = uuid.transform(unsafeTenantId);
export const userIdSchema = uuid.transform(unsafeUserId);
export const sessionIdSchema = uuid.transform(unsafeSessionId);
export const sourceIdSchema = uuid.transform(unsafeSourceId);
export const conversationIdSchema = uuid.transform(unsafeConversationId);
export const visitorIdSchema = uuid.transform(unsafeVisitorId);

export function newTenantId(): TenantId {
  return unsafeTenantId(crypto.randomUUID());
}

export function newUserId(): UserId {
  return unsafeUserId(crypto.randomUUID());
}

export function newSessionId(): SessionId {
  return unsafeSessionId(crypto.randomUUID());
}

export function newSourceId(): SourceId {
  return unsafeSourceId(crypto.randomUUID());
}

export function newConversationId(): ConversationId {
  return unsafeConversationId(crypto.randomUUID());
}

export function newVisitorId(): VisitorId {
  return unsafeVisitorId(crypto.randomUUID());
}
