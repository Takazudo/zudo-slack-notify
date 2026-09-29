# zudo-slack-notify

Personal Slack notification service: Cloudflare Worker API (`app/`), Node CLI, agent skill, and a
zudo-doc site (`doc/`). Public repo.

## Layout

```text
app/                 Worker API + CLI (Worker: zudo-slack-notify-app)
doc/                 zudo-doc site (Worker: zudo-slack-notify)
scripts/             repo scripts (run-b4push.sh)
_temp-resource/      reference prototype, deleted before the root PR merges
worktrees/           x-wt-teams worktrees (gitignored)
pnpm-workspace.yaml  workspace members + pnpm settings (root-only)
```

## Commands

pnpm workspace (pnpm 11, Node 24). Scripts fan out with `pnpm -r --if-present`.

- `pnpm install` - install (runs `lefthook install`)
- `pnpm build` / `pnpm test` / `pnpm typecheck` - run in every member that defines them
- `pnpm format` / `pnpm format:check` - Prettier
- `pnpm format:md` / `pnpm format:md:check` - `@takazudo/mdx-formatter` for md/mdx
- `pnpm test:ops` - vitest for the root `scripts/` (ops secret-push script, smoke script); `pnpm test` runs it plus the member suites (the app workerd suite is separate: `pnpm --filter zudo-slack-notify-app test:workerd`)
- `pnpm ops:push-secrets [--env-file <path>] [--dry-run]` - upload Worker runtime secrets from the operator store (`scripts/push-worker-secrets.mjs`)
- `bash scripts/smoke.sh app|doc` - post-deploy smoke checks (run by the deploy workflows)
- `pnpm b4push` - full pre-push suite (`scripts/run-b4push.sh`)

## Deploy

| Unit | Dir    | Worker name             | Domain                               |
| ---- | ------ | ----------------------- | ------------------------------------ |
| API  | `app/` | `zudo-slack-notify-app` | `zudo-slack-notify-app.zudolab.dev` |
| Docs | `doc/` | `zudo-slack-notify`     | `zudo-slack-notify.zudolab.dev`     |

The domain is `zudolab.dev` (not `zudlab.dev`). Deploys run from GitHub Actions (`deploy-app.yml`, `deploy-doc.yml`, main only, skipped cleanly when the Cloudflare credentials are absent) to custom domains.

## Secrets policy

This repo is public. No tokens, relay keys, Slack channel IDs, Cloudflare account IDs, or emails in
git, issues, PRs, or logs. Secrets live only in Cloudflare Worker secrets, GitHub repo secrets
(Cloudflare deploy credentials only), and the operator store at
`$DROPBOX_ROOT/env/zudo-slack-notify/`.

## Traps

- wrangler TOML: top-level scalars must come before any `[table]`, or they get swallowed into it.
- wrangler `routes` are inherited into `[env.*]` sections; override or clear them per env.
