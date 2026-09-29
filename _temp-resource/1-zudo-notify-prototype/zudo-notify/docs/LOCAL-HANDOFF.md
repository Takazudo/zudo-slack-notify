# Local agent handoff

## Objective

Finalize this small prototype as Takeshi's reusable notification service. A local AI agent invokes a skill, the skill runs a sender, and the sender posts through one authenticated Cloudflare Worker to a configured Slack channel. npm staging awaiting manual acceptance is the first use case. Future tiny cases should reuse the same payload/API.

The user explicitly asked for downloadable prototypes to finalize locally. This project was not deployed, connected to Slack, installed as a skill, or published as an npm package during preparation.

## Concrete decisions already made

- Working name `zudo-notify`; change it freely before deployment.
- Native TypeScript module Worker and native `fetch`; zero runtime dependencies.
- `POST /v1/notify` and public handler liveness at `GET /healthz`.
- One bearer key initially; aliases `releases` / `dev` map to configured channel IDs.
- Single Slack app/workspace initially; minimal `chat:write` scope and explicit channel membership.
- Synchronous one-attempt delivery, structured sent/not-sent/unknown result.
- Plain text plus small fields and links; optional thread continuation.
- No persistent state, deduplication, queue, update API, Slack-native approvals, or agent execution on the server.
- Sender CLI and skill template keep Slack credentials away from ordinary caller projects.
- The local release workflow remains authoritative for approval and actual publishing.

## Read in order

1. `README.md` and `docs/DESIGN.md` for the boundary and tradeoffs.
2. `src/notification.ts`, then `src/index.ts` and `cli/notify.ts`.
3. `docs/API.md` and tests to see the precise contract.
4. `docs/SETUP.md` for the deployment sequence.
5. `agent-skill/notify-slack.template.md` and `agent-skill/project-wrapper.md`.

All reference revisions are pinned in `docs/SOURCES.md`. The references supplied by the user were reviewed, not used as code to modify remotely.

## Finish locally

### A. Confirm the few real environment choices

Resolve the Slack workspace/channel(s), bot installation, Cloudflare account, deployed Worker name, and desired aliases. Keep the shared-key design if all callers are your own trusted agents. If you will distribute a key to a service or person with a narrower scope, add per-key target restrictions before giving them access.

### B. Verify and configure

Run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workerd
node cli/notify.ts --file examples/npm-approval.json --dry-run
```

Review `prototype/index.html`. It is an offline shape/layout aid, not a web administration surface. No frontend framework or hosting is necessary.

Replace target IDs and configure both Worker secrets using the coherent bootstrap sequence in SETUP.md. After deployment, send one explicit setup message to the chosen channel. Verify phone notification preferences if mobile attention is the purpose.

### C. Wire the actual npm staging boundary

The exact publishing workflow was not provided. The prototype intentionally does not invent an npm command, approval API, dist-tag rule, CI environment name, or release URL. Inspect the local project that will use it and identify what “staging ready / manually accept” means there.

Possible boundaries include a prepared local candidate, a CI approval gate, a staged publishing service, or a browser authentication step. These are different states. Put the notification at the actual human-attention boundary and use the exact URL or return-to-terminal instruction from that workflow.

The message should include factual package/version/commit information, checks actually completed, and the action you need to take. A tarball or candidate review should refer to a fixed commit/version rather than a moving branch. Do not describe a build as passing before the result exists.

Only attach stable, shareable review links. Do not automatically scrape and broadcast one-time authentication URLs, OTPs, tokens, or private terminal logs. If the gate only exists in the local terminal, say which project/session needs attention; the relay cannot make that terminal remotely approvable.

### D. Install the local skill and wrapper

Use the supplied template with your established Codex/Claude Code skill layout. Set `ZUDO_NOTIFY_ROOT` to this project's absolute path and expose only the endpoint plus relay key to caller sessions. Keep the generic skill independent of one project's release commands. A wrapper in each release project decides when to call it and records the receipt.

Test the wrapper with `--dry-run`, then one real notification. Do not add automatic publication after a notification succeeds. The user's actual publishing approval must remain the continuation condition.

## Meaningful acceptance criteria

- An agent can post a two-field JSON request using only endpoint + relay key.
- Missing/incorrect auth, empty target maps, unknown aliases and malformed inputs cannot reach Slack.
- The exact configured channel receives a readable notification with useful mobile fallback text.
- A successful post returns a usable `ts`; a reply with the same target and that timestamp lands in the thread.
- Known Slack rejections fail clearly; malformed responses and timeouts never become success.
- A Slack rate limit preserves its full delay; neither sender nor Worker automatically reposts uncertain requests.
- The release wrapper stops/continues based on the actual release workflow, never the notification result alone.
- No real credentials are committed or included in the reusable skill's content.

## Deferred changes

Keep future growth proportional. The first useful additions are likely per-project wrapper skills and additional example payloads. Add a queue or ledger when actual lost notifications/retries become a problem. Building approval buttons is a separate feature with identity checks and a real continuation protocol; the current API cannot observe Slack replies or reactions.

## Suggested opening prompt for your local AI agent

> Read README.md, docs/LOCAL-HANDOFF.md and docs/API.md in this prototype. Run the checks and inspect the implementation. Finalize it as my small Cloudflare Worker Slack notification service. Keep it generic and stateless initially. Configure the real target aliases and secrets with my existing local tooling, and integrate the notification at the human approval boundary in my actual npm staging workflow. Use the portable notify-slack skill template for the sender and a project-specific wrapper for release logic. Do not infer publish permission from a successful Slack notification. Preserve the explicit unknown-delivery behavior and avoid automatic retries that can duplicate messages.
