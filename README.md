# zudo-slack-notify

A personal Slack notification relay. A stateless, authenticated Cloudflare Worker posts messages to
Slack channels chosen by alias; a Node CLI and a Claude Code agent skill send them.

**Documentation: https://zudo-slack-notify.zudolab.dev**

```text
agent (Claude Code skill) -> CLI (Node) -> Worker API (POST /v1/notify) -> Slack (chat.postMessage)
```

- One Slack bot token, held only by the Worker. Senders hold a narrower relay key.
- One Slack attempt per request, no queue, no storage, no automatic retries. Responses say whether
  a message was `sent`, `not_sent`, or `unknown`.
- A notification never grants approval to publish or deploy.

## Quick start

Requires Node.js 24+ and pnpm.

```sh
pnpm install

# validate and render a message locally, no network
cd app
node cli/notify.ts --file examples/simple.json --dry-run
```

Deploy your own: see [Getting Started](https://zudo-slack-notify.zudolab.dev) in the docs. It covers
the Slack app, Worker secrets, deployment, the sender env file, and the agent skill.

## Layout

```text
app/                 Worker API + CLI
doc/                 documentation site
skills/notify-slack/ Claude Code agent skill
scripts/             ops helpers (secret upload, smoke checks)
```

`pnpm b4push` runs the pre-push suite.

## License

MIT
