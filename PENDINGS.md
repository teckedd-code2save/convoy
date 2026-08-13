# PENDINGS — Convoy Sharp Edges & Unresolved Issues

> Known gotchas, design tradeoffs, and gaps that need attention before Convoy can handle real production deployments without human backup.

---

## Critical

### 1. Rehearsal runner has no resource isolation

The real rehearsal runner (`src/core/rehearsal-runner.ts`) spawns the target as a child process on the operator's machine. If the target contains destructive logic (e.g., `rm -rf /tmp/*`) or consumes all memory, there is no cgroup/namespace isolation. The operator should only rehearse targets they trust.

**Status:** Known. Containerized rehearsal (via Docker-in-Docker or ephemeral VM) is the intended fix but requires infra that this version of Convoy does not bundle.

### 2. SQLite state is unsafe under concurrent Convoy runs

`.convoy/state.db` had no write locking — two concurrent `npm run convoy -- apply` sessions could race the schema migration or interleave multi-statement write sequences (insert-then-read, preflight blocker replacement), corrupting the plan index or producing interleaved state transitions.

**Status:** Resolved. `src/core/file-lock.ts` provides a cross-process advisory file lock (`state.db.lock`, exclusive create + PID-based stale-lock reaping). `RunStateStore` acquires it around DB creation, schema migration, and every write method; reads stay lock-free (WAL). A second concurrent writer waits (default 30s, tunable via `CONVOY_STATE_LOCK_TIMEOUT_MS`), then fails with a helpful `FileLockError` — it never interleaves. Covered by `src/core/file-lock.test.ts` and the two-stores test in `src/core/state.test.ts`.

### 3. Rollback has no cross-platform tests

The rollback path (`medic`) exists for Fly.io (`src/adapters/fly/runner.ts`) but has never been tested against a real Fly app that was deployed by a previous Convoy apply. The scripted rollback mode uses canned data.

**Status:** Needs a dedicated test harness that deploys a real app, injects failure, and verifies the rollback path end-to-end. Until then, the rollback is an educated guess.

---

## Moderate

### 4. Scanner depth is shallow (4 levels)

`SKIP_DIRS` excludes `node_modules`, `.git`, `.next`, `dist`, `build`, `vendor`, `.venv`, `__pycache__`. The walker descends only 4 directory levels. Monorepos with deeply nested package structures (e.g., a Next.js app with Turborepo workspaces at `apps/web/src/components/ui/`) may not be fully scanned.

**Status:** Known. Extend `SKIP_DIRS` or increase depth per-project when monorepo detection fires.

### 5. No CI for the convoy core itself

The convoy package has no automated tests run in CI. The `npm test` script exists but the test suite is minimal. There is a GitHub Actions CI workflow (`ci`) that passes, but it runs only the typecheck and build, not meaningful integration tests.

**Status:** Gap. The `src/core/` and `src/planner/` modules should have unit tests against fixture repos. Integration tests for the real stage runners are blocked by (1) above (isolation).

### 6. Plan ID matching is fragile

The CLI extracts plan IDs via `grep` + `awk` from the output of `convoy plans`. If a plan title contains special characters or the grep pattern matches multiple plans, the wrong plan may be selected.

**Status:** Known. The workaround is to use a unique substring of the plan title. A machine-readable `--json` output for `convoy plans` would fix this properly.

---

## Minor

### 7. Opus enricher key required for full experience

Without `ANTHROPIC_API_KEY`, the enricher falls back to deterministic output. The first-person narrative, Dockerfile template tailoring, and log diagnosis do not work. The `.env.example` documents this but first-run users may miss it.

**Status:** Documented in AGENTS.md and `.env.example`. No action needed.

### 8. `web/.next` directory can corrupt on parallel builds

Running `npm run build` in `web/` while the dev server (`npm run dev`) is live writes two competing `.next/` directories. The webpack module graph corrupts and requires `rm -rf web/.next` to recover.

**Status:** Documented in AGENTS.md as a hard rule ("Never run npm run build in web/ while the dev server is live"). A fix would be to use separate output directories for dev vs build, or to add a guard in the build script.

### 9. Demo app has no health endpoint in default mode

The `demo-app/` Express service only exposes `/health` when a specific environment variable is set. The rehearsal runner waits for `/health` before probing — if the target doesn't have one, rehearsal stalls until timeout.

**Status:** The demo-app works as a scripted demo target. Real targets need their own `/health` endpoint. This is intentional — Convoy should not mandate a health-check implementation.

---

## Testing Gaps

| Area | What's Missing | Impact |
|------|---------------|--------|
| Scanner | Unit tests against fixture directories with known structures | Refactoring may silently break detection |
| Author | Snapshot tests of authored manifests (Docker, Compose, CI) | Enricher prompt changes produce untracked output changes |
| Rehearsal runner | Integration test with a real target that has /metrics + /health | Regression in probe logic goes undetected |
| GitHub runner | Integration test that creates + squash-merges a PR | Auth failure paths are untested |
| Canary gate | Synthetic signal injection | Breach detection logic has no automated guard |
| Rollback | End-to-end test on actual Fly app | Critical safety net is untested in CI |
