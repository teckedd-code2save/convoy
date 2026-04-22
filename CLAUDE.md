# CLAUDE.md — notes for Claude Code sessions on this repo

Context & conventions for future Claude runs working on Convoy.

## Architecture one-liner

Deterministic TypeScript core (scanner/picker/author/orchestrator/medic on SQLite) + Opus 4.7 enrichment (first-person narrative, Dockerfiles, log diagnosis) + a Next.js 15 + Tailwind 4 viewer that reads the same SQLite DB and writes approval decisions via a server action.

Read `README.md` for the product story, `docs/architecture.md` for diagrams, `docs/principles.md` for the three rules.

## Repo layout

```
convoy/
├── src/               Agent core (TypeScript, type=module, tsx for dev)
│   ├── core/          Orchestrator, state store, event bus, medic, stages
│   ├── planner/       Scanner, picker, author, Opus enricher
│   ├── adapters/      Platform adapter interface + per-platform stubs
│   └── cli.ts         commander entrypoint
├── plugin/            Claude Code plugin: commands + agents (markdown)
├── web/               Next.js 15 + Tailwind 4 viewer (port 3737)
├── demo-app/          Breakable Express service used as demo target
└── docs/              architecture.md, principles.md, demo-script.md
```

## Hard rules

- **Three principles, non-negotiable.** See `docs/principles.md`.
  1. We ship your code. We do not rewrite your code.
  2. Every forward action has a pre-staged reverse.
  3. Evidence over assertion.
- **Ground output in scan signals + Opus synthesis, not if-chains.** When you find yourself adding a conditional per framework / per package manager / per prisma, that belongs in the enricher prompt, not the deterministic path. Templates in `planner/author.ts` should be coarse (per-ecosystem at most); Opus tailors them.
- **First-person voice** in anything the agent says to the operator. "I'll rehearse..." not "Rehearse on...". The enricher prompt enforces this; deterministic fallbacks should too.
- **Never author files outside Convoy-owned list.** Dockerfile (when drafted), platform manifest, CI workflow, `.env.schema`, `infra/` terraform, `.convoy/*`. Nothing else.
- **Real stages are opt-in, not default.** Each of `--real-author`, `--real-rehearsal`, `--real-fly` lights up one stage against real systems. Without the flag the stage runs scripted. Default is scripted so CI and first-run users don't need credentials.

## Real stage runners (live code paths)

- `src/core/rehearsal-runner.ts` — spawns the target as a child process, waits for /health, drives synthetic load against configurable paths, scrapes JSON metrics, detects breaches (error-rate + p99), captures stdout/stderr (last 500 lines) for medic. Invoked from `RehearseStage.#runReal`.
- `src/core/github-runner.ts` — wraps `git` + `gh`. `detectRepo` refuses to operate on a parent git repo (target must have its own `.git`). `createPrFromAuthoredFiles` branches from origin/<default>, writes exactly the authored files, commits + pushes + opens PR via `gh pr create`, returns URL and number. `mergePr` shells out to `gh pr merge --squash --delete-branch`. Invoked from `AuthorStage.#runReal`.
- `src/adapters/fly/runner.ts` — wraps `flyctl`. All methods are thin shell calls with JSON parsing and graceful errors. Preflight checks (`flyctlAvailable`, `flyAuthStatus`) surface install/auth problems before any state change. `flyDeploy` streams logs and extracts hostname from output. `flyRollback` is the measured reverse. Invoked from `CanaryStage.#runRealFly`, `PromoteStage.#runRealFly`, `ObserveStage.#runRealFly`.

## Known gotchas

- **Never run `npm run build` in `web/` while the dev server is live.** Both write to `.next/` and the two write orders corrupt the webpack module graph. Use `npx tsc --noEmit` or `npm run typecheck` (in `web/`) for type verification instead. If things do get corrupted: `pkill -f "next dev" && rm -rf web/.next && cd web && npm run dev`.
- **`ANTHROPIC_API_KEY`** lives in gitignored `.env`. The `convoy` npm script passes `--env-file-if-exists=.env` to tsx so process.env picks it up. Without the key, enricher and medic fall back to deterministic output — useful for CI.
- **Scanner depth is shallow (4 levels).** Heavier walks hit `node_modules` et al. If detection misses something, extend `SKIP_DIRS` and/or the fixture paths first.
- **SQLite state at `.convoy/state.db` is gitignored.** Schema auto-migrates on open (see `state.ts`'s `#migrate`). Safe to delete when you want a clean slate.
- **Plans at `.convoy/plans/*.json` are gitignored.** Re-seed with `convoy plan <path> --save`.

## Running the product

```bash
# One-time
npm install
(cd web && npm install)
(cd demo-app && npm install)
cp .env.example .env    # add ANTHROPIC_API_KEY

# Plan
npm run convoy -- plan ./demo-app --save
PLAN_ID=$(npm run convoy --silent -- plans | grep demo-app | awk '{print $1}')

# Scripted apply (no credentials needed; smoke-demo)
npm run convoy -- apply "$PLAN_ID"

# Real local rehearsal (spawns the target, probes real /metrics + /health)
npm run convoy -- apply "$PLAN_ID" --real-rehearsal
npm run convoy -- apply "$PLAN_ID" --real-rehearsal --env DEMO_MODE=buggy --probe-path=/orders

# Real GitHub PR (target must be a git repo with origin on github.com + gh auth)
npm run convoy -- apply "$PLAN_ID" --real-author --auto-merge

# Real Fly.io deploy (requires flyctl + fly auth login)
npm run convoy -- apply "$PLAN_ID" --real-fly --fly-app=my-app --fly-create-app

# Full real — PR, rehearsal, deploy, observe, rollback on breach
npm run convoy -- apply "$PLAN_ID" \
  --real-author --auto-merge \
  --real-rehearsal --probe-path=/orders \
  --real-fly --fly-app=my-app --fly-create-app --fly-bake-window=120

# Inject-failure demos (for quick medic demos without real build)
npm run convoy -- apply "$PLAN_ID" --inject-failure=rehearse

# Web viewer
(cd web && npm run dev)          # http://localhost:3737
```

## Verifying type safety

```bash
npm run typecheck                # root convoy package
(cd web && npm run typecheck)    # web/
(cd demo-app && npx tsc --noEmit) # demo-app/
```

## Commit convention

Conventional prefixes: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs:`, `chore:`, `ci:`. Multi-paragraph body explaining *why*, not *what*. Always co-author:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Hackathon constraint

Built during the **Built with Opus 4.7** Claude Code hackathon, Apr 21–26, 2026. All commits must land during that window on the `main` branch of `teckedd-code2save/convoy`. Commits before the hackathon start are not permitted; carrying in pre-written code is not permitted.
