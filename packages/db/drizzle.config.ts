import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit talks to Neon directly, never through Hyperdrive: Hyperdrive is a
 * Workers binding and its connection string is only resolvable inside a Worker.
 * DATABASE_URL is the direct Neon connection string, set in .env locally.
 */
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
