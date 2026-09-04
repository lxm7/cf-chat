import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit talks to Neon directly, never through Hyperdrive: Hyperdrive is a
 * Workers binding and its connection string is only resolvable inside a Worker.
 * DATABASE_URL is the direct Neon connection string, set in .env at the repo
 * root.
 */

/**
 * drizzle-kit runs with this package as its working directory, so it never
 * finds the root .env on its own and DATABASE_URL silently stays undefined.
 * Walk up to the workspace root and load it explicitly. Node 22 has
 * loadEnvFile built in, so this costs no dependency.
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

const root = findWorkspaceRoot(process.cwd());
if (root) {
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

// Deliberately not thrown at module load: `drizzle-kit generate` works offline
// and should not need credentials. `migrate` and `studio` fail with a URL that
// names the problem.
const url = process.env.DATABASE_URL ?? "postgres://set-DATABASE_URL-in-dot-env";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
