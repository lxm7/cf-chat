import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "reply-loop",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
