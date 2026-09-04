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
    /** HMAC key for the session cookie. See packages/shared/src/session.ts. */
    SESSION_SECRET: string;
  }
}
