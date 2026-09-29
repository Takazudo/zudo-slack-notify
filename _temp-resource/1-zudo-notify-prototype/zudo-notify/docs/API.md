# API contract v1

## Endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /healthz` | Public handler liveness. No Slack request and no credential/configuration details. |
| `POST /v1/notify` | Authenticated synchronous notification delivery. |

Only the documented methods are accepted. There is no browser CORS integration, raw Slack proxy, batch API, approval endpoint, or callback receiver in this version.

## Request authentication and content

Use `Authorization: Bearer <NOTIFY_API_KEY>` and `Content-Type: application/json` (optionally `; charset=utf-8`). Send a UTF-8 JSON object of at most **16 KiB**. The Worker counts streamed bytes even if `Content-Length` is absent or incorrect. Compressed input is rejected. Do not put the bearer key in the URL or JSON body.

The service checks its configuration and the bearer key before parsing the body or calling Slack. A valid key permits all aliases configured on that Worker. An unknown alias is rejected; raw Slack channel IDs are not accepted as an override.

## Notification shape

| Field | Required | Rules |
| --- | --- | --- |
| `target` | Yes | Lowercase alias, starts with a letter; letters/digits with single interior hyphens; max 64 characters; must exist in `SLACK_TARGETS` |
| `message` | Yes | Nonblank literal text; max 2,000 characters |
| `title` | No | Nonblank literal text; max 120 characters |
| `kind` | No | `info` (default), `success`, `warning`, `error`, `action_required` |
| `source` | No | Nonblank project/agent label; max 100 characters; caller-supplied, not verified identity |
| `fields` | No | Up to 6 objects, each exactly `{ label, value }`; label max 60, value max 300; both nonblank |
| `links` | No | Up to 3 objects, each exactly `{ label, url }`; label max 60 and no pipe/newline; HTTPS URL max 500 before and after normalization, without credentials, whitespace, backslashes or Slack link delimiters |
| `threadTs` | No | Parent Slack timestamp string, 10–16 digits, dot, 6 digits; use the same target as the parent receipt |

Unknown fields, `null` in place of strings, blank optional strings, and unsupported control characters are rejected. Empty `fields` and `links` arrays are allowed. Text limits are JavaScript string lengths (UTF-16 code units); some emoji occupy two code units. The renderer also checks actual Slack limits after escaping, so text containing many `&`, `<`, or `>` characters can reach the rendered limit before the input limit.

Link URLs are destinations shown to the reader; the Worker never fetches them. Send stable, non-secret review/preview links. Do not forward a credential-bearing login or approval token URL from a terminal into Slack without an explicit decision that it is suitable for that channel.

Example:

```json
{
  "target": "releases",
  "kind": "action_required",
  "title": "npm staging is ready for review",
  "message": "Please review the prepared release and complete the existing manual approval step.",
  "source": "example-project / local agent",
  "fields": [
    { "label": "Package", "value": "@takazudo/example-package" },
    { "label": "Version", "value": "0.0.0-example" }
  ],
  "links": [
    { "label": "Open review", "url": "https://example.com/releases/review" }
  ]
}
```

Those are illustrative package/version/URL values, not information collected from a real release.

## Success

HTTP `200`:

```json
{
  "ok": true,
  "delivery": "sent",
  "requestId": "b7b2ae34-a066-435a-9a38-1a0d216ba123",
  "target": "releases",
  "channel": "C0123456789",
  "ts": "1700000000.000001"
}
```

The Worker validates HTTP success, Slack's `ok: true`, the exact expected channel, and a timestamp string. `sent` means Slack accepted the message, not that it was read or a release approved. `requestId` is a fresh UUID per API attempt, also returned in `X-Request-Id`; it is not a duplicate-suppression key.

For a later update in a thread, submit a new notification with the same `target` and the original receipt's `ts` as `threadTs`. A threaded reply is not broadcast to the channel timeline. Use the parent timestamp, not a reply timestamp. There is no separate permission lookup for an arbitrary parent within a configured channel; the key is trusted for that destination.

## Errors and delivery state

```json
{
  "ok": false,
  "delivery": "unknown",
  "requestId": "b7b2ae34-a066-435a-9a38-1a0d216ba123",
  "error": {
    "code": "slack_timeout",
    "message": "Slack did not confirm delivery before the deadline. Delivery is unknown; check the channel before retrying."
  },
  "retryable": false
}
```

| HTTP | Typical error code | Delivery | Caller action |
| --- | --- | --- | --- |
| 400 | `invalid_json`, `invalid_request`, `rendered_message_too_long` | `not_sent` | Fix the payload |
| 401 | `unauthorized` | `not_sent` | Fix the relay key |
| 403 | `target_not_allowed` | `not_sent` | Use a configured alias |
| 404 / 405 | `not_found`, `method_not_allowed` | `not_sent` | Correct URL/method |
| 413 | `payload_too_large` | `not_sent` | Shorten the JSON body |
| 415 | `unsupported_media_type`, `unsupported_content_encoding` | `not_sent` | Send uncompressed UTF-8 JSON |
| 429 | `slack_rate_limited` | `not_sent` | Wait the full returned delay before a deliberate retry |
| 500 | `internal_error` before dispatch | `not_sent` | Inspect server implementation |
| 503 | `server_misconfigured`, `auth_unavailable` | `not_sent` | Fix server configuration/auth availability |
| 502 | `slack_rejected` for recognized explicit rejection | `not_sent` | Fix Slack app/token/channel/request |
| 502 | `slack_network_error`, `slack_invalid_response`, `slack_delivery_unknown` | `unknown` | Inspect Slack before resending |
| 504 | `slack_timeout` | `unknown` | Inspect Slack before resending |

`not_sent` means no dispatch occurred or Slack gave a recognized explicit rejection. `unknown` means the service cannot safely determine whether a message was posted. The Worker never exposes raw upstream bodies or credentials. It names known Slack rejection codes in the diagnostic message; unrecognized Slack errors are conservatively treated as uncertain.

The upstream deadline is 10 seconds and covers both fetch and response parsing. Slack redirects are not followed. The HTTP client in the local CLI has a 20-second deadline, allowing room for the Worker to return its own error.

## Rate limits and retries

A confirmed rate limit includes `Retry-After` and ordinarily a numeric `retryAfterSeconds`:

```json
{
  "ok": false,
  "delivery": "not_sent",
  "requestId": "b7b2ae34-a066-435a-9a38-1a0d216ba123",
  "error": { "code": "slack_rate_limited", "message": "Wait before retrying." },
  "retryable": true,
  "retryAfterSeconds": 37
}
```

The full valid header is preserved. If it is absent/malformed, the fallback is 60 seconds. Exceptionally large numeric values remain in the header as text; the Worker omits `retryAfterSeconds` if a JavaScript number cannot represent the value exactly. The CLI retains that header as `retryAfter`, so it does not invent a shorter wait. HTTP-date headers are supported too.

`retryable: true` is permission to retry after the stated delay, not evidence that the Worker or CLI already scheduled a retry. Neither does automatic retries. Use at most a deliberate, bounded retry in a wrapper, and never retry an unknown delivery automatically. Sending duplicate JSON creates duplicate posts; even an `Idempotency-Key` header has no effect in v1.

## CLI output and exit status

Use `node cli/notify.ts --help` for options. Successful results go to stdout as JSON. Local input/configuration errors go to stderr and do not send a request. The CLI suppresses unrecognized proxy/HTML responses and reports uncertainty.

| Exit | Meaning |
| --- | --- |
| 0 | Valid delivery receipt, or completed `--dry-run` |
| 1 | API rejected the request, known not sent |
| 2 | Local input/configuration error, not sent |
| 3 | Confirmed rate limit; no automatic retry |
| 4 | Delivery unknown; inspect Slack before resending |

Distinguish a dry run's `dryRun: true` object from a live `delivery: "sent"` receipt. Dry runs do not resolve real channels or verify app membership.
