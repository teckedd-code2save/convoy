# Convoy — Claude Code plugin

Ship any repo end-to-end from inside Claude Code. Slash commands drive the real [Convoy](https://github.com/teckedd-code2save/convoy) CLI — clone, plan, open a real PR, rehearse locally, deploy to Fly or Vercel, auto-rollback on breach. You approve at the gates; Convoy does the work.

## Install in 60 seconds

Copy-paste these four commands into a terminal. You'll have the plugin running in a Claude Code session at the end.

```bash
# 1. Clone Convoy
git clone https://github.com/teckedd-code2save/convoy.git ~/convoy
cd ~/convoy && npm install && (cd web && npm install)

# 2. Add an Anthropic API key (optional, enables Opus narratives + medic)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Start the web viewer in its own terminal (needed for approvals)
(cd ~/convoy/web && npm run dev) &

# 4. Launch Claude Code with the plugin loaded
claude --plugin-dir ~/convoy/plugin
```

Inside Claude Code, verify the plugin loaded:

```
/plugin
```

`convoy` should appear under **Installed**. If not, check the **Errors** tab, or run `/reload-plugins` to re-scan.

## First try

```
/convoy:ship-status
```

Shows the status of the most recent Convoy run (or tells you there are none yet).

```
/convoy:ship ./path/to/your/repo --demo
```

Runs the full 7-stage pipeline in scripted demo mode — no PR opens, no real deploy, but you see the entire flow and approval loop in under 15 seconds. Safe to run against any path.

```
/convoy:ship https://github.com/you/your-repo --no-auto-approve
```

The real thing. Convoy clones, plans, and:

1. Opens a real pull request on `your-repo` with only Convoy-authored deployment files (`Dockerfile`, platform manifest, `.env.schema`, `.convoy/manifest.yaml`).
2. Pauses. You approve `merge_pr` in the web UI (http://localhost:3737/runs/&lt;run-id&gt;).
3. On approval, Convoy auto-merges via `gh pr merge --squash --delete-branch`.
4. Rehearses locally (spawns the target, probes real endpoints, scrapes real metrics, feeds real logs to medic on breach).
5. Pauses at `promote`.
6. Deploys to Fly or Vercel (whichever the picker chose). Real `flyctl deploy --strategy=canary` or `vercel deploy --prod`.
7. Observes the live URL for 60s bake window. Auto-rollback on SLO breach.

## Prerequisites per feature

Convoy preflights these for you and fails loud with the exact remedy if anything's missing. You don't need all of them — just whichever paths you want real:

| Feature | Install |
|---|---|
| **Real PR creation** | `brew install gh && gh auth login` (needs `repo` + `workflow` scopes) |
| **Real local rehearsal** | Node.js 20+ (+ the target's own runtime — pnpm/yarn/python/etc.) |
| **Real Fly deploys** | `brew install flyctl && fly auth login` |
| **Real Vercel deploys** | `npm i -g vercel && vercel login` |
| **Opus narratives + medic** | `ANTHROPIC_API_KEY` in `~/convoy/.env` |

Skip any of them with the matching `--no-*` flag (e.g. `--no-real-author` to skip PR creation) or pass `--demo` to script all stages.

## Slash command reference

| Command | What it does |
|---|---|
| `/convoy:ship <target>` | Plan + apply end-to-end. Accepts a local path or a GitHub URL / `owner/repo`. Real by default. |
| `/convoy:ship-status [run-id]` | Show the status of a run. Defaults to the most recent. |
| `/convoy:ship-rollback <service>` | Explicit rollback instructions. Automatic rollback is already wired into the observe stage. |

Flags on `/convoy:ship` (most useful):

| Flag | Effect |
|---|---|
| `--demo` | Scripted pipeline — no PR, no subprocess, no deploy. Safe for first-try. |
| `--no-auto-approve` | Pauses at every approval gate. Drive from the web UI. |
| `--workspace <subdir>` | Target a subdirectory (e.g. `apps/web`) in a monorepo. |
| `--platform <fly\|vercel>` | Force a platform instead of letting the picker decide. |
| `--fly-app <name>` | Override the auto-generated Fly app name. |
| `--no-auto-merge` | On approval, wait for you to merge the PR manually on GitHub. |

Full list: `cd ~/convoy && npm run convoy -- ship --help`

## Principles

The plugin refuses any slash-command request that conflicts with Convoy's three principles:

1. **We ship your code. We do not rewrite your code.** Convoy only authors files in its provenance manifest — `Dockerfile`, platform manifests, CI workflow, `.env.schema`, `infra/` Terraform, `.convoy/*`. If a stage fails because of code in `src/` or equivalent, medic produces a diagnosis card and pauses — the fix is the developer's.
2. **Every forward action has a pre-staged reverse.** Rollback is real on every supported platform (Fly: redeploy the prior image. Vercel: alias the prod domain to a prior deployment).
3. **Evidence over assertion.** Health claims are backed by real probes and real metrics.

## Troubleshooting

**`/convoy:ship-status` returns "Unknown command"**: You didn't launch Claude Code with `--plugin-dir`. Exit and re-launch per step 4 above.

**`/plugin` shows convoy with an error badge**: Check the Errors tab for the parse message. Common causes: edit a command file mid-session (run `/reload-plugins`), invalid frontmatter.

**`ship-status` says "command not found: convoy" or similar**: The plugin shells out using `$CONVOY_HOME` (default: `~/convoy`). If you cloned somewhere else, set `CONVOY_HOME` to that path before launching Claude Code.

```bash
CONVOY_HOME=/some/other/path claude --plugin-dir /some/other/path/plugin
```

**Rehearsal or deploy fails**: medic produces a diagnosis card. The run status becomes `awaiting_fix` (for code-level issues) or `rolled_back` (for SLO breaches on production). Both are surfaced in the web UI at `http://localhost:3737/runs/<run-id>` with the reason inline.

## More

- [Root README](../README.md) — product story and full architecture
- [`docs/architecture.md`](../docs/architecture.md) — pipeline + component diagrams
- [`docs/principles.md`](../docs/principles.md) — rationale for the three rules
- [`docs/rollback-proof.md`](../docs/rollback-proof.md) — end-to-end evidence that auto-rollback is real, not scripted
