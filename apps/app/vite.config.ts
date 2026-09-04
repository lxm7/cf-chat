import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite runs with this app as its working directory, so it never finds the root
 * .env on its own. The Cloudflare plugin reads
 * CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE from process.env
 * while it builds Miniflare's bindings, and fails the dev server outright when
 * it is missing. Load the root file first so one .env serves the whole
 * workspace, matching what drizzle.config.ts does.
 */
function findWorkspaceRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
if (workspaceRoot) {
  const envFile = join(workspaceRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // `viteEnvironment.name: "ssr"` is what merges the Worker config into the
    // framework's SSR build. Without it the Worker is not part of the output.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      auxiliaryWorkers: [{ configPath: "../widget/wrangler.jsonc" }],
    }),
    tanstackStart(),
    viteReact(),
  ],
});
