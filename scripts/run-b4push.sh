#!/usr/bin/env bash
set -uo pipefail

# Pre-push check suite for zudo-slack-notify. Keep this sequence aligned with CI.
# Failures are collected so one run reports every broken step.

START_TIME=$(date +%s)
FAILURES=()

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

step() {
  echo ""
  echo "================================================"
  echo ">> $1"
  echo "================================================"
}

run_step() {
  local label="$1"
  shift
  step "$label"
  if (cd "$ROOT_DIR" && "$@"); then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    FAILURES+=("$label")
  fi
}

# Machine-wide queue for heavy steps, shared by every agent session on this machine
# (owner's ~/.claude or ~/.codex). Absent on CI and on other machines -> runs directly.
heavy() {
  local g="${HEAVY_GUARD:-}"
  [ -n "$g" ] || for c in "$HOME/.claude/scripts/heavy-guard.sh" "$HOME/.codex/scripts/heavy-guard.sh"; do
    [ -x "$c" ] && { g="$c"; break; }
  done
  if [ -n "$g" ] && [ -z "${CI:-}" ]; then "$g" -- "$@"; else "$@"; fi
}

run_step "Step 1/7: Install dependencies (frozen lockfile)" pnpm install --frozen-lockfile
run_step "Step 2/7: Format check"                          pnpm format:check
run_step "Step 3/7: Markdown format check"                 pnpm format:md:check
run_step "Step 4/7: Typecheck"                             pnpm typecheck
run_step "Step 5/7: Tests"                                 heavy pnpm test
run_step "Step 6/7: App workerd tests"                       heavy pnpm --filter zudo-slack-notify-app test:workerd
run_step "Step 7/7: Build"                                 heavy pnpm build

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "================================================"
echo "  SUMMARY (${DURATION}s)"
echo "================================================"

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "All checks passed. Safe to push."
  exit 0
fi

echo "${#FAILURES[@]} check(s) failed:"
for failure in "${FAILURES[@]}"; do
  echo "   - $failure"
done
exit 1
