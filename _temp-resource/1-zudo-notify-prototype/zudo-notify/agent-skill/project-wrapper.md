# Keep the release wrapper project-specific

The generic `notify-slack` skill should not learn every repository's npm commands. Make a thin project wrapper, or add one step to an existing release skill:

1. Follow the project's real candidate/staging workflow.
2. Wait for the actual checks and staging result.
3. Gather exact package name, candidate version, commit, verified check results, and the next human action.
4. Write a JSON notification with `target: "releases"`, `kind: "action_required"`, and truthful details.
5. Invoke `notify-slack` and save its receipt/status in the release task's existing local record.
6. Keep waiting for the original approval gate. Notification failure does not change candidate state; notification success does not approve publication.
7. Once the real workflow confirms publication, optionally send a `success` follow-up in the original thread if the original receipt exists.

The included `examples/npm-approval.json` illustrates the shape. Every example value must be replaced by actual facts. Do not copy “checks passed” as an assumption. If there is no useful browser URL, omit `links` and state which project/terminal session needs attention.

## Portable local setup

Keep one checkout of `zudo-notify` and set `ZUDO_NOTIFY_ROOT` in the shell environment used by local agents. The generic skill is short and contains no secrets or fixed filesystem path. The sender imports the same validation code as the Worker, so skill text does not need to reimplement the API contract.

Use your own existing Codex/Claude Code skill setup when placing the template as `SKILL.md`. This handoff does not install or overwrite a personal skill. If your wrapper has a different name, its description should say when to use it and refer to the generic skill for sending.

## What this prototype cannot infer

The notify service does not know which npm staging system you use or how manual acceptance resumes publishing. That adapter must be finished against the real local project. A Slack message can notify you of a browser or terminal gate, but it does not add remote approval to a workflow that does not already expose it.
