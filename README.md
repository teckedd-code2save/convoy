# Convoy

**The deployment agent that ships your code — without rewriting it.**

Plan. Rehearse. Ship. Observe. Diagnose.

Convoy turns "deploy this repo" into a safe, evidence-gated production deployment. It scans your repo, picks a platform, rehearses the build on an ephemeral twin, authors only the deployment files you don't want to write, promotes through canary gates while real signals stay healthy, and auto-rolls back the moment they don't.

It's built to be **driven by agents as much as by humans**: every capability is exposed as an MCP tool, so Claude Code (or any MCP client) can plan, apply, watch, approve, and diagnose deployments as part of a larger workflow — while approval gates keep a human in the loop by default.

Built for the *Built with Opus 4.7* Claude Code hackathon (April 21–26, 2026).

---

## The Meridian scenario

Meet the problem Convoy was built to solve.

Meridian is a three-service fintech startup: an orders API (Express + Postgres), a PDF report renderer, and a payments worker. Their principal engineer Karan is leaving next week. Production is throwing intermittent 503s on the orders service — a mystery bug that only Karan fully understands. The CTO wants to ship a payment-processing refactor and bring up the new reports service before Karan walks out the door.

Without Convoy, the team is blocked. Every deployment went through Karan: he knew which environment variables were missing on Fly, which services depended on which, what the rollback story was. None of that is written down. The new engineer is afraid to touch prod.

With Convoy, they run one command:

```bash
convoy plan ./meridian-orders --save
convoy apply <plan-id>
```

Here's what happens in the next 8 minutes:

1. **Scan** — Convoy reads the repo. It finds the Express app, the Prisma schema, the BullMQ worker, the `.env.example` with `DATABASE_URL` and `STRIPE_SECRET_KEY`. It detects the health endpoint at `/health`. No config, no annotation — it reads the evidence.

2. **Pick** — Fly.io scores highest (+25 for the worker topology, +15 for the Dockerfile). The platform decision is inspectable: a score table with the delta for each signal, so the team can disagree and override with `--platform=railway` if they want.

3. **Rehearse** — Before a single line of config is committed, Convoy spawns the orders service locally, hits it with 60 synthetic requests, and scrapes the metrics. This is where it catches the bug: p99 of 8,740ms. Zero errors — all requests succeeded — but every user waited 8 seconds. The medic agent (Claude Opus) reads the logs and reports: _"I found a global `renderLock` in `src/routes/render.ts` that serialises all PDF requests through a single promise chain. Replace it with a semaphore."_ The pipeline stops. Nobody approved anything. Nobody got paged at 2am.

4. **Fix and resume** — the new engineer fixes the lock. They run `convoy resume`. Convoy carries the uncommitted fix onto the convoy branch as a `fix:` commit — the medic's diagnosis is the commit subject. Rehearsal passes: p99 142ms.

5. **Author gate** — Convoy pauses. The approval card shows rehearsal evidence: p99, error rate, smoke tests. The CTO approves from evidence. Convoy opens the PR with the Dockerfile, `fly.toml`, CI workflow, and `.env.schema`.

6. **Secrets gate** — Before the deploy command runs, Convoy diffs the expected vars against what Fly has staged. `STRIPE_SECRET_KEY` is missing. It pauses — not fails, pauses — surfaces the key in the web UI, and lets the operator paste the value inline. Convoy pushes it to Fly via `fly secrets set` and proceeds.

7. **Canary** — Convoy deploys to one machine at 5% traffic, compares the p99 delta (+3ms), declares healthy, and promotes.

8. **Observe** — 120 seconds of post-deploy monitoring. SLO healthy. Done.

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

### No local install at all

Convoy's MCP server also speaks Streamable HTTP. If a teammate (or a CI box, or a Docker container) is already running Convoy, point your Claude Code at it and you get every tool with zero local footprint:

```bash
# on the host
npm run mcp-http                      # serves http://localhost:3738/mcp

# on your machine
claude mcp add convoy --transport http http://that-host:3738/mcp
```

State is SQLite on the host, so multiple clients can interleave tool calls safely.

---

## Three ways to drive it

**1. MCP tools — from inside any Claude Code session (or any MCP client):**

| Tool | What it does |
|---|---|
| `convoy_plan` | Scan a repo (path or GitHub URL), produce a saved deployment plan |
| `convoy_list_plans` | List saved plans |
| `convoy_apply` | Run the pipeline against a plan |
| `convoy_status` | Follow a run; see stage progress and pending approval gates |
| `convoy_approve` | Approve or reject a gate without leaving the session |
| `convoy_diagnose` | Read the medic's structured root-cause card for a failed run |
| `convoy_list_runs` | Run history |
| `convoy_vps_bootstrap` | Turn a fresh VPS into a deploy target (Docker + Caddy) |

**2. Slash commands — via the bundled Claude Code plugin:**

```
/convoy:where           orient — install location, state, plans, runs, viewer status
/convoy:ship <target>   ship a repo end-to-end, approvals at each gate
/convoy:ship-status     status of the most recent (or a specific) run
/convoy:ship-resume     re-apply after you've fixed the code
/convoy:ship-rollback   roll a service back to its previous healthy release
/convoy:help            list all commands
```

**3. CLI — from any terminal:**

```bash
convoy plan ../my-app --save --open    # plan + open in the web viewer
convoy apply <plan-id> --open          # run the pipeline, watch live
convoy ship .                          # plan + apply in one shot
convoy status                          # latest run; auto-spawns the viewer
```

The web viewer (`cd web && npm run dev`, port 3737) shares one SQLite state file with the CLI and MCP server: every plan and run gets a URL, approvals you click in the UI unpause the pipeline within ~400ms, and the projects dashboard tracks every repo you've shipped.

---

## The pipeline

```
scan → pick → rehearse → author → canary → promote → observe
                            │
                            └─ medic (sidecar on any breach)
```

| Stage | Responsibility |
|---|---|
| **scan** | Live repo scan. Builds a coordinated service graph with `infra`, `backend`, `worker`, and `frontend` lanes — each with its own ecosystem, topology, data layer, health path, and secrets hints. 12 ecosystems, monorepo-aware. |
| **pick** | Scores all five platforms (Fly.io, Railway, Vercel, Cloud Run, **VPS**) per lane against real evidence. Respects `--platform=X` and existing platform config. |
| **rehearse** | Spawns the target as a subprocess in an env-scrubbed shell — real install, real build, real boot, synthetic load against real probe paths, metrics scraped, logs captured. Runs **before** author: no PR opens until the service has proven it boots healthy. |
| **author** | Pauses for `open_pr` approval with rehearsal evidence on-screen, then drafts only the files Convoy owns — Dockerfile, platform manifest, `.env.schema`, CI workflow, provenance record — and opens a real GitHub PR. Containment-checked: paths outside the repo root are rejected at the filesystem boundary. |
| **canary** | Health-gated incremental rollout (one machine → rest on Fly). Halts on error-rate / p99 breach. |
| **promote** | Bake window between deploy and promote. |
| **observe** | Post-deploy watch window. SLO-healthy = release stays. Breach = auto-rollback. |
| **medic** | Sidecar to any breach. A genuine Claude agent loop — see below. |

**Fix-and-resume:** when the medic classifies a failure as `owned=developer`, the run pauses with `awaiting_fix`. Fix the code (or let Claude Code fix it), then `convoy resume`. Convoy carries your uncommitted changes onto the plan-keyed `convoy/<plan>` branch as a `fix:` commit — the medic's diagnosis becomes the commit subject — and the fix lands in the same PR as the deploy plumbing. Main only sees it at merge time, after rehearsal proved it works.

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

That's real output from `convoy apply --inject-failure=rehearse`. The verdict is a structured card — `rootCause`, `classification` (code / config / infra), `confidence`, `owned` (developer / convoy) — and every tool call streams live to the CLI and the web viewer's medic spotlight. What the medic **never** does is patch your code: `owned=developer` pauses the run for a human (or your Claude Code session) to push the fix. The whole loop is ~450 lines in [`src/core/medic.ts`](./src/core/medic.ts), no framework.

---

## Platforms

| Platform | Deploy | Rollback | Notes |
|---|---|---|---|
| **Fly.io** | Real, via `flyctl` | Real, proven end-to-end ([evidence](./docs/rollback-proof.md)) | Health-gated canary; auto-creates the app on first run |
| **Vercel** | Real, via `vercel` CLI | Best-effort (alias to prior preview); production-alias rollback is v2 | Preview deploy + promote |
| **VPS** | Real — GHCR image + Docker + Caddy over SSH | Re-point to prior image tag | `convoy vps bootstrap <host>` turns a fresh box into a target |
| **Railway** | Connection probe + secret staging real; deploy runner v2 | — | |
| **Cloud Run** | Connection probe + secret staging real; deploy runner v2 | — | |

The VPS lane is for the "I have a $5 box and a domain" crowd: `convoy vps bootstrap <host>` SSHes in, installs Docker and Caddy (idempotently), and from then on the pipeline builds your image, pushes it to GHCR, and deploys it behind Caddy with TLS. Also exposed as the `convoy_vps_bootstrap` MCP tool.

Every adapter implements the same interface — `deploy`, `rollback`, `readLogs`, `healthCheck`, plus read-only connection probes that surface missing CLIs, auth, and secrets *before* any state changes, each with the exact remedy command.

---

## Bring your own key

Convoy's AI surfaces (plan enrichment, authored file content, the medic loop) need an Anthropic API key. Three ways to supply one, in priority order:

1. **`.convoy/byok.json`** in the target project (gitignored, auto-loaded):
   ```jsonc
   { "provider": "infisical", /* universal-auth → fetches the key from your vault */ }
   { "provider": "direct", "apiKey": "sk-ant-..." }   // local dev
   ```
   The Infisical path logs in with universal auth, fetches the secret over REST with an ephemeral token, and persists nothing.
2. **`ANTHROPIC_API_KEY`** / `CONVOY_ANTHROPIC_API_KEY` env vars (what `scripts/install` sets up).
3. **Nothing** — every AI pass degrades gracefully to deterministic output: ecosystem templates instead of tailored Dockerfiles, structured fallbacks instead of the medic loop. Useful for CI.

Plan enrichment runs on Sonnet 4.6 with prompt caching; the medic agent runs on Opus 4.7.

---

## CLI reference

```bash
# Planning
convoy plan <path-or-url>               # local path, GitHub URL, or owner/repo
convoy plan <path> --save --open        # persist + open in the web viewer
convoy plan <path> --platform=vps       # fly | railway | vercel | cloudrun | vps
convoy plan <path> --workspace=apps/web # monorepo subpath
convoy plan <path> --no-ai              # skip enrichment

# Applying — real by default, paused at every approval gate
convoy plans                            # list saved plans
convoy apply <plan-id> --open           # run + watch live
convoy apply <plan-id> -y               # unattended (--auto-approve)
convoy apply <plan-id> --demo           # fully scripted, zero credentials
convoy apply <plan-id> --trust-repo     # inherit shell env into rehearsal
convoy apply <plan-id> --inject-failure=rehearse   # watch the medic work

# VPS
convoy vps bootstrap <host>             # install Docker + Caddy (plan first, then --yes)
convoy apply <plan-id> --vps-host=<host> --vps-ghcr-image=ghcr.io/you/app

# Resume after a fix
convoy resume                           # continue the most recent paused/failed run
convoy resume <run-id> --fresh          # replay from scratch instead

# End-to-end
convoy ship <path-or-url>               # plan + save + apply in one shot
convoy status [run-id]                  # auto-spawns the viewer, prints the live URL
```

Environment: `ANTHROPIC_API_KEY` (AI surfaces), `CONVOY_WEB_URL` (viewer base URL, default `http://localhost:3737`), `CONVOY_STATE_PATH` (SQLite, default `.convoy/state.db`), `CONVOY_PLANS_DIR` (default `.convoy/plans`), `CONVOY_MCP_PORT` (HTTP transport, default `3738`).

---

## Repo layout

```
convoy/
├── src/
│   ├── core/               Orchestrator, stages, medic agent, rehearsal +
│   │                       GitHub runners, SQLite state, key resolver (BYOK)
│   ├── planner/            Scanner (service graph), per-lane picker, enricher
│   ├── adapters/           fly/ vercel/ railway/ cloudrun/ vps/ — one interface
│   ├── mcp/                MCP server: stdio (index.ts) + HTTP (http.ts) transports
│   └── cli.ts              commander entrypoint
├── plugin/                 Claude Code plugin — slash commands, agents, .mcp.json
├── scripts/                get (curl installer) · install (full setup) · mcp-server
├── web/                    Next.js 15 viewer, port 3737 — projects dashboard,
│                           run timelines, approvals, medic spotlight
├── demo-app/               Breakable Express service (DEMO_MODE=buggy flips a bug)
└── docs/                   architecture.md · principles.md · rollback-proof.md
```

---

## Principles (non-negotiable)

1. **We ship your code. We do not rewrite your code.** Convoy authors only deployment-surface files — Dockerfile, platform manifest, CI workflow, `.env.schema`. Everything in `src/`, `app/`, `lib/`, `tests/` is off-limits, enforced by the provenance manifest, the filesystem containment check, and the medic's system prompt.
2. **Every forward action has a pre-staged reverse.** No step runs without a named, measured rollback path.
3. **Evidence over assertion.** Health is proven with independent signals — real probes, real metrics — not the platform API's return code.

See [`docs/principles.md`](./docs/principles.md) for the rationale and [`docs/architecture.md`](./docs/architecture.md) for the full design.

---

## Real shipping — platform prerequisites

All optional; Convoy preflights each and fails loud with the exact remedy.

```bash
gh auth login            # GitHub — real PRs (repo + workflow scopes)
fly auth login           # Fly.io  (brew install flyctl)
vercel login             # Vercel  (npm i -g vercel)
# VPS — just SSH access; convoy vps bootstrap installs the rest
```

Per target repo: a `github.com` remote you can write to (for real PRs), and service secrets in `<target>/.env.convoy-secrets` (gitignored — staged via the platform CLI, never committed).

## Verification

```bash
npm test
npm run typecheck
(cd web && npm run typecheck)
```

---

## License

MIT.
