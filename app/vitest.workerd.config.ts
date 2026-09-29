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
        // Below the isolate, so it also catches the Worker's module-captured native
        // fetch; an isolate-level fetch mock (e.g. MSW) cannot promise that.
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
