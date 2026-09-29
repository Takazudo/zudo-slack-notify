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

To send for real, create the Slack app from `app/slack-app-manifest.json`, put the values in the
operator store at `$DROPBOX_ROOT/env/zudo-slack-notify/credentials/`, then:

```sh
pnpm ops:push-secrets                      # upload Worker secrets
node --env-file="$DROPBOX_ROOT/env/zudo-slack-notify/credentials/sender.env" \
  cli/notify.ts --target dev --message "Hello." --kind success
```

The full walk-through, API reference, and operations guide are in the docs.

## Layout and deployments

| Unit | Directory | Worker name             | Domain                                      |
| ---- | --------- | ----------------------- | ------------------------------------------- |
| API  | `app/`    | `zudo-slack-notify-app` | https://zudo-slack-notify-app.zudolab.dev   |
| Docs | `doc/`    | `zudo-slack-notify`     | https://zudo-slack-notify.zudolab.dev       |

`skills/notify-slack/` holds the agent skill. `pnpm b4push` runs the pre-push suite.

## License

MIT
