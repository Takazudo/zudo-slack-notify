# Verification record

Prepared 2026-09-28 JST. No Cloudflare deployment, real Slack message, npm publication, or personal-skill installation was performed.

## Completed checks

| Check | Result |
| --- | --- |
| Strict TypeScript (`tsc --noEmit`) | Passed for Worker, shared renderer, CLI and Node tests |
| Node test suite (`node --test tests/*.test.ts`) | **37 tests passed, 0 failed** |
| Wrangler dry-run build | Passed; generated the production Worker bundle locally |
| Actual workerd integration through pinned Miniflare | **7 tests passed, 0 failed**, including the containing suite |
| Example payloads | JSON parsed; representative CLI dry run and all four preview presets passed the shared validator/renderer |
| Preview source and input handling | Inline JS syntax checked; four presets validated and eleven invalid/boundary cases rejected |
| Browser preview QA | Passed in headless Chromium at 1440px and 390px widths; four presets, actual shared validation, literal markup, invalid links, JSON download, no horizontal mobile overflow, no page errors or unexpected requests |
| Documentation/configuration | Relative document links, JSON examples and TOML checked |
| Archive | Source and lockfile included; dependencies, local state, secrets and temporary research excluded |

## What the tests establish

The tests exercise auth-before-egress, fail-closed configuration, own-property destination resolution, strict body/schema limits, UTF-8 rejection, literal text/mention handling, safe link syntax, post-escape Slack limits, and thread timestamps. They verify success only after a real-shaped receipt, distinguish explicit rejection from uncertainty, and cover network errors, a deadline while reading the response, malformed/oversized upstream responses, and complete rate-limit delays.

The sender tests also exercise actual CLI dry runs, malformed input, redirects, false-success receipts, token redaction and preservation of numeric rate delays too large for a safe JavaScript integer.

The workerd test loads `dist/index.js` in a real Workers runtime. Every outgoing fetch is intercepted by Miniflare's `outboundService`; it has **no network fallback**. It covers missing auth, two separate successful invocations, rate limiting, malformed JSON, malformed receipt, and a redirect that must not be followed.

## A real runtime issue found and corrected

The pinned workerd `1.20260424.1` rejects `redirect: "error"` before an outgoing request begins, although Node accepts it. The initial Node tests could not reveal that incompatibility. The Worker now uses `redirect: "manual"` and rejects 3xx responses explicitly; its Slack token is never forwarded to a redirected host. The CLI continues to use Node's `redirect: "error"`.

This is a finding about the pinned local runtime, not a claim that every current Cloudflare runtime has the same limitation. The direct native-fetch workerd test protects the relevant behavior when tooling is updated.

## Remaining local checks

1. Install/configure the Slack app and chosen channels; test one intentional message and inspect its real rendering.
2. Confirm the desired channel/device notification behavior. A Slack message receipt cannot establish a phone notification or human attention.
3. Exercise one parent notification and one reply in the real workspace.
4. Integrate the notifier into the actual npm staging workflow and confirm it reaches the right human-attention step.
5. Inspect actual Slack rendering on your devices. The offline composer passed desktop/mobile browser checks, but its visual layout is explicitly an approximation of Slack rather than a capture from a real workspace.

No live end-to-end result is claimed. The prototype can be finalized locally using `docs/LOCAL-HANDOFF.md` and `docs/SETUP.md`.
