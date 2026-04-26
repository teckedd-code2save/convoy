# Convoy — Claude Code plugin

Ship any repo end-to-end from inside Claude Code. Slash commands drive the real [Convoy](https://github.com/teckedd-code2save/convoy) CLI — clone, plan, open a real PR, rehearse locally, deploy to Fly or Vercel, auto-rollback on breach. You approve at the gates; Convoy does the work.

## Install in 60 seconds

Copy-paste these four commands into a terminal. At the end, every Claude Code session has `/convoy:*` available without `--plugin-dir`, `CONVOY_HOME` is set permanently, and your shell gets raw CLI helpers (`convoy`, `convoy-ship-here`).

```bash
# 1. Clone Convoy (anywhere you like; path doesn't matter after step 3)
git clone https://github.com/teckedd-code2save/convoy.git
cd convoy
npm install && (cd web && npm install)

# 2. Add an Anthropic API key (optional, enables Opus narratives + the medic agent loop)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. One-shot setup — writes CONVOY_HOME to your shell profile and
#    registers the plugin as a local-path marketplace in Claude Code.
#    It also installs raw CLI helpers: `convoy` and `convoy-ship-here`.
./scripts/install

# 4. Reload your shell + restart Claude Code
source ~/.zshrc     # or ~/.bashrc, whichever the script used
```

Inside any Claude Code session, verify:

```
/convoy:where
```

Should print where Convoy is installed, state DB size, recent plans, whether the web viewer is live. No `--plugin-dir` flag needed — the plugin is registered globally.

Outside Claude Code, the installer also gives you:

```bash
convoy status
convoy ship /absolute/path/to/repo
convoy-ship-here --demo
```

`convoy-ship-here` always passes the current directory as an absolute path, so it avoids the `.`-resolves-from-`$CONVOY_HOME` footgun.

If you'd rather run without the global install (one-off / testing), the old path still works:

```bash
CONVOY_HOME=/path/to/convoy claude --plugin-dir /path/to/convoy/plugin
```

`/plugin` inside Claude Code shows registered marketplaces + enabled plugins. `convoy@convoy` should be enabled after setup. `/reload-plugins` re-scans if you've just run `./scripts/install` in an existing session.

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
| `/convoy:where` | **Run this first if you're lost.** Prints where Convoy is installed, what's in state, whether the web viewer is up. One-shot orientation. |
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

For raw terminal use without slash commands:

```bash
convoy ship /absolute/path/to/repo
convoy-ship-here --no-auto-approve
```

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

## Paste this into your project's CLAUDE.md

For teams who use Convoy from a separate project (not inside the Convoy repo itself): paste this block into your project's `CLAUDE.md`. It tells every Claude Code session in that project where Convoy lives and stops the agent from `find`-ing around looking for state.

```markdown
## Convoy (deployment agent)

This project uses [Convoy](https://github.com/teckedd-code2save/convoy) as its deployment agent. Slash commands: `/convoy:where` (orientation), `/convoy:ship <target>`, `/convoy:ship-status`, `/convoy:ship-rollback`.

### Convoy state — authoritative paths (do not explore)

- **CONVOY_HOME** — `${CONVOY_HOME:-$HOME/convoy}` (Convoy CLI source + all state live here, regardless of which project is the deploy target)
- **State DB** — `$CONVOY_HOME/.convoy/state.db` (SQLite: runs, events, approvals, medic chat)
- **Saved plans** — `$CONVOY_HOME/.convoy/plans/<plan-id>.json`
- **Cloned targets** — `$CONVOY_HOME/.convoy/clones/github.com/<owner>/<repo>/`
- **Web viewer** — `http://localhost:3737` (auto-spawned by the CLI on plan/apply)
- **Web server log** — `$CONVOY_HOME/.convoy/web-server.log`

Never `find`, `ls`, or `grep` to rediscover these — they are fixed. Run `/convoy:where` to print a live snapshot if context is needed.

### Invoking Convoy

Every Convoy command runs from `$CONVOY_HOME`, not from this project's directory:

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- <subcommand> <args>
```

For `ship` with a local target, pass an absolute path. Relative paths like `.` or `./app` will resolve from `$CONVOY_HOME`, not from the directory Claude was launched in.

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path before running anything.

### Principles Convoy enforces

1. **Ships your code, does not rewrite it.** Convoy only authors Dockerfile, platform manifest, `.env.schema`, CI workflow, `infra/` Terraform, and `.convoy/*`. Medic diagnoses code-level failures and pauses for the developer to fix — it never edits `src/`.
2. **Every forward action has a pre-staged reverse.** Rollback paths are real.
3. **No autonomous probing.** Convoy doesn't call `fly secrets list`, `vercel env ls`, etc. — operator declarations are the source of truth for platform state.
```

## More

- [Root README](../README.md) — product story and full architecture
- [`docs/architecture.md`](../docs/architecture.md) — pipeline + component diagrams
- [`docs/principles.md`](../docs/principles.md) — rationale for the three rules
- [`docs/rollback-proof.md`](../docs/rollback-proof.md) — end-to-end evidence that auto-rollback is real, not scripted
