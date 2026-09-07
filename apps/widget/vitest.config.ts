import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Bindings are declared here rather than pointing at wrangler.jsonc, matching
 * `apps/app`. The service binding to `app` is deliberately absent: the gate
 * tests stop at the point of forwarding, because what happens past the binding
 * is `app`'s to test and is covered in `apps/app/test/agent-auth.test.ts`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["KV"],
        bindings: {
          WIDGET_TOKEN_SECRET: "test-widget-secret-not-a-real-key",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret-not-a-real-key",
        },
      },
    }),
  ],
  test: {
    name: "widget",
    include: ["test/**/*.test.ts"],
  },
});
