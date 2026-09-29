# zudo-notify

A small, runnable prototype for **local AI agent → authenticated Cloudflare Worker → chosen Slack channel** notifications. Working name: `zudo-notify`.

The first use case is “npm staging is ready; Takeshi needs to approve the next step.” The same API also handles a completed deployment, a task that needs input, or a one-line update. The Worker only delivers messages. Your existing release workflow owns approval and publishing.

## Start here

Use Node.js 24+ and pnpm 11.5.2. The sender and unit tests use Node's native TypeScript support. The Worker uses standard Web APIs and has **zero runtime dependencies**.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workerd
node cli/notify.ts --file examples/npm-approval.json --dry-run
pnpm preview
```

Open `http://127.0.0.1:4173` for the offline message composer. You can also open `prototype/index.html` directly. It previews four message shapes and exports request JSON. It cannot send messages and never needs a secret. Its visual layout approximates Slack; `--dry-run` uses the actual shared validator and renderer.

**Continue locally:** read [docs/LOCAL-HANDOFF.md](docs/LOCAL-HANDOFF.md). Setup is in [docs/SETUP.md](docs/SETUP.md), the contract is in [docs/API.md](docs/API.md), and design decisions are in [docs/DESIGN.md](docs/DESIGN.md).

## Smallest API call

`POST /v1/notify`, authenticated by `Authorization: Bearer <NOTIFY_API_KEY>`:

```json
{
  "target": "dev",
  "message": "The documentation draft is ready for review."
}
```

Named targets are resolved on the Worker. In `wrangler.toml`:

```toml
[vars]
SLACK_TARGETS = '{"releases":"C0123456789","dev":"C0987654321"}'
```

Replace those illustrative IDs with your actual channel IDs. All callers sharing the API key can post to every configured alias. The API does not accept a raw channel override, arbitrary Slack methods, or raw Block Kit.

## Send from an agent

Configure `ZUDO_NOTIFY_URL` and `ZUDO_NOTIFY_API_KEY` in the local sender environment. Those names are intentionally different from Worker configuration. The Slack bot token belongs only to the Worker.

```sh
# After setting real values in the ignored .env file:
node --env-file=.env cli/notify.ts --file notification.local.json

# Small one-off case:
node --env-file=.env cli/notify.ts \
  --target dev \
  --kind success \
  --title 'Build completed' \
  --message 'The preview is ready for review.'
```

Use [agent-skill/notify-slack.template.md](agent-skill/notify-slack.template.md) as the source for a local Codex/Claude Code notification skill. It is a project handoff template, not an installed ChatGPT skill. It has one job: prepare factual text and run this sender. Project-specific release logic belongs in a wrapper skill.

## What is included

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker routing, API authentication, destination resolution, Slack request, delivery result |
| `src/notification.ts` | Shared validation and Slack message construction |
| `cli/notify.ts` | Dependency-free local sender, dry-run, explicit exit codes |
| `wrangler.toml` | Single Worker deployment configuration |
| `slack-app-manifest.json` | Minimal Slack app with `chat:write` |
| `examples/` | npm review, deployment, blocked task, and minimal notification JSON |
| `prototype/index.html` | Standalone offline composer and Slack-style visual approximation |
| `agent-skill/` | Portable skill template and project integration guidance |
| `docs/` | Setup, API, design, source research, and local implementation handoff |
| `tests/` | Node tests plus actual workerd tests with mocked Slack |

## Delivery semantics

The request waits for Slack. HTTP 200 plus a valid `{ ok: true, channel, ts }` Slack receipt becomes `delivery: "sent"`. This means Slack accepted a message; it does not prove a phone push arrived, that you read it, or that a release was approved.

There is no durable queue, storage, or duplicate suppression. Sending the same request twice can create two messages. A timeout, network failure, malformed receipt, or ambiguous upstream error returns `delivery: "unknown"`; the sender does not automatically retry. A confirmed rate limit returns its full retry delay for a later retry.

The service is designed for a few meaningful notifications, not streaming build logs. Slack typically allows about one message per second per channel and returns a `Retry-After` delay when rate limiting. [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

## Prototype status

Source, pinned dependency lockfile, setup examples, and tests are included. The implementation has not been deployed to your Cloudflare account or sent a real message to your Slack workspace. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the checks actually completed in this session and the one live smoke test to perform after local configuration.

Based on the requested [zudo-slack-wisdom](https://github.com/Takazudo/zudo-slack-wisdom), [zudo-cloudflare-wisdom](https://github.com/Takazudo/zudo-cloudflare-wisdom), and [zmod-bot](https://github.com/zudolab/zmod-bot) repositories. Exact reviewed revisions and source links are in [docs/SOURCES.md](docs/SOURCES.md).
