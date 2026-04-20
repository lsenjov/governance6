import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    globals: true,
    server: { deps: { inline: ["convex-test"] } },
  },
});
