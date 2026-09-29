#!/usr/bin/env bash
# Post-deploy smoke checks against a deployed origin. There are no built-in origins.
#   scripts/smoke.sh app|doc
# Env:
#   APP_BASE_URL                         required for `app`: the deployed API origin
#   DOC_BASE_URL                         required for `doc`: the deployed docs origin
# Env (optional):
#   SLACK_WIRED                          "true" once Slack is wired: only 401 passes on POST /v1/notify
#   SMOKE_RETRY_WINDOW_SECONDS           first-deploy tolerance window (default 120)
#   SMOKE_RETRY_INTERVAL_SECONDS         pause between attempts (default 5)
set -uo pipefail

APP_BASE_URL="${APP_BASE_URL:-}"
DOC_BASE_URL="${DOC_BASE_URL:-}"
WINDOW="${SMOKE_RETRY_WINDOW_SECONDS:-120}"
INTERVAL="${SMOKE_RETRY_INTERVAL_SECONDS:-5}"
SLACK_WIRED="${SLACK_WIRED:-}"

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

command -v curl >/dev/null || fail "curl is required"
command -v jq >/dev/null || fail "jq is required"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

START=$SECONDS
# Latch: set on the first real answer. From then on no failure is tolerated.
ANSWERED=0
STATUS=000
BODY=""
CURL_RC=0

# http METHOD URL -> sets STATUS, BODY, CURL_RC
http() {
  local method="$1" url="$2"
  STATUS="$(curl -sS --max-time 15 -X "$method" --data '' -o "$TMP_DIR/body" -w '%{http_code}' "$url" 2>"$TMP_DIR/err")"
  CURL_RC=$?
  BODY="$(cat "$TMP_DIR/body" 2>/dev/null || true)"
}

# The Worker's own JSON envelope (healthz or failure). Edge errors (Cloudflare
# 1104, HTML 5xx, connection failures) never carry it.
worker_answered() {
  [ "$CURL_RC" -eq 0 ] && jq -e '.ok | type == "boolean"' >/dev/null 2>&1 <<<"$BODY"
}

# probe METHOD URL PREDICATE: retry until PREDICATE (a real answer) or the window ends.
probe() {
  local method="$1" url="$2" predicate="$3"
  while true; do
    http "$method" "$url"
    if "$predicate"; then
      ANSWERED=1
      return 0
    fi
    if [ "$ANSWERED" -eq 1 ]; then
      fail "$method $url stopped answering after the host was already up (curl rc=$CURL_RC, status=$STATUS)"
    fi
    if [ $((SECONDS - START)) -ge "$WINDOW" ]; then
      fail "$method $url never produced a real answer within ${WINDOW}s (curl rc=$CURL_RC, status=$STATUS)"
    fi
    echo "waiting for $url (curl rc=$CURL_RC, status=$STATUS); retrying in ${INTERVAL}s"
    sleep "$INTERVAL"
  done
}

status_is_200() { [ "$CURL_RC" -eq 0 ] && [ "$STATUS" = "200" ]; }

smoke_app() {
  [ -n "$APP_BASE_URL" ] || fail "APP_BASE_URL is required (the deployed API origin)"
  echo "checking app origin: $APP_BASE_URL"
  probe GET "$APP_BASE_URL/healthz" worker_answered
  [ "$STATUS" = "200" ] || fail "GET /healthz returned $STATUS, expected 200"
  jq -e '.ok == true and .service == "zudo-slack-notify"' >/dev/null <<<"$BODY" \
    || fail "GET /healthz body is not { ok: true, service: \"zudo-slack-notify\" }"
  echo "ok: GET /healthz"

  probe POST "$APP_BASE_URL/v1/notify" worker_answered
  local code
  code="$(jq -r '.error.code // ""' <<<"$BODY")"
  case "$STATUS" in
    401)
      echo "ok: unauthenticated POST /v1/notify -> 401" ;;
    503)
      if [ "$SLACK_WIRED" = "true" ]; then
        fail "POST /v1/notify returned 503 but SLACK_WIRED=true; Worker secrets were lost or never set"
      fi
      [ "$code" = "server_misconfigured" ] || fail "POST /v1/notify returned 503 with error code '$code'"
      echo "ok: unauthenticated POST /v1/notify -> 503 server_misconfigured (SLACK_WIRED is not true)" ;;
    2??)
      fail "unauthenticated POST /v1/notify returned $STATUS; it must never succeed" ;;
    *)
      fail "unauthenticated POST /v1/notify returned $STATUS (error code '$code'), expected 401" ;;
  esac
}

smoke_doc() {
  [ -n "$DOC_BASE_URL" ] || fail "DOC_BASE_URL is required (the deployed docs origin)"
  echo "checking doc origin: $DOC_BASE_URL"
  probe GET "$DOC_BASE_URL/" status_is_200
  grep -q 'zudo-slack-notify' <<<"$BODY" || fail "GET / has no site marker 'zudo-slack-notify'"
  echo "ok: GET / -> 200 with site marker"

  http GET "$DOC_BASE_URL/__smoke-unknown-path-$$"
  [ "$CURL_RC" -eq 0 ] || fail "unknown-path request failed after the host was up (curl rc=$CURL_RC)"
  [ "$STATUS" = "404" ] || fail "unknown path returned $STATUS, expected 404"
  echo "ok: unknown path -> 404"
}

case "${1:-}" in
  app) smoke_app ;;
  doc) smoke_doc ;;
  *) echo "usage: scripts/smoke.sh app|doc" >&2; exit 2 ;;
esac
echo "SMOKE PASS: ${1}"
