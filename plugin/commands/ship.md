---
description: Ship a repo end-to-end — clone, plan, author a PR, rehearse, deploy, observe. Real by default. Human approves at each gate.
argument-hint: <github-url-or-local-path> [--workspace=<subdir>] [--no-auto-approve] [--platform=fly|vercel] [--demo]
---

You are driving a Convoy deployment. The user wants you to ship whatever they pointed `$ARGUMENTS` at, end to end.

## State & paths — do NOT explore the filesystem

Convoy's state lives at fixed paths. Do not `find`, `ls`, or `grep` to discover them — they are authoritative:

- **CONVOY_HOME** — `${CONVOY_HOME:-$HOME/convoy}` (Convoy CLI source + all state)
- **State DB** — `$CONVOY_HOME/.convoy/state.db` (SQLite: runs, events, approvals, medic chat)
- **Saved plans** — `$CONVOY_HOME/.convoy/plans/<plan-id>.json`
- **Cloned targets** — `$CONVOY_HOME/.convoy/clones/github.com/<owner>/<repo>/`
- **Web viewer** — `http://localhost:3737` (auto-spawned by the CLI on plan/apply)
- **Web server log** — `$CONVOY_HOME/.convoy/web-server.log`

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path to their Convoy checkout **before** running anything else. Never cd into a sibling project directory to look for Convoy — the CLI is always invoked from `$CONVOY_HOME`, regardless of what target you're shipping.

## Run the CLI

Before invoking Convoy, normalize any relative local target to an absolute path based on the user's current session cwd. Do not pass `.` / `..` / `./foo` / `../foo` through unchanged after switching to `$CONVOY_HOME`, or Convoy will resolve them relative to its own repo.

Examples:

- If the user is in `/work/softpharmamanager` and says `/convoy:ship .`, invoke Convoy with `/work/softpharmamanager`.
- If the user says `/convoy:ship ./apps/web`, invoke Convoy with `/work/softpharmamanager/apps/web`.
- GitHub URLs and `owner/repo` shorthands should be forwarded unchanged.

Use the Bash tool to run:

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- ship $ARGUMENTS
```

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path to their Convoy checkout and retry with that as `CONVOY_HOME`.

Keep the Bash tool call in the **foreground** — Convoy streams progress line-by-line, and the pipeline pauses at approval gates waiting for the operator to click in the web UI. You should NOT background the process.

## What Convoy will do

1. **Resolve the target** — clones a GitHub URL into `.convoy/clones/` (cached) or uses a local path directly.
2. **Plan** — scanner reads the repo, picker scores platforms, author drafts the deployment surface (Dockerfile, platform manifest, `.env.schema`, `.convoy/manifest.yaml`). Opus 4.7 enriches the narrative if `ANTHROPIC_API_KEY` is set.
3. **Preflight** — checks `gh auth`, start command, and the platform CLI (flyctl for Fly, vercel for Vercel). Hard-fails with a clear remedy if anything's missing.
4. **Author (real)** — creates a branch, writes the authored files, commits, pushes, opens a real pull request on the target's GitHub repo.
5. **Pause at `merge_pr` approval** — if the user passed `--no-auto-approve`. Otherwise auto-approves for them.
6. **On approval** — Convoy auto-merges via `gh pr merge --squash --delete-branch` (unless `--no-auto-merge`).
7. **Rehearsal (real)** — spawns the target locally, `pnpm install` / `npm ci` / whatever, builds, boots, probes `/health` and `/metrics`, captures real stdout/stderr.
8. **On rehearsal breach** — medic diagnoses with Opus, produces a diagnosis card, pauses the run (`awaiting_fix`).
9. **Pause at `promote` approval** — human decides whether to go to production.
10. **Deploy (real)** — Fly canary or Vercel preview+prod, depending on the platform the plan chose.
11. **Observe** — polls the live URL for the bake window.
12. **Auto-rollback** on SLO breach, no human needed.

## Where to approve

After you start the pipeline, it will print an approval URL pattern. Tell the user:

> Open `http://localhost:3737/runs/<run-id>` to see the run timeline and click **Approve merge_pr** when you're ready. The PR diff is at the `pr_url` listed in the author stage's progress event.

If the web viewer isn't running, instruct the user to start it in a separate terminal:

```bash
cd "${CONVOY_HOME:-$HOME/convoy}/web" && npm run dev
```

## Principles you MUST enforce

1. **Convoy never modifies developer source code.** It authors only Dockerfile, platform manifests, CI workflow, `.env.schema`, `infra/` Terraform, and `.convoy/*`. If the user asks to touch source via this command, refuse and tell them Convoy is not a coding agent — diagnose and hand back, don't rewrite.
2. **Every forward action has a pre-staged reverse.** Rollback is a real command on every platform (Fly: deploy prior image. Vercel: alias prior deployment). Don't promise what you don't have.
3. **Evidence over assertion.** When a stage says "healthy", it means probes returned 200 and p99 is within the baseline. Don't narrate outcomes the tool hasn't produced.

## If the run fails or pauses

- **`awaiting_approval`**: a gate is open, tell the user to click Approve.
- **`awaiting_fix`**: medic diagnosed a code-level failure. Summarize the diagnosis card (root cause, `file:line`, suggested fix). The fix is the developer's — Convoy resumes after they push a commit and re-run.
- **`rolled_back`**: Convoy auto-reverted. Summarize the breach reason and the restored release.
- **`failed`**: unexpected error. Include the stderr and propose what to check.

If `gh`, `flyctl`, or `vercel` auth is missing, the preflight output includes the exact remedy command — surface it verbatim.
