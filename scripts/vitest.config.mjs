import { defineConfig } from "vitest/config";

// Root-level suite for the repo's own scripts (ops script, smoke script).
export default defineConfig({
  test: { environment: "node", include: ["scripts/*.test.mjs"] },
});
