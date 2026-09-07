import { z } from "zod";
import { type TenantId, tenantIdSchema } from "./ids.ts";

/**
 * The public identifier a tenant pastes into their site.
 *
 * Public by definition: it ships in the embed snippet on someone else's page,
 * so it identifies a tenant and authorises nothing on its own. The origin
 * allowlist and Turnstile are what stand between it and a conversation.
 *
 * Prefixed so a leaked one is recognisable in a log or a bug report, and so it
 * cannot be confused with a uuid from `ids.ts`, which is the shape everything
 * else in this codebase uses for identity.
 */
export type WidgetSiteKey = string & { readonly __brand: "WidgetSiteKey" };

const SITE_KEY_PREFIX = "wk_";

export const widgetSiteKeySchema = z
  .string()
  .regex(/^wk_[0-9a-f]{32}$/)
  .transform((value) => value as WidgetSiteKey);

export function newWidgetSiteKey(): WidgetSiteKey {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${SITE_KEY_PREFIX}${hex}` as WidgetSiteKey;
}

/**
 * What the `widget` Worker needs to decide whether to mint a visitor token.
 *
 * Lives in KV, which `CLAUDE.md` sanctions for widget config specifically. The
 * no-read-after-write rule applies with teeth here: a tenant who adds an origin
 * in the dashboard will not see it take effect immediately, so the dashboard
 * must never save an origin and then verify it by calling the widget.
 */
export interface WidgetConfig {
  readonly tenantId: TenantId;
  /**
   * Exact origin strings, compared with `===` against the `Origin` header.
   * No wildcards and no suffix matching: `evil-acme.com` must never satisfy a
   * rule written for `acme.com`, and suffix checks are how that happens.
   */
  readonly origins: readonly string[];
  /** Public Turnstile site key, rendered by the embed. Not the secret. */
  readonly turnstileSiteKey: string;
}

export const widgetConfigSchema = z.object({
  tenantId: tenantIdSchema,
  origins: z.array(z.string().min(1)).max(50),
  turnstileSiteKey: z.string().min(1),
});

export const widgetConfigKvKey = (siteKey: WidgetSiteKey): string => `widget:${siteKey}`;

/**
 * Whether a request's `Origin` may use this widget.
 *
 * A missing `Origin` is refused rather than waved through. Browsers always send
 * one on cross-origin requests and on WebSocket upgrades, so absence means the
 * caller is not a browser page, which is exactly the case the allowlist exists
 * to exclude.
 */
export function isAllowedOrigin(config: WidgetConfig, origin: string | null): boolean {
  return origin !== null && config.origins.includes(origin);
}
