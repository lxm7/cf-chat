import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Bindings are declared here rather than pointing at wrangler.jsonc: the app's
 * `main` is the framework's virtual server entry, which the test pool cannot
 * resolve, and Hyperdrive has no local emulation. Tests needing Postgres are
 * guarded on TEST_DATABASE_URL instead.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["KV"],
        r2Buckets: ["KNOWLEDGE"],
        bindings: { SESSION_SECRET: "test-secret-not-a-real-key" },
      },
    }),
  ],
  test: {
    name: "app",
    include: ["test/**/*.test.ts"],
    // AI Search and Hyperdrive have no local emulation, so neither is declared
    // here: the ingest consumer takes its dependencies as arguments and tests
    // supply FixtureIndexer and a stub database. R2 is emulated, so the
    // consumer reads real objects.
  },
});
