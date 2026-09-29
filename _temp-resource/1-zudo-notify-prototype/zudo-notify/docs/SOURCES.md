# Research sources

Reviewed 2026-09-28 JST. These are the exact reference snapshots used for the design. The code in this prototype is a new implementation; no original repository was modified.

## User reference repositories

| Repository | Reviewed revision | Relevant areas |
| --- | --- | --- |
| [Takazudo/zudo-slack-wisdom](https://github.com/Takazudo/zudo-slack-wisdom/tree/30037546f63a1951540adc9b6ff66ce552c7475f) | `30037546f63a1951540adc9b6ff66ce552c7475f` | Native fetch, secret configuration, Block Kit, fallback text, threading, rate limits |
| [Takazudo/zudo-cloudflare-wisdom](https://github.com/Takazudo/zudo-cloudflare-wisdom/tree/956e1b298ee346d929b0bae18cd16930adaf68b2) | `956e1b298ee346d929b0bae18cd16930adaf68b2` | Standalone Workers, deployment/bootstrap, runtime gotchas, token and idempotency patterns |
| [zudolab/zmod-bot](https://github.com/zudolab/zmod-bot/tree/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256) | `c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256` | Existing Slack Worker, API client, event/interactivity routes, durable job handling |

### Slack wisdom paths

- [worker-backend/web-api-with-fetch.mdx](https://github.com/Takazudo/zudo-slack-wisdom/blob/30037546f63a1951540adc9b6ff66ce552c7475f/src/content/docs/worker-backend/web-api-with-fetch.mdx): native fetch, transport injection, Slack `ok` checks, timing and retry considerations.
- [worker-backend/secrets-and-config.mdx](https://github.com/Takazudo/zudo-slack-wisdom/blob/30037546f63a1951540adc9b6ff66ce552c7475f/src/content/docs/worker-backend/secrets-and-config.mdx): runtime secrets, local `.dev.vars`, required secret declarations, preview binding caveats.
- [messaging/posting-and-block-kit.mdx](https://github.com/Takazudo/zudo-slack-wisdom/blob/30037546f63a1951540adc9b6ff66ce552c7475f/src/content/docs/messaging/posting-and-block-kit.mdx): stable destination IDs, thread timestamp, fallback text, block limits, links and unfurls.
- [messaging/formatting.mdx](https://github.com/Takazudo/zudo-slack-wisdom/blob/30037546f63a1951540adc9b6ff66ce552c7475f/src/content/docs/messaging/formatting.mdx): literal text and Slack markup.
- [messaging/rate-limits.mdx](https://github.com/Takazudo/zudo-slack-wisdom/blob/30037546f63a1951540adc9b6ff66ce552c7475f/src/content/docs/messaging/rate-limits.mdx): pacing and explicit backoff.

### Cloudflare wisdom paths

- [workers/standalone-workers.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/workers/standalone-workers.mdx)
- [workers/deploy-from-zero.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/workers/deploy-from-zero.mdx)
- [workers/wrangler-config.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/workers/wrangler-config.mdx)
- [workers/runtime-gotchas.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/workers/runtime-gotchas.mdx)
- [recipes/personal-api-tokens.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/recipes/personal-api-tokens.mdx)
- [recipes/idempotency-ledger.mdx](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/recipes/idempotency-ledger.mdx)
- [package.json](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/package.json): the Wrangler/pnpm baseline.

### Existing bot paths

- [src/index.ts](https://github.com/zudolab/zmod-bot/blob/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256/src/index.ts): incoming Slack routes and health, rather than a generic agent notification endpoint.
- [src/slack/api.ts](https://github.com/zudolab/zmod-bot/blob/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256/src/slack/api.ts): small HTTP client and receipt handling; this prototype uses a different retry policy.
- [src/slack/events.ts](https://github.com/zudolab/zmod-bot/blob/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256/src/slack/events.ts): inbound event authorization/filtering; this prototype uses an independent caller key and a required nonempty target map.
- [docs/slack-manifest.yml](https://github.com/zudolab/zmod-bot/blob/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256/docs/slack-manifest.yml): original app capabilities; the prototype requests only posting scope.

## Official platform references

| Source | Question checked |
| --- | --- |
| [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) | Posting, bot scope, receipt, fallback, membership, threads and errors |
| [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) | Fixed channel and no returned message timestamp |
| [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) | Channel pacing and `Retry-After` |
| [Slack text formatting](https://docs.slack.dev/messaging/formatting-message-text/) | Special characters, mentions, link syntax |
| [Slack text object](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/) | Plain text, mrkdwn and verbatim parsing |
| [Slack app manifest](https://docs.slack.dev/reference/app-manifest/) | Minimal app manifest structure |
| [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/) | Local and deployed secret handling |
| [Cloudflare Worker context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) | Awaiting request-critical work and background lifetime |
| [Cloudflare Request properties](https://developers.cloudflare.com/workers/runtime-apis/request/#properties) | Redirect behavior and credential forwarding considerations |
| [Cloudflare testing](https://developers.cloudflare.com/workers/testing/) | Runtime verification approach |
| [Wrangler 4.85.0 package source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.85.0/packages/wrangler/package.json) | Exact workerd/Miniflare versions behind the tooling pin |
| [Wrangler 4.85.0 bulk secrets source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.85.0/packages/wrangler/src/secret/index.ts) | Dotenv bulk upload supported by the pinned tool |

## Research boundary

“npm staging” is treated as the user's existing workflow requiring manual acceptance. No particular npm staging feature, command, approval URL, or CI provider was verified for the user's project, because that project/workflow was not identified in the request. The relay and examples therefore carry notification data without attempting to implement that approval step.
