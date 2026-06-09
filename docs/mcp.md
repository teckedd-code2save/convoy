# Convoy MCP server

Convoy ships an [MCP](https://modelcontextprotocol.io) server that exposes the whole deployment pipeline as tool calls. Any MCP client — Claude Code mid-session, Cursor, a CI webhook runner — can plan, deploy, observe, approve, and diagnose deployments without a human at the CLI.

It is the same product underneath: the tools wrap the same planner, the same orchestrator subprocess, and the same SQLite state (`.convoy/state.db`) that `convoy` CLI and the web viewer use. An agent kicking off an apply over MCP shows up live at `http://localhost:3737/runs/<id>` like any other run.

## Registering in Claude Code

```bash
claude mcp add convoy -- npm run --silent mcp --prefix /path/to/convoy
```

The server uses stdio transport — Claude Code spawns it as a subprocess. `ANTHROPIC_API_KEY` is read from Convoy's gitignored `.env` (the npm script passes `--env-file-if-exists=.env` to tsx); without it the planner and medic fall back to deterministic output.

Tool registration is transport-agnostic (`registerConvoyTools` in `src/mcp/server.ts`), so a Streamable HTTP endpoint for hosted/CI use can be added without touching tool logic.

## Tool reference

| Tool | Input | What it does |
| --- | --- | --- |
| `convoy_plan` | `repoPath`, `platform?`, `workspace?` | Scans a repository, builds + saves a deployment plan. Returns `planId`, chosen platform, deployability verdict, blockers. |
| `convoy_list_plans` | — | Lists saved plans: `planId`, target, platform, createdAt. |
| `convoy_apply` | `planId`, `autoApprove?`, `realRehearsal?`, `realAuthor?`, `realFly?` | Spawns the pipeline detached and returns the `runId` + watch URL immediately. Real stages are opt-in; default is the scripted pipeline (no credentials needed). |
| `convoy_status` | `runId?`, `eventLimit?` | Run status, current stage, recent timeline events, and pending approval gates. No `runId` = most recent run. |
| `convoy_approve` | `runId`, `approvalId`, `decision` | Approves or rejects a pending gate (`open_pr`, `merge_pr`, `promote`, `stage_secrets`). The paused pipeline picks the decision up from SQLite. |
| `convoy_diagnose` | `runId?` | The medic's diagnosis for a failed run: root cause, classification, confidence, suggested fix, captured failure logs. No `runId` = most recent failed/awaiting_fix run. |
| `convoy_list_runs` | `limit?` | Recent runs with status, platform, repo, live URL. |

All tools return JSON in a text content block; failures return `isError: true` with a plain message instead of throwing.

## Example agent flow

A typical session — the agent drives the whole loop:

1. **Plan** — `convoy_plan { repoPath: "./demo-app" }` → returns `planId`, `platform: "fly"`, `deployable: true`.
2. **Apply** — `convoy_apply { planId }` → returns `runId` and `watchUrl`; the pipeline runs in the background.
3. **Watch** — poll `convoy_status { runId }` until `status` is `awaiting_approval`. The response includes `pendingApprovals: [{ id, kind: "open_pr", ... }]`.
4. **Approve** — `convoy_approve { runId, approvalId, decision: "approved" }` → the pipeline resumes through canary → promote → observe.
5. **Diagnose** (on failure) — if `status` lands on `failed` or `awaiting_fix`, `convoy_diagnose { runId }` returns the medic's root cause and suggested fix; the agent can apply the code fix and re-apply the plan.

To make stages real instead of scripted, opt in per stage exactly like the CLI flags:

```json
{ "planId": "…", "realRehearsal": true, "realAuthor": true, "realFly": true }
```

These require the same prerequisites as `--real-rehearsal` / `--real-author` / `--real-fly` (a bootable target, `gh` auth, `flyctl` auth) — preflight refuses with a clear remedy if anything is missing, and the refusal is captured in `.convoy/apply-<planId>.log`.
