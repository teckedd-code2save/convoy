#!/usr/bin/env bash
#
# Convoy rollback harness — end-to-end rollback verification against a real
# Fly.io app.
#
# What it does (see docs/rollback-harness.md for the full write-up):
#   1. Deploys the in-repo demo-app to Fly.io through Convoy's real pipeline
#      (`convoy ship --platform fly`, i.e. CanaryStage → PromoteStage →
#      ObserveStage against a real app).
#   2. Records the known-good release (version + image ref).
#   3. Injects a failure: deploys a deliberately broken image (every request
#      answers HTTP 500, including /health) as a new release.
#   4. Verifies the app is actually broken (the injection took).
#   5. Rolls back through Convoy's real rollback path — `convoy rollback`,
#      which runs flyRollbackPreview + flyRollback from
#      src/adapters/fly/runner.ts.
#   6. Verifies recovery: current release image == known-good image, /health
#      is 200 again, /orders serves data.
#   7. Destroys the throwaway app (unless KEEP_APP=1).
#
# The harness is opt-in by construction: preflight refuses to run without a
# working `fly auth` session, so CI (which has none) stays hermetic.
#
# Usage:
#   scripts/rollback-harness.sh
#
# Env knobs:
#   ROLLBACK_HARNESS_APP          Fly app name (default: convoy-rb-harness-<epoch>)
#   KEEP_APP=1                    leave the app running after the run (default: destroy)
#   ROLLBACK_HARNESS_BAKE_WINDOW  observe-stage bake window in seconds (default: 0)
#
# Exit codes: 0 = rollback verified end-to-end, 1 = harness failure,
# 2 = preflight/environment failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_DIR="$REPO_ROOT/scripts/rollback-harness"
DEMO_DIR="$REPO_ROOT/demo-app"

APP_NAME="${ROLLBACK_HARNESS_APP:-convoy-rb-harness-$(date +%s)}"
KEEP_APP="${KEEP_APP:-0}"
BAKE_WINDOW="${ROLLBACK_HARNESS_BAKE_WINDOW:-0}"
APP_URL="https://$APP_NAME.fly.dev"
SHIP_LOG="$(mktemp -t convoy-rh-ship).log"
BAD_DEPLOY_LOG="$(mktemp -t convoy-rh-bad).log"
APP_CREATED=0

log()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
# die [code] "message" — exit code defaults to 1; preflight failures use 2.
die() {
  local code=1
  if [[ "$1" =~ ^[0-9]+$ ]]; then code="$1"; shift; fi
  fail "$*"
  exit "$code"
}

# --- Preflight ---------------------------------------------------------------

command -v fly >/dev/null 2>&1 || die 2 "flyctl not found. Install: curl -L https://fly.io/install.sh | sh"
command -v jq  >/dev/null 2>&1 || die 2 "jq not found on PATH"
command -v curl >/dev/null 2>&1 || die 2 "curl not found on PATH"
test -d "$DEMO_DIR"  || die 2 "demo-app directory missing at $DEMO_DIR"
test -f "$HARNESS_DIR/bad.Dockerfile" || die 2 "failure-injection Dockerfile missing at $HARNESS_DIR/bad.Dockerfile"
test -x "$REPO_ROOT/node_modules/.bin/tsx" || die 2 "convoy deps not installed — run: npm install (in $REPO_ROOT)"

if ! fly auth whoami >/dev/null 2>&1; then
  die 2 "flyctl not authenticated. Run: fly auth login"
fi
if fly status --app "$APP_NAME" --json >/dev/null 2>&1; then
  die 2 "app '$APP_NAME' already exists — pick another name (ROLLBACK_HARNESS_APP) or destroy it first"
fi

log "rollback harness — app=$APP_NAME url=$APP_URL"
log "preflight ok (flyctl authenticated as $(fly auth whoami 2>/dev/null | tr -d '\n'))"

# --- Cleanup -----------------------------------------------------------------

cleanup() {
  if [[ "$KEEP_APP" == "1" ]]; then
    log "KEEP_APP=1 — leaving $APP_NAME alive. Destroy manually: fly apps destroy $APP_NAME --yes"
  elif [[ "$APP_CREATED" == "1" ]]; then
    log "cleanup — destroying $APP_NAME"
    fly apps destroy "$APP_NAME" --yes >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- Helpers -----------------------------------------------------------------

# wait_for_http <url> <expect> <retries>
# Polls until the expected condition is observed (exit 0) or retries run out
# (exit 1). expect: ok (HTTP 200) | broken (anything but HTTP 200).
wait_for_http() {
  local url="$1" expect="$2" retries="$3" code
  for _ in $(seq 1 "$retries"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
    if [[ "$expect" == "ok" && "$code" == "200" ]]; then return 0; fi
    if [[ "$expect" == "broken" && "$code" != "200" ]]; then return 0; fi
    sleep 5
  done
  return 1
}

# orders_ok <base_url> — /orders must return 200 with at least one row
orders_ok() {
  curl -s --max-time 10 "$1/orders?page=1&pageSize=5" | jq -e '.orders | length > 0' >/dev/null 2>&1
}

current_release() { fly releases --image --json --app "$APP_NAME"; }

# --- Phase 1: deploy the known-good release through Convoy --------------------

log "Phase 1/5 — deploy good release via Convoy (real Fly pipeline)"
APP_CREATED=1
(
  cd "$REPO_ROOT"
  CONVOY_NO_AUTOSPAWN=1 npm run convoy -- ship ./demo-app \
    --platform fly \
    --fly-app "$APP_NAME" \
    --fly-strategy immediate \
    --fly-bake-window "$BAKE_WINDOW" \
    --already-set=DEMO_MODE,PORT \
    --auto-approve \
    --no-real-author --no-real-rehearsal \
    --skip-onboard --skip-orient --no-ai
) >"$SHIP_LOG" 2>&1 || {
  ship_exit=$?
  echo "--- convoy ship output (tail) ---" >&2
  tail -25 "$SHIP_LOG" >&2
  die "Convoy ship did not deploy (exit $ship_exit) — see output above. Most likely a preflight blocker (e.g. fly auth)."
}

if ! wait_for_http "$APP_URL/health" ok 40; then
  echo "--- ship output (tail) ---" >&2
  tail -25 "$SHIP_LOG" >&2
  die "app never became healthy after Convoy deploy"
fi
orders_ok "$APP_URL" || die "/orders not serving after good deploy"
pass "good deploy live: $APP_URL/health"

GOOD_RELEASES="$(current_release)"
GOOD_VERSION="$(jq -r '.[0].Version' <<<"$GOOD_RELEASES")"
GOOD_IMAGE="$(jq -r '.[0].ImageRef' <<<"$GOOD_RELEASES")"
[[ "$GOOD_VERSION" =~ ^[0-9]+$ ]] || die "could not read good release version from fly releases"
[[ -n "$GOOD_IMAGE" && "$GOOD_IMAGE" != "null" ]] || die "good release has no image ref"
pass "good release: v$GOOD_VERSION image=$GOOD_IMAGE"

# --- Phase 2: inject a broken release ----------------------------------------

log "Phase 2/5 — inject failure (bad release: every request answers HTTP 500)"
(
  cd "$HARNESS_DIR"
  fly deploy -c "$DEMO_DIR/fly.toml" --app "$APP_NAME" \
    --dockerfile bad.Dockerfile \
    --strategy immediate --wait-timeout 45s --yes --remote-only
) >"$BAD_DEPLOY_LOG" 2>&1 && die "bad deploy unexpectedly succeeded — failure injection failed"

log "bad deploy exited non-zero as expected (release created, app now broken)"
if ! wait_for_http "$APP_URL/health" broken 30; then
  die "app still healthy after bad release — failure injection did not take"
fi

BAD_RELEASES="$(current_release)"
BAD_VERSION="$(jq -r '.[0].Version' <<<"$BAD_RELEASES")"
BAD_IMAGE="$(jq -r '.[0].ImageRef' <<<"$BAD_RELEASES")"
[[ -n "$BAD_IMAGE" && "$BAD_IMAGE" != "null" ]] || die "bad release has no image ref (was a new release created?)"
[[ "$BAD_IMAGE" != "$GOOD_IMAGE" ]] || die "bad release image equals good image — no new release was created"
pass "failure injected: v$BAD_VERSION image=$BAD_IMAGE is current, /health no longer 200"

# --- Phase 3: roll back through Convoy's real rollback path -------------------

log "Phase 3/5 — rollback via Convoy CLI (flyRollbackPreview + flyRollback)"
(
  cd "$REPO_ROOT"
  CONVOY_NO_AUTOSPAWN=1 npm run convoy -- rollback "$APP_NAME" -y
) || die "convoy rollback failed (exit $?)"

# --- Phase 4: verify recovery -------------------------------------------------

log "Phase 4/5 — verify previous known-good release restored"
wait_for_http "$APP_URL/health" ok 60 || die "health not restored after rollback"
pass "/health is 200 again"

orders_ok "$APP_URL" || die "/orders not serving after rollback"
pass "/orders serving data again"

RESTORED_RELEASES="$(current_release)"
RESTORED_VERSION="$(jq -r '.[0].Version' <<<"$RESTORED_RELEASES")"
RESTORED_IMAGE="$(jq -r '.[0].ImageRef' <<<"$RESTORED_RELEASES")"
RESTORED_STATUS="$(jq -r '.[0].Status' <<<"$RESTORED_RELEASES")"
[[ "$RESTORED_IMAGE" == "$GOOD_IMAGE" ]] \
  || die "current image $RESTORED_IMAGE != known-good image $GOOD_IMAGE — rollback did NOT restore the good release"
[[ "$RESTORED_STATUS" == "complete" ]] \
  || die "current release status is '$RESTORED_STATUS', expected 'complete'"
[[ "$RESTORED_VERSION" -gt "$BAD_VERSION" ]] \
  || die "expected rollback to create a new release above v$BAD_VERSION, got v$RESTORED_VERSION"
pass "release v$RESTORED_VERSION (status=$RESTORED_STATUS) carries the known-good image"

# --- Phase 5: report ----------------------------------------------------------

log "Phase 5/5 — result"
printf '\n\033[1;32m%s\033[0m\n' "ROLLBACK HARNESS PASSED — $APP_NAME"
printf '  good release : v%s  %s\n' "$GOOD_VERSION" "$GOOD_IMAGE"
printf '  bad release  : v%s  %s\n' "$BAD_VERSION" "$BAD_IMAGE"
printf '  after rollback: v%s (status=%s) — image restored, /health 200, /orders serving\n' \
  "$RESTORED_VERSION" "$RESTORED_STATUS"
printf '  url          : %s\n' "$APP_URL"
