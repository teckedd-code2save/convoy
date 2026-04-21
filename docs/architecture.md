# Architecture

## Pipeline

A Convoy run is a sequence of stages. Each stage produces evidence; the next stage runs only if the evidence passes policy.

```
scan → pick → author → rehearse → canary → promote → observe
                        │           │         │         │
                        └─ medic ───┴─ rollback ────────┘
```

| Stage | Responsibility | Gate |
|---|---|---|
| **scan** | Detect framework, runtime, topology, dependencies, deployment signals. | Signals complete |
| **pick** | Score available platforms against signals; respect user override or existing platform config. | One platform chosen with stated reasoning |
| **author** | Draft missing deployment config (Dockerfile, platform manifest, CI) into a pull request. Never touches developer code. | Pull request opened and human-approved |
| **rehearse** | Deploy to an ephemeral twin on the chosen platform. Run health checks, smoke tests, migration dry-run, synthetic load. | All checks green |
| **canary** | Promote to a fraction of production traffic. Correlator watches golden signals versus baseline for the bake window. | Signals within policy |
| **promote** | Progressive rollout to full production. | No regression detected at each step |
| **observe** | Post-deploy watch window. Continues to monitor; can trigger rollback. | SLO-healthy for the configured window |

The **medic** subagent activates on any stage failure: reads logs, diagnoses root cause, and either patches Convoy-authored config and retries, or hands the developer a diagnosis card for code-level issues.

The **rollback** path is pre-staged at every stage. Forward progress is never permitted without a named, measured reverse.

## Subagents

| Agent | Role |
|---|---|
| **scanner** | Parses repo into signals. Platform-neutral. |
| **picker** | Scores platforms. Respects explicit user choice and existing platform config. |
| **author** | Drafts deployment surface files in a pull request. Only owns files it creates. |
| **deployer** | Delegates to the chosen platform adapter. |
| **medic** | Diagnoses failures. Iterates on Convoy-authored config; hands code issues back to developer. |
| **correlator** | Reads metrics during canary and observe stages. Decides go/no-go between promotion steps. |
| **policy** | Evaluates rules — freeze windows, tier, required approvers, blast-radius budget. |

## Adapter model

Platform-specific concerns live behind a single interface. `agent-core` is platform-neutral.

```
agent-core
    │
    ├─ adapters/
    │   ├─ fly        — wraps flyctl
    │   ├─ railway    — wraps railway CLI and API
    │   ├─ vercel     — wraps vercel CLI
    │   └─ cloudrun   — wraps gcloud run
    │
    └─ mcp servers one-per-adapter, plus github + metrics
```

Each adapter implements:

- `deploy(config)` — produce a live deployment.
- `createEphemeral(config) → id` — spin up a throwaway twin for rehearsal.
- `destroyEphemeral(id)` — tear down the twin.
- `rollback(targetRelease)` — revert to a previous release.
- `readLogs(deploymentId, since) → stream` — structured log stream for medic.
- `healthCheck(deploymentId) → result` — synchronous readiness probe.

## Provenance

Convoy tracks which files it authored in `.convoy/manifest.yaml`. A file is one of:

- **convoy-authored** — drafted by Convoy, may be iterated on autonomously.
- **developer-authored** — pre-existing or subsequently edited by a human. Read-only to Convoy.

If a developer edits a Convoy-authored file, its provenance flips permanently. Convoy never claims a file back.

## State

Run state — events, approvals, artifacts, decisions — is persisted in a single SQLite database at `.convoy/state.db` for local runs, or a shared database for team deployments. The schema models `Run`, `RunEvent`, `Approval`, `Artifact`, `Decision`.

## Interfaces

- **CLI and Claude Code plugin** — primary operator surface. `/convoy ship <repo>` and friends.
- **Web viewer** — live timeline, approval cards, log tail, rollback controls. Server-sent events over `/api/runs/[id]/stream`.
- **MCP servers** — one per integration, exposing tools to the agent.
- **Audit log** — append-only, signed, replayable for incident review.
