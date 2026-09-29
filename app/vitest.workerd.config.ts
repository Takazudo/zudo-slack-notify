import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { API_KEY, BOT_TOKEN, SLACK_TARGETS } from "./tests/support/fakes.ts";
import { createOutboundMock } from "./tests/support/workerd-outbound.ts";

// Run through `pnpm test:workerd` (scripts/run-workerd-tests.ts), which reaps the
// workerd process group even if vitest crashes.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: { NOTIFY_API_KEY: API_KEY, SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_TARGETS },
        // Sits below the isolate with no network fallback, so even the Worker's
        // module-captured native fetch cannot bypass it.
        outboundService: createOutboundMock(),
      },
    }),
  ],
  test: {
    include: ["tests/workerd/**/*.test.ts"],
    // The outbound mock's scenario is process-wide state; one worker keeps files from racing on it.
    maxWorkers: 1,
  },
});
