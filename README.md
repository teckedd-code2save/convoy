# Convoy

**The deployment agent that ships your code — not a rewrite of it.**

Convoy turns "deploy this repo" into a safe, evidence-gated production deployment. It scans your repo, asks five questions once, rehearses the build on an ephemeral twin, authors only the deployment files you need, promotes through canary gates while real signals stay healthy, and auto-rolls back the moment they don't.

Every capability is exposed as an MCP tool so Claude Code — or any MCP client — can plan, apply, approve, and diagnose deployments as part of a larger workflow, while approval gates keep a human in the loop by default.

Built for the *Built with Opus 4.7* Claude Code hackathon (April 21–26, 2026).

---

## The Meridian scenario

Meet the problem Convoy was built to solve.

Meridian is a three-service fintech startup: an orders API (Express + Postgres), a PDF report renderer, and a payments worker. Their principal engineer Karan is leaving next week. Production is throwing intermittent 503s on the orders service — a mystery bug that only Karan fully understands. The CTO wants to ship a payment-processing refactor and bring up the new reports service before Karan walks out the door.

Without Convoy, the team is blocked. Every deployment went through Karan: he knew which environment variables were missing on Fly, which services depended on which, what the rollback story was. None of that is written down. The new engineer is afraid to touch prod.

With Convoy, they run one command:

```bash
convoy onboard ./meridian-orders   # five questions, three minutes
convoy plan ./meridian-orders --save
convoy apply <plan-id>
```

Here's what happens in the next 8 minutes:

1. **Onboard** — Before the first plan, Convoy asks five questions: platform mandate (Fly), approvers (CTO's GitHub handle), canary strategy, compliance requirements, secrets manager. Answers go to `.convoy/preferences.json`. Every subsequent plan for this repo inherits them. The CTO's handle means Convoy will pause at every gate until he approves.

2. **Scan** — Convoy reads the repo. It finds the Express app, the Prisma schema, the BullMQ worker, the `.env.example` with `DATABASE_URL` and `STRIPE_SECRET_KEY`. It detects the health endpoint at `/health`. No config, no annotation — it reads the evidence.

3. **Pick** — Fly.io scores highest (+25 for the worker topology, +15 for the Dockerfile). The platform decision is inspectable: a score table with the delta for each signal, so the team can disagree and override with `--platform=railway` if they want. Because `onboard` declared a Fly mandate, Fly wins outright.

4. **Rehearse** — Before a single line of config is committed, Convoy spawns the orders service locally, hits it with 60 synthetic requests, and scrapes the metrics. This is where it catches the bug: p99 of 8,740ms. Zero errors — all requests succeeded — but every user waited 8 seconds. The medic agent (Claude Opus 4.7) reads the logs and reports: _"I found a global `renderLock` in `src/routes/render.ts` that serialises all PDF requests through a single promise chain. Replace it with a semaphore."_ The pipeline stops. Nobody approved anything. Nobody got paged at 2am.

5. **Fix and resume** — the new engineer fixes the lock. They run `convoy resume`. Convoy carries the uncommitted fix onto the convoy branch as a `fix:` commit — the medic's diagnosis is the commit subject — and the fix lands in the same PR as the deploy plumbing. Main only sees it at merge time, after rehearsal proved it works.

6. **Author gate** — Convoy pauses. The approval card shows rehearsal evidence: p99, error rate, smoke tests. The CTO approves from evidence. Convoy opens the PR with the Dockerfile, `fly.toml`, CI workflow, and `.env.schema`.

7. **Secrets gate** — Before the deploy command runs, Convoy diffs the expected vars against what Fly has staged. `STRIPE_SECRET_KEY` is missing. It pauses — not fails, pauses — surfaces the key in the web UI, and lets the operator paste the value inline. Convoy pushes it to Fly via `fly secrets set` and proceeds.

8. **Canary** — Convoy deploys to one machine at 5% traffic, compares the p99 delta (+3ms), declares healthy, and promotes.

9. **Observe** — 120 seconds of post-deploy monitoring. SLO healthy. Done.

Total time: 8 minutes. Total tribal knowledge required: zero. The plan page is the handoff document: what was scanned, what was scored, what rehearsal found, what secrets were staged.

Karan can leave. The team can ship.

---

## See it in action

[![Convoy: AI Deployment Agent from Commit to Production](https://img.youtube.com/vi/5btzce8adeE/maxresdefault.jpg)](https://www.youtube.com/watch?v=5btzce8adeE)

A walkthrough of the real pipeline — plan, rehearse, medic agent, canary, observe — recorded against the actual product. ▶ [Watch on YouTube](https://www.youtube.com/watch?v=5btzce8adeE)

---

## Install

### One command (clones for you)

```bash
curl -fsSL https://raw.githubusercontent.com/teckedd-code2save/convoy/main/scripts/get | bash
```

This puts Convoy in `~/.convoy/app` and runs the full setup: npm dependencies (root, `web/`, `demo-app/`), `.env` creation with an interactive Anthropic API key prompt, shell helpers (`convoy`, `convoy-ship-here`), and Claude Code plugin + MCP registration. Re-running it updates in place. Idempotent.

### From a checkout

```bash
git clone https://github.com/teckedd-code2save/convoy.git
cd convoy
./scripts/install
```

Same setup, your choice of location. Either way, finish with:

```bash
source ~/.zshrc      # or ~/.bashrc / config.fish
# restart Claude Code so it picks up the plugin + MCP server
```

### Remote MCP (no local install)

Convoy's MCP server speaks Streamable HTTP. If a teammate or CI box is already running Convoy, point your Claude Code at it:

```bash
# on the host
npm run mcp-http                      # serves http://localhost:3738/mcp

# on your machine
claude mcp add convoy --transport http http://that-host:3738/mcp
```

State is SQLite on the host, so multiple clients can interleave tool calls safely.

---

## How it works — the pipeline

```
onboard → orient → scan → pick → rehearse → author → canary → promote → observe
                                                 │
                                                 └─ medic (sidecar on any breach)
```

| Stage | What it does |
|---|---|
| **onboard** | Five-question first-contact interview. Captures platform mandate, approvers, canary strategy, compliance, and secrets manager. Stored to `.convoy/preferences.json`. Runs once per repo; every subsequent plan inherits it. |
| **orient** | Per-run drift detector. Reads `fly.toml`, `vercel.json`, CI workflows, secrets-manager packages, and observability deps — then compares them against saved preferences. Surfaces any mismatch explicitly before planning; never re-scores silently. |
| **scan** | Live repo scan. Builds a coordinated service graph with `infra`, `backend`, `worker`, and `frontend` lanes — each with its own ecosystem, topology, data layer, health path, and secrets hints. 12 ecosystems, monorepo-aware. |
| **pick** | Scores all five platforms (Fly.io, Railway, Vercel, Cloud Run, VPS) per lane against real evidence. Respects `--platform=X`, existing platform config, and any mandate declared in onboard. |
| **rehearse** | Spawns the target in an env-scrubbed shell — real install, real build, real boot, synthetic load against real probe paths, metrics scraped, logs captured. Runs *before* author: no PR opens until the service has proven it boots healthy. |
| **author** | Pauses for `open_pr` approval with rehearsal evidence on-screen, then drafts only the files Convoy owns (Dockerfile, platform manifest, `.env.schema`, CI workflow, provenance record) and opens a real GitHub PR. |
| **canary** | Health-gated incremental rollout (one machine → rest on Fly). Halts on error-rate or p99 breach. |
| **promote** | Configurable bake window between deploy and full promote. |
| **observe** | Post-deploy watch window. SLO-healthy = release stays. Breach = auto-rollback. |
| **medic** | Sidecar to any breach. An Opus 4.7 tool-use loop — up to six turns, four scoped tools (`read_log_tail`, `read_file`, `grep_repo`, `finalize_diagnosis`). Produces a structured root-cause card; never patches your code. |

**Plan supersede lineage.** Re-planning the same target marks the old plan `superseded`. `convoy plans` shows `active` / `superseded → <id>`. The web UI dims old plans so the operator always works from the current one.

**Fix-and-resume.** When the medic classifies a failure as `owned=developer`, the run pauses with `awaiting_fix`. Fix the code (or let Claude Code fix it), then `convoy resume`. The fix lands on the convoy branch as a `fix:` commit whose subject is the medic's diagnosis, and rides into the same PR as the deploy plumbing.

---

## Onboard and orient

### `convoy onboard`

Run this once before the first plan for any repo. Convoy walks you through five sections — deployment style, platform, release process, secrets and compliance, observability — and writes `.convoy/preferences.json`. Subsequent plans inherit everything without asking again.

```bash
convoy onboard ./my-app
# or, non-interactively:
convoy onboard ./my-app --answers='{"platformMandate":"fly","approvers":["alice"]}'
```

The interview captures:

- **Platform mandate** — lock to `fly`, `vercel`, `railway`, `cloudrun`, or `vps`; or leave open for Convoy to score
- **Approvers** — GitHub usernames; gates pause until they approve (empty = auto-approve when rehearsal is clean)
- **Canary strategy** — `skip`, `canary`, or `bluegreen`; bake window in seconds
- **Compliance** — `soc2`, `hipaa`, `pci`, `gdpr`; triggers forced manual approval and audit logging
- **Secrets manager** — `platform-native`, `doppler`, `infisical`, `vault`, `aws-sm`, or `env-file`

Re-run `convoy onboard ./my-app` any time to update a single setting.

### `convoy orient`

Run this before planning a repo that's been active for a while, or when you want to understand what signals Convoy will read.

```bash
convoy orient ./my-app
```

Orient reads `fly.toml`, `vercel.json`, `railway.json`, CI workflows (deploy steps + secrets references), secrets-manager packages in `package.json`, and observability deps. It then diffs what it found against `.convoy/preferences.json`:

```
✓  Existing platform: fly  (fly.toml)
✓  CI deploy target: fly   (.github/workflows/deploy.yml — fly deploy)
⚠  Drift: vercel.json found but preferences declare mandate=fly
   → Run `convoy onboard --platform=fly` to update, or remove vercel.json
```

Drift is surfaced explicitly before any plan is created. Convoy never re-scores around a mismatch and calls it "fine."

---

## Platforms

| Platform | Deploy | Rollback | Key signal |
|---|---|---|---|
| **Fly.io** | Real, via `flyctl` | Real, proven end-to-end | Health-gated canary; auto-creates the app on first run |
| **Vercel** | Real, via `vercel` CLI | Best-effort alias to prior preview | Preview deploy + promote |
| **VPS** | Real — GHCR image + Docker + Caddy over SSH | Re-point to prior image tag | `convoy vps bootstrap <host>` turns a fresh box into a target |
| **Railway** | Connection probe + secret staging real; deploy runner v2 | — | Scales-to-zero workers |
| **Cloud Run** | Connection probe + secret staging real; deploy runner v2 | — | Serverless containers |

### VPS + Caddy DNS preflight

When `--vps-manage-caddy` is set, Convoy resolves your domain against the VPS IP before pushing any image. If the A record is wrong or missing, it tells you exactly what to add:

```
⚠  DNS preflight failed for api.example.com
   Resolved: 203.0.113.50  →  expected: 198.51.100.12 (your-vps.host)
   Add an A record:  api.example.com.  A  198.51.100.12
   Re-run after DNS propagates (~5 min for most registrars).
```

### VPS bootstrap

`convoy vps bootstrap user@host` SSHes into a fresh Debian or RHEL box, probes for Docker and Caddy, and installs anything missing — idempotently. It presents the exact commands before running them and requires `--yes` before touching the box. Also exposed as the `convoy_vps_bootstrap` MCP tool.

```bash
convoy vps bootstrap deploy@198.51.100.12 --yes
# → installs Docker CE, Caddy v2, creates /srv deploy root
```

Every platform adapter implements the same interface — `deploy`, `rollback`, `readLogs`, `healthCheck` — plus read-only connection probes that surface missing CLIs, auth problems, and secrets gaps *before* any state change, each with the exact remedy command.

---

## Secrets

### `convoy secrets pull` / `push`

Convoy integrates with Infisical, Doppler, and Vault as first-class secrets managers. When a manager is detected (from `onboard` preferences or package deps), `stage-secrets` leads with a pull offer before asking you to paste values manually.

```bash
convoy secrets pull --manager=infisical          # fetch all expected keys
convoy secrets pull --manager=doppler --key=STRIPE_SECRET_KEY   # single key
convoy secrets push --key=DATABASE_URL --value=... # push a staged value back
```

Pull authenticates and fetches in one shot — Infisical uses universal auth (client-id + client-secret → ephemeral token, nothing persisted), Doppler calls the CLI, Vault calls `vault kv get`. Secret values are never printed to stdout; Convoy logs key names and counts only.

The `stage-secrets` gate in the apply pipeline can use `convoy secrets pull` automatically when credentials are on hand, then diff the fetched set against the `.env.schema` expected vars and surface only the gaps.

---

## Drive it three ways

### 1 — CLI

```bash
convoy onboard <path>                  # first-contact interview (do this first)
convoy orient <path>                   # drift check before re-planning
convoy plan <path> --save --open       # plan + open in the web viewer
convoy plans                           # list plans (active / superseded → <id>)
convoy apply <plan-id> --open          # run the pipeline, watch live
convoy resume                          # continue after a fix
convoy ship <path>                     # plan + save + apply in one shot
convoy status [run-id]                 # auto-spawns the viewer, prints the live URL
convoy vps bootstrap <host> --yes      # provision a fresh VPS
convoy secrets pull --manager=doppler  # fetch secrets before staging
```

### 2 — Web viewer (port 3737)

```bash
cd web && npm run dev    # http://localhost:3737
```

The viewer shares one SQLite state file with the CLI and MCP server. Every plan and run gets a URL, approvals you click in the UI unpause the pipeline within ~400ms, old (superseded) plans are visually dimmed, and the projects dashboard tracks every repo you've shipped.

### 3 — MCP tools

| Tool | What it does |
|---|---|
| `convoy_plan` | Scan a repo (path or GitHub URL), produce a saved deployment plan |
| `convoy_list_plans` | List saved plans, including `active` / `superseded` status |
| `convoy_apply` | Run the pipeline against a plan |
| `convoy_status` | Follow a run; see stage progress and pending approval gates |
| `convoy_approve` | Approve or reject a gate without leaving the session |
| `convoy_diagnose` | Read the medic's structured root-cause card for a failed run |
| `convoy_list_runs` | Run history |
| `convoy_vps_bootstrap` | Turn a fresh VPS into a deploy target (Docker + Caddy) |

---

## Slash commands

The bundled Claude Code plugin registers these commands:

| Command | What it does |
|---|---|
| `/convoy:onboard [path]` | Run the onboard interview for a repo — do this before the first ship |
| `/convoy:orient [path]` | Drift check: compare repo artifacts against saved preferences |
| `/convoy:ship <target>` | Plan + apply end-to-end, approvals at each gate |
| `/convoy:ship-status` | Status of the most recent (or a specific) run |
| `/convoy:ship-resume` | Re-apply after you've fixed the code |
| `/convoy:ship-rollback` | Roll a service back to its previous healthy release |
| `/convoy:help` | List all commands |

---

## The medic is a Claude agent

When rehearsal, canary, or observe breaches tolerance, Convoy hands the failure to an **Opus 4.7 tool-use loop** with four scoped tools: `read_log_tail`, `read_file`, `grep_repo`, `finalize_diagnosis`. Up to six turns. The agent decides what to read, forms hypotheses, verifies them, and finalizes on its own. Path traversal is refused at the tool boundary — it literally cannot read outside the repo root.

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

That's real output from `convoy apply --inject-failure=rehearse`. The verdict is a structured card — `rootCause`, `classification` (code / config / infra), `confidence`, `owned` (developer / convoy) — and every tool call streams live to the CLI and the web viewer's medic spotlight.

What the medic **never** does is patch your code. `owned=developer` pauses the run for a human (or your Claude Code session) to push the fix. The whole loop is ~450 lines in [`src/core/medic.ts`](./src/core/medic.ts), no framework.

---

## Architecture

```
convoy/
├── src/
│   ├── core/               Orchestrator, stages, medic agent, rehearsal +
│   │                       GitHub runners, SQLite state, key resolver (BYOK)
│   ├── planner/            Scanner (service graph), per-lane picker, enricher
│   ├── onboard/            Interview runner, preferences schema, drift engine
│   ├── orient/             Artifact reader, signal collector, drift detector
│   ├── adapters/           fly/ vercel/ railway/ cloudrun/ vps/ — one interface
│   ├── mcp/                MCP server: stdio (index.ts) + HTTP (http.ts) transports
│   └── cli.ts              commander entrypoint
├── plugin/                 Claude Code plugin — slash commands, agents, .mcp.json
├── scripts/                get (curl installer) · install (full setup) · mcp-server
├── web/                    Next.js 15 + Tailwind 4 viewer, port 3737 — projects
│                           dashboard, run timelines, approvals, medic spotlight
├── demo-app/               Breakable Express service (DEMO_MODE=buggy flips a bug)
└── docs/                   architecture.md · principles.md · rollback-proof.md
```

**Three layers, each with a clear responsibility:**

- **TypeScript core** (`src/`) — deterministic. Scanner, picker, author, orchestrator, medic scaffolding, and all platform adapters run without AI. The enricher and medic are opt-in AI passes layered on top.
- **Opus 4.7 enricher** — non-deterministic, upgrades quality. Tailors Dockerfiles, writes first-person plan narratives, and runs the medic loop. Degrades gracefully when `ANTHROPIC_API_KEY` is absent: ecosystem templates instead of tailored files, structured fallbacks instead of the medic.
- **Next.js 15 viewer** (`web/`) — reads the same SQLite DB the CLI and MCP server write. Approval clicks write back via server actions. Nothing in the viewer has a separate state store.

---

## Bring your own key

Three ways to supply an Anthropic API key, in priority order:

1. **`.convoy/byok.json`** in the target project (gitignored, auto-loaded):
   ```jsonc
   { "provider": "infisical" }         // universal-auth → fetches the key from your vault
   { "provider": "direct", "apiKey": "sk-ant-..." }   // local dev
   ```
2. **`ANTHROPIC_API_KEY`** / `CONVOY_ANTHROPIC_API_KEY` env vars (what `scripts/install` sets up).
3. **Nothing** — every AI pass degrades gracefully to deterministic output. Useful for CI.

Plan enrichment runs on Sonnet 4.6 with prompt caching; the medic agent runs on Opus 4.7.

---

## CLI quick reference

```bash
# First contact
convoy onboard <path>                  # five-question interview, writes preferences.json
convoy orient <path>                   # drift check: artifacts vs preferences

# Planning
convoy plan <path-or-url>              # local path, GitHub URL, or owner/repo
convoy plan <path> --save --open       # persist + open in the web viewer
convoy plan <path> --platform=vps      # fly | railway | vercel | cloudrun | vps
convoy plan <path> --workspace=apps/web  # monorepo subpath
convoy plan <path> --no-ai             # skip enrichment

# Applying
convoy plans                           # list saved plans (active / superseded → <id>)
convoy apply <plan-id> --open          # run + watch live
convoy apply <plan-id> -y              # unattended (--auto-approve)
convoy apply <plan-id> --demo          # fully scripted, zero credentials
convoy apply <plan-id> --inject-failure=rehearse   # watch the medic work

# Secrets
convoy secrets pull --manager=infisical
convoy secrets pull --manager=doppler --key=STRIPE_SECRET_KEY
convoy secrets push --key=KEY --value=VALUE

# VPS
convoy vps bootstrap <host> --yes
convoy apply <plan-id> --vps-host=<host> --vps-ghcr-image=ghcr.io/you/app

# Real GitHub PR + rehearsal + Fly deploy
convoy apply <plan-id> \
  --real-author --auto-merge \
  --real-rehearsal --probe-path=/orders \
  --real-fly --fly-app=my-app --fly-create-app --fly-bake-window=120

# Resume after a fix
convoy resume                          # continue the most recent paused/failed run
convoy resume <run-id> --fresh         # replay from scratch instead

# End-to-end
convoy ship <path-or-url>              # plan + save + apply in one shot
convoy status [run-id]                 # auto-spawns the viewer, prints the live URL
```

Environment variables: `ANTHROPIC_API_KEY`, `CONVOY_WEB_URL` (default `http://localhost:3737`), `CONVOY_STATE_PATH` (default `.convoy/state.db`), `CONVOY_PLANS_DIR` (default `.convoy/plans`), `CONVOY_MCP_PORT` (default `3738`), `CONVOY_VPS_HOST`.

---

## Prerequisites for real shipping

All optional. Convoy preflights each one and fails loud with the exact remedy.

```bash
gh auth login            # GitHub — real PRs (repo + workflow scopes)
fly auth login           # Fly.io  (brew install flyctl)
vercel login             # Vercel  (npm i -g vercel)
# VPS — SSH access only; convoy vps bootstrap installs the rest
```

Per target repo: a `github.com` remote you can push to (for real PRs), and service secrets in `<target>/.env.convoy-secrets` (gitignored, staged via the platform CLI, never committed).

---

## Verification

```bash
npm test
npm run typecheck
(cd web && npm run typecheck)
(cd demo-app && npx tsc --noEmit)
```

---

## Three principles (non-negotiable)

**1. We ship your code. We do not rewrite your code.**
Convoy authors only deployment-surface files: Dockerfile, platform manifest, CI workflow, `.env.schema`. Everything in `src/`, `app/`, `lib/`, `tests/` is off-limits, enforced by the provenance manifest, the filesystem containment check, and the medic's system prompt.

**2. Every forward action has a pre-staged reverse.**
No step runs without a named, measured rollback path. Canary → rollback on breach. Promote → re-point. Observe → auto-rollback. The plan page lists the rollback story for every stage before the pipeline starts.

**3. Evidence over assertion.**
Health is proven with independent signals — real probes, real metrics — not the platform API's return code. The score table is inspectable. The medic's diagnosis cites the exact file and line. Every gate decision is logged with the evidence that triggered it.

See [`docs/principles.md`](./docs/principles.md) for the rationale and [`docs/architecture.md`](./docs/architecture.md) for the full design.

---

## License

MIT.
