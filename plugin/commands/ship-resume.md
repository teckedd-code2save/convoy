---
description: Re-apply the plan from a paused or failed Convoy run after fixing the code. Defaults to the most recent run.
argument-hint: [run-id-or-prefix]
---

The user has fixed the code that caused a Convoy run to pause (`awaiting_fix`) or fail. They want to rerun the same plan against the new HEAD.

## State & paths — do NOT explore the filesystem

Convoy's state lives at fixed paths. Do not `find`, `ls`, or `grep` to discover them — they are authoritative:

- **CONVOY_HOME** — `${CONVOY_HOME:-$HOME/convoy}` (Convoy CLI source + all state)
- **State DB** — `$CONVOY_HOME/.convoy/state.db` (SQLite: runs, events, approvals, medic chat)
- **Saved plans** — `$CONVOY_HOME/.convoy/plans/<plan-id>.json`
- **Web viewer** — `http://localhost:3737` (auto-spawned by the CLI)

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path to their Convoy checkout.

## Run the CLI

Keep the Bash tool call in the **foreground** — Convoy streams progress line-by-line and pauses at approval gates waiting for the operator to click in the web UI.

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- resume $ARGUMENTS
```

`$ARGUMENTS` is optional. With no run id, Convoy resumes the most recent run. Accepts the same flags as `apply` (`--probe-path`, `--platform`, `--real-*`, `--inject-failure`, etc.).

## What `resume` does

1. Looks up the target run (most recent by default, or the id/prefix passed in `$ARGUMENTS`).
2. Refuses to resume if the run is `running`, `pending`, or `succeeded` — those aren't resumable. For `succeeded`, suggest `convoy apply <planId>` to start a fresh run instead.
3. Prints the prior failure reason from the run record so the operator sees what they're retrying.
4. Re-applies the run's saved plan. **A new run row is created** — the previous one is preserved as history. Stages are not idempotent across partial state, so resume always re-runs from `scan`.
5. Auto-spawns the web viewer if it's down so the timeline URL printed at run start actually resolves.

## Common resume contexts

- **`awaiting_fix` after rehearsal breach** — medic diagnosed a code-level failure, the operator fixed and committed. Resume retries rehearsal against the new HEAD.
- **`failed` from a transient infra blip** — `gh` token expired mid-PR, flyctl lost auth, etc. Resume retries the same plan after the operator re-auths.
- **`rolled_back`** — the deploy made it to production but breached SLOs and was reverted. `resume` re-runs the same plan; usually the operator fixes the code first or adjusts the plan with a new `convoy plan ... --save`.

## Principles you MUST enforce

1. **Convoy never modifies developer source code.** Resume re-runs the saved plan; it does not regenerate it. If the operator wants Convoy to re-author the deployment surface (Dockerfile, manifest, etc.), they should run `/convoy:ship` again, which builds a new plan from the current HEAD.
2. **Every forward action has a pre-staged reverse.** Rollback remains wired into the pipeline.
3. **Evidence over assertion.** Surface the prior outcome reason verbatim; don't paraphrase what medic said.

## If the resumed run pauses or fails again

- **`awaiting_approval`**: a gate is open, tell the user the timeline URL and to click Approve.
- **`awaiting_fix`**: medic diagnosed another code-level failure. Summarize the new diagnosis card. The fix is the developer's — Convoy doesn't rewrite their code.
- **`failed`**: unexpected error. Include the stderr and propose what to check.
