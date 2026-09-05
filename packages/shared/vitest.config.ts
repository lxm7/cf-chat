import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * workerd, not node. These modules run in the Workers runtime in production,
 * and password.ts now depends on node:crypto being present there, which a node
 * environment cannot tell us anything about.
 *
 * This does not make the suite a substitute for a deployed smoke test. Local
 * workerd accepts PBKDF2 at 600,000 iterations while the deployed runtime
 * rejects anything above 100,000, which is how a 210,000-iteration hash passed
 * CI and then broke login in production. Runtime limits are only observable
 * against a real deploy.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    name: "shared",
    include: ["test/**/*.test.ts"],
  },
});
