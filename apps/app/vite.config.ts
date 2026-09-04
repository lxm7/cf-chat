import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
