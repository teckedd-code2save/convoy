# Convoy

**The deployment agent that ships your code — without rewriting it.**

Rehearse. Ship. Observe.

Convoy turns a pull request into a safe production deployment by writing only the files you don't want to write, rehearsing every change on an ephemeral twin of your target, promoting through canary steps only when real signals stay healthy, and auto-rolling back the moment they don't. When something breaks, Convoy's medic reads the logs and produces a diagnosis — in your voice, with a specific fix — and then it waits for you.

Built for the *Built with Opus 4.7* Claude Code hackathon (April 21–26, 2026).

---

## Try it in 90 seconds

```bash
git clone https://github.com/teckedd-code2save/convoy.git
cd convoy
npm install
cp .env.example .env     # add your ANTHROPIC_API_KEY

# Plan a deployment for any local repo
npm run convoy -- plan ../my-web-app --save

# See the plan rendered
npm run convoy -- plans

# Apply it — the pipeline runs through scan → pick → author → rehearse
# → canary → promote → observe, pausing on approvals you hold
npm run convoy -- apply <plan-id> --no-auto-approve

# Watch it in the browser
cd web && npm install && npm run dev
# open http://localhost:3737
```

Approve the pending steps from the web UI. Convoy's orchestrator is polling the same SQLite state DB; the moment you click **Approve**, it continues.

---

## What makes Convoy different

- **It ships your code — it does not rewrite your code.** Convoy only authors deployment-surface files (Dockerfile, platform manifests, CI workflow, `.env.schema`). Everything in `src/`, `app/`, `lib/`, `tests/`, and your application dependencies is off-limits. Not soft-limits — hard-limits enforced by the provenance manifest.
- **Plans are real artifacts.** Like `terraform plan`, you get an inspectable artifact — saved to `.convoy/plans/<id>.json`, rendered in the CLI and web viewer — that describes exactly what `convoy apply` would do. Platform decision, drafted file contents, rehearsal validations, canary steps, rollback strategy. Nothing autonomous happens without the plan on the table.
- **Every decision is grounded in the repo.** The scanner reads real files and emits structured evidence. Opus 4.7 synthesizes the narrative, writes the Dockerfile, produces the ship plan — all from signals, not templates. Generic output is the first symptom of a broken agent; we don't do generic.
- **Rehearse on a twin, not on your users.** The rehearse stage fires a throwaway deployment, validates the build, boots, runs the smoke suite, measures cold-start and p99 latency against a baseline, dry-runs any migrations against scratch schema — and tears it down. Production traffic only ever sees code that already passed on the twin.
- **Medic diagnoses, never patches your code.** When a rehearsal or canary breaches tolerance, the medic subagent reads the logs, reasons with Opus, and produces a structured diagnosis card: root cause, location (`file:line`), reproduction, suggested fix, confidence. For config-level failures, medic may patch the Convoy-authored file and retry. For code-level failures, medic pauses — the fix is yours, the pipeline resumes when you push it.
- **Rollback is pre-staged, not improvised.** Every stage runs with a named reverse: `flyctl releases rollback`, `vercel alias previous deployment`, `railway redeploy previous`, `gcloud run services update-traffic`. ETA is measured and within policy. If the reverse isn't ready, the forward doesn't run.

---

## The pipeline

```
scan → pick → author → rehearse → canary → promote → observe
                        │           │         │         │
                        └─ medic ───┴─ rollback ────────┘
```

| Stage | Responsibility |
|---|---|
| **scan** | Parse the repo into structured evidence — ecosystem, framework, data layer, topology, existing platform hints, package manager, build/start commands, health path. |
| **pick** | Score all four supported platforms (Fly.io, Railway, Vercel, Cloud Run) against the evidence. Respect explicit `--platform=X` override. Respect existing platform config. Otherwise pick the winner and explain why. |
| **author** | Draft only the files Convoy owns — Dockerfile (for non-Vercel targets), platform manifest, `.env.schema`, CI workflow, provenance record. Content is AI-tailored when a key is set; ecosystem templates otherwise. |
| **rehearse** | Deploy the candidate image to an ephemeral twin. Validate build, boot, health, cold-start, synthetic load, migrations. Destroy the twin. |
| **canary** | Promote to a configurable percentage of production traffic with a bake window. Halt on `p99 Δ > 30%`, error-rate Δ > 0.5pp, or new error fingerprints. |
| **promote** | Progressive rollout `10% → 25% → 50% → 100%` with bake between steps. |
| **observe** | Post-deploy watch window. SLO-healthy = release stays. Breach = auto-rollback. |

---

## Repo layout

```
convoy/
├── src/                    Core agent (TypeScript, no bundler, tsx for dev)
│   ├── core/               Orchestrator, state store, event bus, medic, stages
│   ├── planner/            Scanner, picker, author, Opus enricher
│   ├── adapters/           Platform adapter interface + per-platform stubs
│   └── cli.ts              commander-based entrypoint
├── plugin/                 Claude Code plugin manifest, subagents, commands
├── web/                    Next.js 15 + Tailwind v4 viewer (port 3737)
│   └── app/
│       ├── plans/[id]      Plan detail page with collapsible file previews
│       └── runs/[id]       Live run timeline + approval buttons + medic card
├── demo-app/               Breakable Express service used as the demo target
│   └── src/routes/orders.ts  Intentional bug under DEMO_MODE=buggy
└── docs/
    ├── architecture.md     Pipeline, subagents, adapter model, provenance
    └── principles.md       The three rules that shape every design choice
```

---

## CLI reference

```bash
# Planning
convoy plan <path>                    # produces a plan, prints the artifact
convoy plan <path> --save             # persists to .convoy/plans/<id>.json
convoy plan <path> --json             # raw JSON
convoy plan <path> --platform=fly     # explicit platform choice
convoy plan <path> --no-ai            # skip Opus enrichment

# Applying
convoy plans                           # list saved plans
convoy apply <plan-id>                 # dry-run execute (stub stages)
convoy apply <plan-id> --no-auto-approve
convoy apply <plan-id> --inject-failure=rehearse  # demo: trigger medic

# Inspecting
convoy status                          # most recent run
convoy status <run-id>                 # specific run
convoy ship <repo-url>                 # convenience for quick dry-runs

# Reserved
convoy rollback <service>              # not yet implemented
```

Environment:
- `ANTHROPIC_API_KEY` — enables Opus-authored file content, first-person narrative, medic diagnosis. The CLI and planner degrade gracefully to templates when unset.
- `CONVOY_STATE_PATH` — override SQLite DB location (default `.convoy/state.db`).
- `CONVOY_PLANS_DIR` — override saved plans dir (default `.convoy/plans`).

---

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the full picture. In brief:

- **Deterministic core** — SQLite state store (`runs`, `run_events`, `approvals`), typed event bus, orchestrator that sequences seven stage classes.
- **AI surface** — Opus 4.7 enriches plans (summary, platform reason, ship narrative, authored file content) and diagnoses failures in medic. Every AI pass is optional; the deterministic core runs without a key.
- **Two UIs on one state** — the CLI writes runs and events to SQLite; the web viewer reads the same DB and writes approvals through a server action. The pipeline's 400ms poll picks up decisions instantly.
- **Platform adapter interface** — every supported platform implements `deploy`, `createEphemeral`, `destroyEphemeral`, `rollback`, `readLogs`, `healthCheck`. New platforms = new adapter; the orchestrator is platform-neutral.

---

## Principles (non-negotiable)

1. **We ship your code. We do not rewrite your code.**
2. **Every forward action has a pre-staged reverse.** No step runs without a named, measured rollback path.
3. **Evidence over assertion.** Health is proven with independent signals, not with the platform API's return code.

See [`docs/principles.md`](./docs/principles.md) for the full rationale.

---

## Status

Hackathon-scope build, Apr 21 → Apr 26, 2026. Target: a real, runnable vertical slice that demos end-to-end — plan → apply → medic catches a breach → diagnosis card in the browser — against a real local target.

- Fly.io / Railway / Vercel / Cloud Run adapters are declared; execution is stubbed pending platform credentials. The plan, rehearsal narrative, and rollback strategy are real per-platform.
- Medic is real against any log stream you feed it.
- The web approval loop is end-to-end: the CLI blocks at approvals and the browser unblocks them via a server action writing to the shared SQLite DB.

---

## License

MIT.
