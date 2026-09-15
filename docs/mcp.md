# Convoy MCP server

Convoy ships an [MCP](https://modelcontextprotocol.io) server that exposes the whole deployment pipeline as tool calls. Any MCP client — Claude Code mid-session, Cursor, a CI webhook runner — can plan, deploy, observe, approve, and diagnose deployments without a human at the CLI.

It is the same product underneath: the tools wrap the same planner, the same orchestrator subprocess, and the same SQLite state (`.convoy/state.db`) that `convoy` CLI and the web viewer use. An agent kicking off an apply over MCP shows up live at `http://localhost:3737/runs/<id>` like any other run.

## Transports

### stdio (trusted local clients)

Use `npm run --silent mcp --prefix /path/to/convoy` as the server command in any client supporting MCP stdio. Local stdio retains the full toolset and the permissions of its host process. The external client can be Codex, Claude Code, Cursor, or another compatible agent; Convoy's optional built-in reasoning still uses Anthropic and falls back to deterministic output without a key.

### Streamable HTTP (one trusted workspace)

Set independent bearer credentials in the server environment or secret manager:

| Variable | Permission |
| --- | --- |
| `CONVOY_MCP_READ_TOKEN` | List plans/runs, status, diagnosis, rollback preview |
| `CONVOY_MCP_EXECUTE_TOKEN` | Read tools plus plan, apply, orient |
| `CONVOY_MCP_APPROVAL_TOKEN` | Read tools plus approve/reject gates |

Configure at least one. Each credential must have at least 32 non-whitespace characters, with a different random value for each role. `CONVOY_MCP_TOKEN` is a compatibility alias for the execution credential, not an approval credential. Missing or invalid configuration refuses startup. Rotate a credential in the secret source and restart the service to revoke the previous value.

Start with `npm run mcp-http`. The default address is `127.0.0.1:3738`; `CONVOY_MCP_HOST` and `CONVOY_MCP_PORT` override it. A remote installation must supply HTTPS and network access controls through its deployment environment.

Configure compatible clients as follows:

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP (not legacy SSE) |
| URL | `http://127.0.0.1:3738/mcp`, or the HTTPS address you configured |
| Header | `Authorization: Bearer <credential for this client's role>` |

The endpoint authenticates every request. Each stateless POST gets a separate MCP server and transport, so repeated and concurrent requests do not reuse transport state or another caller's role. `GET /health` is a minimal public health check. Requests with an Origin header are rejected unless the exact origin appears in the comma-separated `CONVOY_MCP_ALLOWED_ORIGINS` setting. Request bodies are limited to 1 MiB.

Execution credentials cannot call `convoy_approve` or use `autoApprove`. Keep the approval credential with the operator or a separately controlled approval service. Raw `realVpsGhcr.ghcrToken` values are rejected over HTTP; use `ghcrTokenEnv` instead. HTTP also disables local-process rehearsal, direct rollback execution, onboarding, bootstrap, and connection setup. Direct rollback needs a run-bound approval before remote exposure; rehearsal needs an isolated worker. Use trusted local CLI/stdio for these workflows until those boundaries exist.

This transport serves a **single trusted workspace**. Tokens do not yet isolate projects, filesystem paths, VPS targets, or tenants. Child processes receive a filtered environment without MCP bearer credentials, but they are not an OS isolation boundary. Do not expose this as a multi-customer execution service. External-reasoning injection and two-client live acceptance remain pilot gates.

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

A typical session — the execution client requests work and a separate operator approves:

1. **Plan** — `convoy_plan { repoPath: "./demo-app" }` → returns `planId`, `platform: "fly"`, `deployable: true`.
2. **Apply** — `convoy_apply { planId }` → returns `runId` and `watchUrl`; the pipeline runs in the background.
3. **Watch** — poll `convoy_status { runId }` until `status` is `awaiting_approval`. The response includes `pendingApprovals: [{ id, kind: "open_pr", ... }]`.
4. **Approve** — the approval client calls `convoy_approve { runId, approvalId, decision: "approved" }` → the pipeline resumes through canary → promote → observe.
5. **Diagnose** (on failure) — if `status` lands on `failed` or `awaiting_fix`, `convoy_diagnose { runId }` returns the medic's root cause and suggested fix; the agent can apply the code fix and re-apply the plan.

For trusted local stdio, opt in per real stage. HTTP rejects `realRehearsal` until an isolated worker is configured:

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
    "ghcrTokenEnv": "GHCR_TOKEN",
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

Set the referenced GHCR credential on the server before applying. Allowed references are `GHCR_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`. New MCP-generated configuration files persist only the reference; the CLI resolves it from its execution environment. Local callers using a raw token remain compatible, but their newly written MCP configuration also omits the secret. Existing configuration files from earlier versions are not automatically cleaned up.
