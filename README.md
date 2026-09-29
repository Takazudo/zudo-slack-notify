# zudo-slack-notify

A personal Slack notification service. A stateless, authenticated Cloudflare Worker API posts
messages to Slack channels selected by alias, a Node CLI and a Claude Code agent skill send them,
and a zudo-doc site documents the whole thing.

## Architecture

```text
agent (Claude Code skill)
  -> CLI (Node)
    -> Worker API (POST /v1/notify)
      -> Slack (chat.postMessage)

docs site (zudo-doc) -> static assets on Cloudflare
```

## Deployments

| Unit | Directory | Worker name            | Domain                                      |
| ---- | --------- | ---------------------- | ------------------------------------------- |
| API  | `app/`    | `zudo-slack-notify-app` | https://zudo-slack-notify-app.zudolab.dev |
| Docs | `doc/`    | `zudo-slack-notify`     | https://zudo-slack-notify.zudolab.dev     |

Documentation: https://zudo-slack-notify.zudolab.dev

## License

MIT
