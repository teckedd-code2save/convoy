# Rollback Harness — end-to-end rollback verification on a real Fly.io app

Closes PENDINGS **Critical #3**: the Fly.io rollback path (`src/adapters/fly/runner.ts` →
`flyRollbackPreview` / `flyRollback`, exposed via `convoy rollback`) was never tested
against a real app deployed by Convoy. Scripted mode used canned data; the rollback
was, in the words of PENDINGS, "an educated guess." This harness makes it a measured,
repeatable verification.

## What it does

`scripts/rollback-harness.sh` runs five phases against a throwaway Fly app:

| Phase | Action | Exercises |
|---|---|---|
| 1 | Deploys `demo-app/` to Fly.io through Convoy's real pipeline (`convoy ship --platform fly` → CanaryStage deploy → PromoteStage live-verify → ObserveStage bake) | the whole real-Fly apply path |
| 1b | Records the known-good release (version + image ref from `fly releases --image --json`) and asserts `/health` + `/orders` are live | evidence capture |
| 2 | Injects a failure: deploys a deliberately broken image (`scripts/rollback-harness/bad.Dockerfile` — every request answers HTTP 500, including `/health`) as a new release | failure injection |
| 2b | Asserts the app is actually broken — the injection took (new release, different image, `/health` no longer 200) | honest failure state |
| 3 | Rolls back through `convoy rollback <app> -y` | `flyRollbackPreview` + `flyRollback` end-to-end |
| 4 | Verifies recovery: current release image == known-good image, release status `complete`, `/health` 200 again, `/orders` serving data | the issue's core acceptance: "rollback restores the previous release (image + config verified)" |
| 5 | Destroys the throwaway app (unless `KEEP_APP=1`) | no residue |

Why inject failure via a **bad image** instead of a secret/env flag? Fly secrets are
app-level, not per-release — rolling back the image does not unset them. A broken
image is the only failure mode that a rollback can actually reverse, which makes it
the honest test.

## Prerequisites

- `flyctl` installed **and authenticated** — `fly auth login` (the harness refuses to
  run without a live session; this is what keeps CI hermetic)
- `jq` and `curl` on `PATH`
- Convoy deps installed: `npm install` (repo root)
- Docker is **not** required: the bad image is built by Fly's remote builder

## Running

```bash
scripts/rollback-harness.sh
```

A full run takes roughly 8–15 minutes (remote build of the demo image, machine boot,
bad release, rollback, verification) and prints a phase-by-phase transcript ending in:

```
ROLLBACK HARNESS PASSED — convoy-rb-harness-1786680000
  good release : v1  registry.fly.io/convoy-rb-harness-1786680000:deploy-abc123
  bad release  : v2  registry.fly.io/convoy-rb-harness-1786680000:deploy-bad456
  after rollback: v3 (status=complete) — image restored, /health 200, /orders serving
  url          : https://convoy-rb-harness-1786680000.fly.dev
```

Exit codes: `0` rollback verified end-to-end · `1` harness failure (with the failing
phase + evidence) · `2` preflight/environment failure.

### Environment knobs

| Var | Default | Purpose |
|---|---|---|
| `ROLLBACK_HARNESS_APP` | `convoy-rb-harness-<epoch>` | Fly app name to use |
| `KEEP_APP` | `0` | `1` leaves the app running after the run (manual cleanup: `fly apps destroy <app> --yes`) |
| `ROLLBACK_HARNESS_BAKE_WINDOW` | `0` | observe-stage bake window in seconds (0 = probe immediately) |

## What "verified" means

The pass criteria are deliberately independent of Convoy's own output. Recovery is
proven three ways:

1. **Image**: `fly releases --image --json` shows the current release carrying the
   exact image ref recorded before the failure was injected (rollback redeploys the
   old image — the release number bumps, the image must match).
2. **Health**: `https://<app>.fly.dev/health` returns 200.
3. **Function**: `/orders` returns 200 with rows — the service actually works, not
   just "a process is listening."

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `flyctl not authenticated` (exit 2) | Run `fly auth login`. CI has no session, so this is the expected hermetic behavior. |
| `Convoy ship did not deploy` | Check the printed ship tail for a preflight blocker (e.g. auth, app name collision). |
| `bad deploy unexpectedly succeeded` | The bad image became healthy — check `scripts/rollback-harness/bad.Dockerfile` still answers 500 (local check: `docker build -f scripts/rollback-harness/bad.Dockerfile -t rh-bad scripts/rollback-harness && docker run -p 8080:8080 rh-bad` then `curl -i localhost:8080/health`). |
| `app still healthy after bad release` | The machine swap hadn't completed; the harness polls for ~2.5 min. If it persists, the failure injection didn't take — the rollback test would be a no-op, so the harness fails instead of pretending. |
| `current image != known-good image` | Real rollback failure — the exact class of bug this harness exists to catch. Grab `fly releases --image --app <app>` (before cleanup: rerun with `KEEP_APP=1`) and the run timeline. |

## Scope notes

- The harness exercises the **operator rollback path** (`convoy rollback` → preview +
  confirm + `flyRollback`). The observe-stage **auto-rollback** path shares the same
  `flyRollback` adapter function but has its own trigger logic; it remains covered by
  unit tests and the demo `--inject-failure` flows.
- VPS (slot switching) and Vercel (alias) rollbacks have no preview yet — see
  `src/adapters/` — so the harness is Fly-only by design.
