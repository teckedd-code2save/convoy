# Convoy

**The deployment agent that ships your code — without rewriting it.**

Rehearse. Ship. Observe. Diagnose.

Convoy turns a pull request into a safe production deployment by writing only the files you don't want to write, rehearsing every change on an ephemeral twin of your target, promoting through canary steps only when real signals stay healthy, and auto-rolling back the moment they don't.

When something breaks, Convoy's medic is a **Claude agent** — not a one-shot enrichment call. Opus 4.7 runs a tool loop with four scoped tools (`read_log_tail`, `read_file`, `grep_repo`, `finalize_diagnosis`), reads the failure like a human would, and produces a structured diagnosis in your voice with a specific fix. Every tool call streams live to the CLI and the web UI so you can watch the medic think.

Built for the *Built with Opus 4.7* Claude Code hackathon (April 21–26, 2026).

---

## The medic is a Claude agent

This is the part we think is new.

**At a glance:**

- **What it is:** an Opus 4.7 tool-use loop with four scoped tools (`read_log_tail`, `read_file`, `grep_repo`, `finalize_diagnosis`). Up to six turns. Not a one-shot enrichment call — the agent decides what to read, forms hypotheses, verifies them, and stops on its own.
- **When it runs:** any rehearse, canary, or observe breach activates it as a sidecar. The pipeline pauses while it investigates; you watch every tool call stream live in the CLI and the web viewer.
- **What it produces:** a structured diagnosis card — `rootCause`, `classification` (code / config / infra), `confidence`, `owned` (developer / convoy), and a plain-language fix.
- **What it never does:** patch your code. When `owned=developer` the run pauses with status `awaiting_fix`; you push a commit and run `convoy resume`. Convoy will not retry against code it doesn't own.

When rehearsal breaches tolerance, Convoy hands the failure context to Opus 4.7 along with four tools scoped to the target repo. The agent picks which tools to call, in what order, and decides on its own when it has enough evidence to finalize. Path-traversal is refused at the tool boundary — the agent literally cannot read outside the repo root.

```
▸ rehearse
  · phase=synthetic_load.breach p99_ms=494 error_rate_pct=6.67
  · phase=medic.invoked
  ◇ medic read_log_tail n=50
  ◇ medic grep_repo /orders_query_timeout|deadline/
  ◇ medic read_file src/routes/orders.ts
  ◇ medic finalize_diagnosis
  ! rootCause=orders.ts has a DEMO_MODE=buggy branch that
    sleeps 800ms before every query  classification=code
    confidence=high  owned=developer
```

Everything you see above is real output from `convoy apply --inject-failure=rehearse`. The agent made four tool calls, ran for ~12 seconds, and correctly identified the bug in a file Convoy was explicitly forbidden to patch (it's developer-owned). That refusal is encoded in the system prompt *and* enforced downstream: when `owned=developer` the pipeline pauses for the human to push a fix; it doesn't try to patch and retry against someone else's code.

**Why this matters:** most "AI deployment" tools bolt an LLM onto CI output as flavor text. Convoy's medic is genuinely agentic — it decides what to read, forms hypotheses, verifies them, and records a structured verdict. It's the smallest and cleanest demonstration we've seen of Claude-as-managed-agent applied to production diagnostics, and the whole loop lives in [`src/core/medic.ts`](./src/core/medic.ts) — no framework, ~450 lines.

---

## Try it in 90 seconds

```bash
git clone https://github.com/teckedd-code2save/convoy.git
cd convoy
npm install
cp .env.example .env                 # add ANTHROPIC_API_KEY

# Plan for any local repo or GitHub URL. --save persists the plan;
# --open pops the plan straight into the web viewer.
npm run convoy -- plan ../my-web-app --save --open

# Boot the web viewer in another terminal (port 3737)
(cd web && npm install && npm run dev)

# Apply — the pipeline runs scan → pick → author → rehearse
# → canary → promote → observe. The run URL prints as soon as it starts.
npm run convoy -- apply <plan-id> --open
```

By default Convoy **pauses at every approval gate** and you approve from the web UI (the URL is printed when the run starts; it's also what `--open` launches). Pass `--auto-approve` or `-y` for unattended runs.

Want to watch the medic agent work without a real breach? Inject a scripted failure — the tool loop runs against the demo fixture, and the web viewer renders the medic spotlight in real time:

```bash
npm run convoy -- apply <plan-id> --demo -y --inject-failure=rehearse
```

When a real rehearsal breaches and medic classifies it `owned=developer`, the run pauses with status `awaiting_fix`. Push your fix and resume:

```bash
git commit -am "fix: ..."
npm run convoy -- resume          # re-applies the most recent paused run's plan
```

---

## What makes Convoy different

- **It ships your code — it does not rewrite your code.** Convoy only authors deployment-surface files (Dockerfile, platform manifests, CI workflow, `.env.schema`). Everything in `src/`, `app/`, `lib/`, `tests/`, and your application dependencies is off-limits. Not soft-limits — hard-limits enforced by the provenance manifest and by the medic's system prompt.
- **The medic is a real Claude agent loop**, not flavor text on CI output. See above.
- **Plans are real artifacts.** Like `terraform plan`, you get an inspectable artifact — saved to `.convoy/plans/<id>.json`, rendered in the CLI and the web viewer — that describes exactly what `convoy apply` would do. Every run gets a shareable URL the CLI prints; you and the agent watch the same page.
- **Every decision is grounded in the repo.** The scanner reads real files and emits structured evidence (12 ecosystems, monorepo-aware). The picker scores all four platforms live against that evidence. Scan and pick aren't theater — they run `scanRepository()` and `pickPlatform()` on the actual target, on every apply.
- **Rehearse on a twin, not on your users.** The rehearse stage spawns the target as a subprocess with a **scrubbed environment by default** (PATH, HOME, NODE_ENV + your explicit `--env`/env-file — no ambient cloud credentials). Drives real load against configurable probe paths, scrapes metrics, feeds logs to the medic on breach, tears it down. Use `--trust-repo` to inherit your shell env on your own checkouts.
- **Safety defaults match the story.** Approvals pause the pipeline by default. Ambient env isn't inherited by subprocess rehearsal. No hidden auto-merges.
- **Rollback is pre-staged, not improvised.** Every stage has a named reverse. Fly.io rollback (`flyctl deploy --image <prior>`) is proven end-to-end — see [`docs/rollback-proof.md`](./docs/rollback-proof.md). Vercel / Railway / Cloud Run rollback paths are declared in the adapter interface.

---

## The pipeline

```
scan → pick → rehearse → author → canary → promote → observe
              │                     │         │         │
              └─ medic ─────────────┴─ rollback ────────┘
```

**Rehearse runs before author by design.** No PR opens and no repo state mutates until Convoy has proof the service boots and responds healthy. The operator approves opening the PR with rehearsal evidence on-screen, then approves merging it after reviewing the diff on GitHub. Previously author ran first; a downstream rehearsal failure could leave the repo merged-but-undeployed. We fixed that.

| Stage | Responsibility |
|---|---|
| **scan** | Live `scanRepository()` on the target. Ecosystem, framework, data layer, topology, existing platform hints, package manager, build/start commands, health path. 12 ecosystems; monorepo-aware. |
| **pick** | Live `pickPlatform()` scores all four supported platforms (Fly.io, Railway, Vercel, Cloud Run) against the scan evidence. Respects `--platform=X` and existing platform config (e.g. a committed `fly.toml`). |
| **rehearse** | Spawns the target subprocess in an env-scrubbed shell. Real install, real build, real boot. The readiness probe accepts any HTTP response — a 404 on `/health` means the process is up; the synthetic load probe that follows is what actually measures health. Real log capture; feeds the medic on breach. |
| **author** | Pauses for `open_pr` approval with rehearsal evidence on-screen. Then drafts only the files Convoy owns — Dockerfile (non-Vercel), platform manifest, `.env.schema`, CI workflow, provenance record. Opus-authored content when a key is set; ecosystem templates otherwise. Containment-checked: any path outside the repo root is rejected at the filesystem boundary. |
| **canary** | Fly's health-gated canary strategy (one machine → rest) via `flyctl`. Halt on error-rate / p99 threshold breach. |
| **promote** | Bake window between deploy and promote. |
| **observe** | Post-deploy watch window. SLO-healthy = release stays. Breach = auto-rollback (Fly). |
| **medic** | *Sidecar to any breach.* Claude agent loop with four scoped tools. Emits a structured diagnosis card; for `owned=developer`, pauses the run for you to push a fix. See below. |

---

## Interoperability: the CLI and the web follow each other

The CLI and the web viewer share one SQLite state file. That means:

- **Every plan save prints its web URL.** Click it — you see the plan in the viewer without copy-pasting an ID.
- **Every `apply` prints the run URL as soon as the run is created.** The agent and you are looking at the same page; approvals you click in the UI unpause the orchestrator within ~400ms.
- **Every medic tool call streams as a run event.** The web UI renders them inline so you can replay the agent's investigation. The run page has a dedicated **Medic spotlight** — a magenta-glow card that animates while medic is investigating, so a single screenshot makes it obvious the Claude-driven medic is in the loop.
- **The CLI is unmistakable in a Claude Code transcript.** Every Convoy run opens with a unicode-bordered banner and prefixes every line with a dim cyan rule, so when Convoy output mixes with other tools you can scan back and tell at a glance which block was Convoy.
- **`--open`** on `plan --save` or `apply` auto-launches your default browser at the relevant URL. `convoy status` auto-spawns the web viewer if it's down so the timeline link the operator clicks is actually live.

Override the base URL with `CONVOY_WEB_URL` if you're tunneling or remoting. The viewer runs on port 3737 by default.

---

## Repo layout

```
convoy/
├── src/                    Core agent (TypeScript, no bundler, tsx for dev)
│   ├── core/
│   │   ├── medic.ts        Claude agent loop — 4 scoped tools, path-safety
│   │   ├── orchestrator.ts Sequences stages, handles breach & rollback
│   │   ├── stages.ts       Scan, pick, author, rehearse, canary, promote, observe
│   │   ├── rehearsal-runner.ts  Env-scrubbed subprocess + probe + metrics
│   │   └── github-runner.ts     gh / git wrappers for real PRs
│   ├── planner/
│   │   ├── scanner.ts      scanRepository() — the evidence source
│   │   ├── picker.ts       pickPlatform() — the real scoring function
│   │   └── enricher.ts     Opus 4.7 narrative + file content
│   └── adapters/           fly/, vercel/, railway/, cloudrun/ — platform shells
├── plugin/                 Claude Code plugin (commands + subagents)
├── web/                    Next.js 15 + Tailwind v4 viewer, port 3737
│   └── app/
│       ├── plans/[id]      Plan detail — apply from the browser
│       └── runs/[id]       Live timeline + approval buttons + medic card
├── demo-app/               Breakable Express service. DEMO_MODE=buggy flips a bug.
└── docs/
    ├── architecture.md     Pipeline, adapter model, provenance
    ├── principles.md       The three non-negotiable rules
    ├── rollback-proof.md   End-to-end Fly rollback evidence
    └── adversarial-review*.md  Pre-demo self-critique we shipped against
```

---

## CLI reference

```bash
# Planning
convoy plan <path-or-url>              # produces a plan, prints the artifact
convoy plan <path> --save              # persists to .convoy/plans/<id>.json
convoy plan <path> --save --open       # + opens in the web viewer
convoy plan <path> --json              # raw JSON
convoy plan <path> --platform=fly      # explicit platform choice
convoy plan <path> --workspace=apps/web # monorepo subpath
convoy plan <path> --no-ai             # skip Opus enrichment

# Applying (safe by default — pauses at every approval gate)
convoy plans                           # list saved plans
convoy apply <plan-id>                 # pause on approvals; decide from web UI
convoy apply <plan-id> --auto-approve  # unattended. Alias: -y / --yes
convoy apply <plan-id> --open          # auto-launch the run page in browser
convoy apply <plan-id> --trust-repo    # inherit shell env into rehearsal (for your own repos)
convoy apply <plan-id> --inject-failure=rehearse  # demo: trigger the medic agent

# Real-by-default with explicit escape hatches
convoy apply <plan-id> --demo                     # scripted, needs no creds
convoy apply <plan-id> --no-real-rehearsal        # stub just the rehearsal
convoy apply <plan-id> --no-real-author           # stub just the PR

# Resuming after a code fix
convoy resume                          # re-apply the most recent paused/failed run
convoy resume <run-id>                 # re-apply a specific run's plan
convoy resume --probe-path=/orders     # accepts the same flags as `apply`

# End-to-end
convoy ship <path-or-url>              # plan + save + apply in one shot
convoy ship ./demo-app --auto-approve  # full real: PR, rehearse, deploy
convoy status [run-id]                 # most recent or specific run; auto-spawns the web viewer
                                       # and prints the live timeline URL

# Reserved
convoy rollback <service>              # not yet implemented
```

`convoy resume` is the answer to "I fixed the code, now what?" It looks up the run, refuses to resume `running` / `pending` / `succeeded` runs, prints the prior failure reason for context, and re-applies the saved plan. A new run row is created — the previous one is preserved as history. Stages aren't idempotent across partial state, so resume always replays from `scan`.

Environment:
- `ANTHROPIC_API_KEY` — enables Opus-authored file content, ship narrative, and the medic's agent loop. Without it, enricher and medic fall back to deterministic output.
- `CONVOY_WEB_URL` — override the printed base URL (default `http://localhost:3737`).
- `CONVOY_STATE_PATH` — SQLite DB location (default `.convoy/state.db`).
- `CONVOY_PLANS_DIR` — saved plans dir (default `.convoy/plans`).

---

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the full picture. In brief:

- **Deterministic core** — SQLite state store (`runs`, `run_events`, `approvals`), typed event bus, orchestrator sequencing seven stage classes.
- **AI surface** — Opus 4.7 enriches plans (summary, platform reason, ship narrative, authored file content) and runs the medic agent loop. Every AI pass is optional; the deterministic core runs without a key.
- **Two UIs on one state** — the CLI writes runs/events to SQLite; the web viewer reads the same DB and writes approvals through a server action. The pipeline polls at 400ms so decisions land ~instantly.
- **Approvals are scoped to `run_id`** — the server action requires the claimed run id matches the approval's `run_id` at the SQL level. Knowing an approval UUID alone is not enough.
- **Platform adapter interface** — every platform implements `deploy`, `createEphemeral`, `destroyEphemeral`, `rollback`, `readLogs`, `healthCheck`. New platforms = new adapter; the orchestrator is platform-neutral.

---

## Principles (non-negotiable)

1. **We ship your code. We do not rewrite your code.**
2. **Every forward action has a pre-staged reverse.** No step runs without a named, measured rollback path.
3. **Evidence over assertion.** Health is proven with independent signals, not with the platform API's return code.

See [`docs/principles.md`](./docs/principles.md) for the full rationale.

---

## Status: what's real

All the mechanics are real by default. Pass `--demo` to short-circuit to a scripted pipeline that needs zero credentials.

| Capability | Status | Notes |
|---|---|---|
| URL / `owner/repo` target resolution | **Real** | shallow-clones to `.convoy/clones/`, refreshes on re-use, offline fallback |
| Scanner — 12 ecosystems, monorepo sub-service detection | **Real** | live `scanRepository()` at apply time, not a plan-time replay |
| Platform picker (score + override + existing-config) | **Real** | live `pickPlatform()` at apply time |
| Opus-authored Dockerfile / platform manifest content | **Real** | needs `ANTHROPIC_API_KEY`; degrades to templates otherwise |
| First-person ship narrative | **Real** | same |
| Plan artifact (JSON + readable render + web viewer) | **Real** | saved to `.convoy/plans/<id>.json`; URL printed on `--save` |
| Approval loop (CLI ↔ web via SQLite + server action) | **Real** | `run_id`-bound; operator drives the cadence, no timeouts |
| **Approvals default to paused** — no auto-approve unless `--auto-approve` / `-y` | **Real** | matches the "humans decide" story |
| **Opening a real GitHub PR** with the authored files | **Real** | needs `gh auth login` + write access to target; default on for `ship` |
| **Auto-merge via `gh pr merge --squash`** | **Real** | default on for `ship`; disable with `--no-auto-merge` |
| **Local rehearsal** — env-scrubbed subprocess, real build, probe, metrics, log capture | **Real** | monorepo-aware: install at repo root, build/start in workspace subdir |
| **Rehearsal env is scrubbed by default** — PATH/HOME/NODE_ENV + explicit `--env` only | **Real** | `--trust-repo` to inherit ambient env on your own checkouts |
| **Readiness probe accepts any HTTP response** | **Real** | a 404 on `/health` no longer gates rehearsal; the synthetic load probe measures real health |
| **Medic as a Claude agent loop** — 4 scoped tools, path-safety, live streamed | **Real** | `read_log_tail`, `read_file`, `grep_repo`, `finalize_diagnosis`; up to 6 turns |
| **Fix-and-resume loop** — `convoy resume [runId]` re-applies a paused/failed run's plan after a code fix | **Real** | refuses succeeded/running runs; creates a new run row, preserves history |
| **Fly.io** — canary deploy via `flyctl`, observe loop, auto-rollback | **Real** | proven end-to-end in [`docs/rollback-proof.md`](./docs/rollback-proof.md) |
| **Vercel** — preview deploy + promote via `vercel` CLI | **Real** | |
| Vercel alias-based rollback on production domain | Best-effort, v2 | current path aliases prior preview URL; reliable production-alias rollback is v2 |
| Railway / Cloud Run adapters | Declared, stubbed | v2 — interfaces defined; stages skip with a note |

Default for `ship` and `apply` is everything real except approvals, which pause by default. `--demo` takes all the real stages back to scripted so you can try it without any credentials.

---

## Real shipping — setup

One-time per platform. All optional — Convoy preflights each before use and fails loud with the exact remedy if anything's missing.

```bash
# GitHub (for real PRs) — you probably already have this
brew install gh
gh auth login           # needs repo + workflow scopes

# Fly.io (for Fly deploys)
brew install flyctl     # or: curl -L https://fly.io/install.sh | sh
fly auth login          # free hobby tier, no card required

# Vercel (for Vercel deploys)
npm i -g vercel
vercel login
```

Per target repo:

- Must be a git repo with a `github.com` remote you have write access to (for real PRs).
- Service secrets go in `<target>/.env.convoy-secrets` (gitignored). Convoy stages them via `fly secrets set` / `vercel env add` before deploy. Values never enter git.
- Convoy can auto-create the Fly app on first run (default). Override with `--fly-app=<name>`.

Full real deploy, humans-in-the-loop:

```bash
npm run convoy -- ship https://github.com/you/your-repo --open
# plans, saves, opens the plan in the browser, then runs the pipeline.
# Every approval gate pauses — click Approve in the UI when you're ready.
```

Full real deploy, unattended:

```bash
npm run convoy -- ship https://github.com/you/your-repo --auto-approve
```

For a monorepo workspace add `--workspace=apps/web`. For a credentials-free demo add `--demo`.

---

## License

MIT.
