# Local setup and eventual deployment

## 1. Inspect without credentials

Use Node.js 24+ and pnpm 11.5.2, then:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workerd
node cli/notify.ts --file examples/npm-approval.json --dry-run
pnpm preview
```

All automated delivery tests use fake credentials and mocked Slack. The offline preview has no send function. `--dry-run` shows the actual constructed Slack payload, using a placeholder channel because only the deployed Worker resolves real aliases.

The tooling pins intentionally match a known version from your Cloudflare wisdom: Wrangler 4.85.0 and its workerd 1.20260424.1. The compatibility date is 2026-04-01 so the local runtime supports it. TypeScript and Node typings are also exact pins; these are a reproducible baseline, not a claim that they are the newest versions. Upgrade them together during local finalization if desired. [Pinned Wrangler package](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.85.0/packages/wrangler/package.json)

## 2. Create the posting app in Slack

Create a Slack app **from a manifest**, using `slack-app-manifest.json`, and choose your workspace. Install it to that workspace. The app requests only the bot scope `chat:write`. Obtain the **Bot User OAuth Token** (`xoxb-…`). It becomes the Worker's `SLACK_BOT_TOKEN` secret. [Slack app manifests](https://docs.slack.dev/reference/app-manifest/)

Invite `zudo-notify` to the channel(s) you intend to use. Open each channel's details in Slack and copy its channel ID. Replace `SLACK_TARGETS` in `wrangler.toml` with your mappings. The target `releases` can point to one dedicated approval channel, and `dev` to another channel or the same one.

```toml
[vars]
SLACK_TARGETS = '{"releases":"C0123456789","dev":"C0987654321"}'
```

The example IDs are placeholders. Choose actual destinations locally; this prototype has not resolved or contacted any channel. Private channels also require inviting the bot. There is no need to enable Events API, interactivity, Socket Mode, slash commands, public posting scope, or a Slack signing secret for this outbound-only API. [Slack posting and membership](https://docs.slack.dev/reference/methods/chat.postMessage/)

## 3. Create the independent relay secret

Generate 32 random bytes, encoded as 64 hex characters:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")'
```

Keep that value in a secret manager or your local environment. This is `NOTIFY_API_KEY` on the Worker and `ZUDO_NOTIFY_API_KEY` in local sender configuration. It is a different credential from the Slack token.

The prototype accepts a 32–256-character printable ASCII key without spaces. Do not put credentials in the notification JSON, URLs, command flags, code, or committed configuration.

## 4. Deploy the Worker when ready

Use your established Cloudflare account/login setup. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, if used for deployment, belong to local tooling or CI. They are not Worker runtime bindings. The Worker name in `wrangler.toml` is an editable working name.

The first deployment creates a Worker that rejects notification requests until secrets are configured. This is why the initial configuration intentionally omits `secrets.required`; it avoids a bootstrap dependency on already existing secrets.

```sh
pnpm exec wrangler deploy
```

Prepare an ignored `.dev.vars.production` with **only** these two real values:

```dotenv
NOTIFY_API_KEY="your-generated-64-character-hex-secret"
SLACK_BOT_TOKEN="your-real-xoxb-bot-token"
```

Upload both values together:

```sh
pnpm exec wrangler secret bulk .dev.vars.production
```

This command changes the deployed Worker. Dotenv bulk files are supported by the pinned Wrangler version. Subsequent code deployments retain uploaded secrets. After bootstrap, you may add `[secrets] required = [...]` if desired, with a corresponding deployment check. [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [pinned bulk command implementation](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.85.0/packages/wrangler/src/secret/index.ts)

`GET /healthz` proves only that the handler is running. It intentionally does not validate the Slack token or channel membership. A request without valid bearer authentication must never post.

## 5. Configure the local sender

Copy `.env.example` to `.env`, then set:

```dotenv
ZUDO_NOTIFY_URL="https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/v1/notify"
ZUDO_NOTIFY_API_KEY="the-same-relay-key-configured-on-the-Worker"
```

The sender only needs those two variables. It must not receive `SLACK_BOT_TOKEN` or Cloudflare credentials. The CLI rejects non-HTTPS remote endpoints, credentials/query fragments in the URL, and redirects. HTTP is accepted only for explicit loopback development.

Send one intentionally chosen smoke notification to your configured channel:

```sh
node --env-file=.env cli/notify.ts \
  --target dev \
  --title 'zudo-notify is connected' \
  --message 'Local setup smoke test.'
```

Confirm both a `delivery: "sent"` receipt and the actual Slack message. Check a phone notification if that is important for your use case; Slack's channel notification preferences, device settings, and Do Not Disturb affect that separately from message delivery.

## 6. Attach the skill to your local workflow

Copy `agent-skill/notify-slack.template.md` into a local skill directory as `SKILL.md`, following your own skill conventions. Configure an absolute project path such as `ZUDO_NOTIFY_ROOT=/path/to/zudo-notify`; the template invokes `cli/notify.ts` from that checkout. This avoids installing a new package for each repository.

Read `agent-skill/project-wrapper.md` for the release-specific adapter. Have the agent use a JSON file for complex messages. Keep its receipt with the relevant release session, so it can tell whether it already notified you.

## Local Worker development

For local development, `.dev.vars` is the Worker's secret file. `.env` in the examples above is the sender's configuration. Wrangler prefers `.dev.vars` when present, so keep the files separate and do not assume the sender's variables configure the Worker.

Use a dedicated test channel/token if manually exercising `wrangler dev`; local Worker requests can still contact Slack when real credentials are present. The automated `test:workerd` suite instead replaces every outbound fetch with a mock and does not need `.dev.vars`.

## Rotating and troubleshooting

Rotate the relay credential by updating the Worker secret and then the authorized local callers. Rotate Slack credentials in Slack and upload the new bot token to the Worker. Do not reuse the old bot token as the relay key.

For a rejected post, inspect the structured error and request ID. Confirm channel mapping, bot membership, token type and app scope. For `delivery: "unknown"`, inspect the destination in Slack before resending. If Slack rate limits you, wait the returned full `retryAfterSeconds`. Do not shorten it or loop indefinitely. [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
