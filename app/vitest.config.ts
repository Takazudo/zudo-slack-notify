import { defineConfig } from "vitest/config";

// Node-environment suite: validation, rendering, the handler with a fake env and
// an injected Slack fetch, and the CLI. The workerd suite has its own config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/*.test.ts"],
  },
});
