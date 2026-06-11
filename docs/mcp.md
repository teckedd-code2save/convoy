# Convoy MCP server

Convoy ships an [MCP](https://modelcontextprotocol.io) server that exposes the whole deployment pipeline as tool calls. Any MCP client — Claude Code mid-session, Cursor, a CI webhook runner — can plan, deploy, observe, approve, and diagnose deployments without a human at the CLI.

It is the same product underneath: the tools wrap the same planner, the same orchestrator subprocess, and the same SQLite state (`.convoy/state.db`) that `convoy` CLI and the web viewer use. An agent kicking off an apply over MCP shows up live at `http://localhost:3737/runs/<id>` like any other run.

## Transports

### stdio (Claude Code / local dev)

```bash
claude mcp add convoy -- npm run --silent mcp --prefix /path/to/convoy
```

Claude Code spawns the server as a subprocess. `ANTHROPIC_API_KEY` is read from Convoy's gitignored `.env`; without it the planner and medic fall back to deterministic output.

### Streamable HTTP (CI runners / hosted)

```bash
npm run mcp-http                          # listens on :3738
CONVOY_MCP_PORT=3739 npm run mcp-http     # custom port
```

Stateless — no session IDs, no in-memory state between requests. All durable state is in `.convoy/state.db`, so CI workers and hosted agents can interleave calls safely.

Connect a client:
```bash
claude mcp add convoy-http --transport sse http://localhost:3738/mcp
```

Health check: `GET http://localhost:3738/health` → `{ ok: true, transport: "http", port: 3738 }`.

Both transports call the same `registerConvoyTools` function in `src/mcp/server.ts` — tool behaviour is identical.

## Tool reference

| Tool | Input | What it does |
| --- | --- | --- |
| `convoy_plan` | `repoPath`, `platform?`, `workspace?` | Scans a repository, builds + saves a deployment plan. Returns `planId`, chosen platform, deployability verdict, blockers. |
| `convoy_list_plans` | — | Lists saved plans: `planId`, target, platform, createdAt. |
| `convoy_apply` | `planId`, `autoApprove?`, `realRehearsal?`, `realAuthor?`, `realFly?`, `realVpsGhcr?` | Spawns the pipeline detached and returns the `runId` + watch URL immediately. Real stages are opt-in; default is the scripted pipeline (no credentials needed). |
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

To make stages real instead of scripted, opt in per stage:

```json
{ "planId": "…", "realRehearsal": true, "realAuthor": true, "realFly": true }
```

### GHCR + VPS deploy (ship-to-vps pattern)

```json
{
  "planId": "…",
  "realVpsGhcr": {
    "host": "deploy@vps.example.com",
    "cwd": "/local/path/to/my-app",
    "deployRoot": "/opt/my-app",
    "appName": "my-app",
    "imageRef": "ghcr.io/myorg/my-app",
    "ghcrUsername": "myorg-bot",
    "ghcrToken": "ghp_...",
    "runMigrations": true,
    "manageCaddy": true,
    "domain": "my-app.example.com",
    "bakeWindowSeconds": 120
  }
}
```

Builds the Docker image locally, pushes to GHCR with a timestamp tag, logs into GHCR on the VPS, runs migrations (if `runMigrations: true`), and rolls the compose service. Pre-staged reverse: the image tag running before the deploy is captured and used if the bake window breaches.

When `manageCaddy: true`, Convoy also:
1. Ensures `/etc/caddy/Caddyfile` has `import /etc/caddy/sites/*.caddy`
2. Writes `/etc/caddy/sites/<appName>.caddy` as a reverse proxy to `localhost:<containerPort>`
3. Validates and reloads Caddy

Prerequisites: `docker` and `ssh` installed locally; Docker logged in to GHCR (handled automatically); SSH access to the VPS; Caddy installed on the VPS (if `manageCaddy: true`).
