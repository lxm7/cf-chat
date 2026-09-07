/**
 * `wrangler types` generates `Cloudflare.Env` from wrangler.jsonc, which covers
 * the bindings but not secrets: secrets are never declared in config
 * (CLAUDE.md), so they are declared here and merged into the generated
 * interface.
 *
 * Set locally in .dev.vars, in production with `wrangler secret put`.
 */
declare namespace Cloudflare {
  interface Env {
    /**
     * HMAC key for the visitor token. The same value as `app` holds: this
     * Worker signs, `app` verifies. Deliberately not `SESSION_SECRET`, so a
     * widget-signed token cannot be exchanged for a dashboard session (ADR-016).
     */
    WIDGET_TOKEN_SECRET: string;
    /** Turnstile secret, for siteverify. The site key is public and lives in KV. */
    TURNSTILE_SECRET_KEY: string;
  }
}
