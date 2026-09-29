# Design decisions

## The boundary

The API delivers a notification to a named destination. It knows nothing about npm publishing, the current agent session, source code, or the approval state of a release. A local workflow turns its real status into a small JSON message.

This permits reuse across repositories without making the relay into another bot application. A new use case usually needs another payload, not another Worker endpoint.

## Why a Worker-owned Slack bot token

Your API defines a stable interface and keeps Slack credentials in one place. Local callers receive the narrower relay credential, so they cannot invoke arbitrary Slack APIs with it. The first version has one shared caller credential and one workspace; every holder can use every configured destination. Split credentials and destination permissions only when you need different trust levels.

Use a Slack app with `chat:write`, invite the bot to chosen channels, and call `chat.postMessage` with a channel ID. It returns a `ts` that can be used for a later thread reply. These are sufficient capabilities for this workflow. [Slack method reference](https://docs.slack.dev/reference/methods/chat.postMessage/)

An incoming webhook is a reasonable smaller option for one permanently fixed channel. Its channel is fixed by installation and it does not return the posted message's `ts`. Since this request includes multiple small use cases and specified destinations, a single bot token plus aliases is the more flexible foundation. [Incoming webhook behavior](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)

## Why synchronous and stateless

The agent can wait a few seconds for the result. Awaiting Slack makes the response meaningful and avoids deploying a queue, scheduler, or database for a low-volume personal service. The Worker makes exactly one Slack attempt per valid request. It returns a receipt only after validating Slack's acknowledgement.

Slack's three-second acknowledgement requirement concerns incoming Slack callbacks, which this API does not receive. The only delivery attempt should not run after a premature success response in `waitUntil`. Cloudflare background work has a limited lifetime. [Worker context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

The tradeoff is explicit: no offline buffering, persistent history, request deduplication, rate queue, or automatic recovery. Slack is the visible history. A network timeout can happen after Slack accepted a message, so an automatic retry can duplicate it. `requestId` identifies an API attempt and is not an idempotency key.

## What was borrowed from the references

| Reference | Retained idea | Scope decision |
| --- | --- | --- |
| Slack wisdom | Native fetch, bot token as secret, stable channel IDs, message fallback, careful rate limits | A posting-only integration does not need the signing secret described for inbound callbacks |
| Cloudflare wisdom | Standalone module Worker, explicit config, exact tooling pins, fail closed until configured | No framework, database, or deployment UI required |
| zmod-bot | Small native-fetch Slack client, validation of Slack `ok`, channel and timestamp, injectable transport | Its event receiver, LLM execution, D1 job state, and cron retries serve a different workflow |

One retry detail was deliberately corrected instead of copied: `zmod-bot` caps a Slack `Retry-After` wait at two seconds. This notifier returns the full valid delay, because waiting less would retry sooner than Slack requested. It never sleeps and retries inside the Worker. [Reviewed API client](https://github.com/zudolab/zmod-bot/blob/c6e4e3ce32d5c1319c0edd7423bcc4c348ce7256/src/slack/api.ts)

## Message representation

Callers provide a title, body, kind, optional source label, small label/value fields, and links. The Worker constructs Slack blocks. Caller text is literal and there are no raw Block Kit or mention controls in v1. This keeps task text from turning into an accidental `@channel` announcement and gives different callers a consistent message shape.

Links are HTTPS, have separate labels, and are rendered as normal links. There are no approval buttons or callbacks. This keeps configuration small and avoids suggesting that clicking something has approved a release. The top-level text includes the notification's content for fallback and accessibility. [Slack formatting](https://docs.slack.dev/messaging/formatting-message-text/), [Text objects](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/)

`source` is supplied by the caller for readability; it is not a verified identity. A `success` notification is likewise the agent's claim, not an independently verified build result.

## Local agent skill architecture

Use a generic `notify-slack` skill that accepts the event facts and configured target. A project-specific wrapper knows the release procedure, the exact stage that needs human attention, and any review URL. For example:

1. Project release skill prepares the candidate and completes its checks.
2. It records the actual package/version/commit and approval location.
3. It invokes `notify-slack` once for the `releases` target.
4. It records the returned receipt or the delivery problem in its own session state.
5. It continues or pauses according to the existing release process.

The notification skill never interprets `sent` as permission to publish. A Slack reply, emoji reaction, or elapsed time is not observed by this API, so none can unblock an agent through this implementation.

## Sensible later additions

Add these only after a concrete need appears:

| Need | Next change |
| --- | --- |
| Different projects need different channel permissions | Per-caller tokens with target allowlists and rotation |
| More simultaneous notifications | A queue with rate scheduling and explicit accepted-versus-delivered semantics |
| Retry safely after known local retries/restarts | A durable request ledger with payload hashes and duplicate policy; still acknowledge the external side-effect uncertainty |
| Approve releases within Slack | A separate verified interactivity endpoint, authorized approver identities, immutable candidate binding, expiry/replay protection, and an actual agent/CI continuation mechanism |
| Update one long-running task's message | A restricted update endpoint that owns/records message receipts |
| Multiple workspaces | Per-destination workspace credentials, without widening the caller's API surface |

A local retry log can reduce accidental resends from one agent but does not provide global idempotency. Likewise, simply adding KV does not create an atomic lock across Worker locations. Your Cloudflare wisdom's ledger discussion explains the remaining external-write gap even with durable coordination. [Idempotency ledger](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/956e1b298ee346d929b0bae18cd16930adaf68b2/src/content/docs/recipes/idempotency-ledger.mdx)
