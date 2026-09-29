# Keep the release wrapper project-specific

The generic `notify-slack` skill should not learn every repository's npm commands. Make a thin project wrapper, or add one step to an existing release skill:

1. Follow the project's real candidate/staging workflow.
2. Wait for the actual checks and staging result.
3. Gather exact package name, candidate version, commit, verified check results, and the next human action.
4. Write a JSON notification with `target: "releases"`, `kind: "action_required"`, and truthful details.
5. Invoke `notify-slack` and save its receipt/status privately in the release task's existing local record. The receipt contains the channel ID, so keep it out of public text.
6. Keep waiting for the original approval gate. Notification failure does not change candidate state; notification success does not approve publication.
7. Once the real workflow confirms publication, optionally send a `success` follow-up in the original thread if the original receipt exists.

`app/examples/npm-approval.json` illustrates the shape. Every example value must be replaced by actual facts. Do not copy "checks passed" as an assumption. If there is no useful browser URL, omit `links` and state which project/terminal session needs attention.

## Portable local setup

Keep one checkout of `zudo-slack-notify` and set `ZUDO_SLACK_NOTIFY_ROOT` in the shell environment used by local agents. Keep the sender credentials in an env file outside the repo (default `$DROPBOX_ROOT/env/zudo-slack-notify/credentials/sender.env`) holding `ZUDO_SLACK_NOTIFY_URL` and `ZUDO_SLACK_NOTIFY_API_KEY`, and load it with `node --env-file`. The generic skill is short and contains no secrets or fixed filesystem path. The sender imports the same validation code as the Worker, so skill text does not need to reimplement the API contract.

Install the skill by placing or linking `skills/notify-slack/` into your own Codex/Claude Code skill setup. This repository does not install or overwrite a personal skill. If your wrapper has a different name, its description should say when to use it and refer to the generic skill for sending.

## What this cannot infer

The notify service does not know which npm staging system you use or how manual acceptance resumes publishing. That adapter must be finished against the real local project. A Slack message can notify you of a browser or terminal gate, but it does not add remote approval to a workflow that does not already expose it.
