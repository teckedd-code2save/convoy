# Rollback proof

Evidence that Convoy's `observe → rollback` path works against real Fly.io, not scripted.

## Setup

- App: `convoy-demo-859136` on Fly.io, `personal` org.
- Baseline (v3): demo-app with healthy `/health` returning 200 in <1s.
- Staged secret: `DEMO_HEALTH_DELAY_MS=2000` — makes `/health` wait 2s before responding.
- Plan: `demo-app → fly`, canary strategy, 45s observe bake window.
- Convoy thresholds: error rate > 1% OR p99 > 1000ms triggers rollback.

## Command

```bash
npm run convoy -- apply <plan-id> \
  --real-fly --fly-app=convoy-demo-859136 \
  --fly-bake-window=45
```

## Observed sequence (run `c94ce4cc`, 2m 6s total)

1. **Canary stage** — staged the secret, ran `fly deploy --strategy=canary --app convoy-demo-859136`. Fly deployed v4 with the slow `/health`. Pre-stage rollback target recorded: v3.
2. **Promote stage** — probed `/health` up to 5s timeout. First probe timed out at 5s; three subsequent probes returned 200 but at 2349ms, 2379ms, 2590ms. Verification passed (3 consecutive 200s) but p99 already flagged at 5004ms.
3. **Observe stage** — first probe measured p99 = 2817ms. This exceeded the 1000ms threshold.
4. **`observe.breach`** emitted with reason `p99 2817ms exceeded 1000ms`.
5. **`rollback.starting`** emitted.
6. `flyRollback` looked up releases via `fly releases --image --json`, found v3's `ImageRef`, and ran `fly deploy --image <ref> --strategy=immediate --yes --app convoy-demo-859136`.
7. **`rollback.done`** emitted with `restored_version=3`.
8. Run status set to `rolled_back`, completedAt stamped.

## After

```
$ fly releases --app convoy-demo-859136
VERSION │ STATUS   │ DATE
v5      │ complete │ 34s ago      ← Convoy's auto-rollback (v3's image)
v4      │ complete │ 1m46s ago    ← broken deploy
v3      │ complete │ 5m5s ago     ← healthy baseline

$ curl -s -o /dev/null -w "status=%{http_code} latency=%{time_total}s\n" \
  https://convoy-demo-859136.fly.dev/health
status=200 latency=0.536802s
```

v5 is running v3's image. `/health` is back under 1s. No human touched a terminal between Convoy detecting the problem and the app recovering.

## What this proves

- `flyDeploy` is a real `flyctl deploy` invocation — the broken image actually went live on Fly's edge.
- `flyHealthCheck` measures real HTTP latency against the real hostname.
- The threshold check is evidence-based — observe didn't time out a bake window and say "close enough"; it measured a real p99, compared it to a real threshold, and tripped.
- `flyRollback` is not the missing `fly releases rollback` subcommand (that doesn't exist in flyctl v0.4+). It's a real `fly deploy --image <prior-release-ref> --strategy=immediate` call that creates a new release from an older image.
- The run is recorded as `rolled_back` in SQLite and will show that status in the CLI status command and the web UI's run detail page.
