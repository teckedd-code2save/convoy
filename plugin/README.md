# Convoy — Claude Code plugin

`convoy` as a Claude Code plugin. Adds slash commands and subagents that drive the full deployment flow without leaving your terminal.

## Commands

| Slash command | What it does |
|---|---|
| `/convoy:ship <repo-url> [--platform=X]` | Drives the full pipeline — scan → pick → author → rehearse → canary → promote → observe. |
| `/convoy:ship-status [run-id]` | Terse live status of a run (defaults to most recent). |
| `/convoy:ship-rollback <service>` | Privileged: rolls back the most recent successful deployment. Always requires approval. |

## Subagents

Each slash command delegates to typed subagents. You can invoke them directly via the Agent tool too.

| Agent | Role |
|---|---|
| `scanner` | Parses the repo into platform-neutral signals. Read-only. |
| `picker` | Scores supported platforms, respects explicit choice and existing config. |
| `author` | Drafts only Convoy-authored deployment files. Never touches `src/`. |
| `deployer` | Executes platform adapter calls. Reports faithfully, does not retry on its own. |
| `medic` | On failure: reads logs, classifies config-vs-code, patches Convoy files or hands the developer a diagnosis card. Never modifies code outside the provenance manifest. |
| `correlator` | Watches golden signals during canary/observe. Evidence-based go/no-go, not platform-callback-based. |

## Install for local testing

From the `convoy` repo root:

```bash
claude --plugin-dir ./plugin
```

Then in the session:

```
/convoy:ship https://github.com/acme/widget-api
```

## Reload after editing a `.md` file

```
/reload-plugins
```

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json        Plugin manifest (name, version, description)
├── commands/              Auto-discovered slash commands
│   ├── ship.md
│   ├── ship-status.md
│   └── ship-rollback.md
├── agents/                Auto-discovered subagents
│   ├── scanner.md
│   ├── picker.md
│   ├── author.md
│   ├── deployer.md
│   ├── medic.md
│   └── correlator.md
└── .mcp.json              Platform MCP servers (stub — implementations are in-progress)
```

## Principles that bind every agent

1. **We ship your code. We do not rewrite your code.** No agent may author files outside the Convoy-owned list (Dockerfile, platform manifests, CI workflow, `.env.schema`, `infra/*.tf`, `.convoy/*`).
2. **Every forward action has a pre-staged reverse.** No stage may proceed without a named, measured rollback path.
3. **Evidence over assertion.** Platform OK ≠ healthy. Probes, metrics, log fingerprints, traffic replay decide.

See the [root README](../README.md) for product context and the [architecture doc](../docs/architecture.md) for the pipeline diagram.
