---
description: List every Convoy slash command with a one-line purpose and an example.
argument-hint:
---

Print the Convoy command cheatsheet verbatim to the user. Do not run any tools. Do not probe state. Just emit this exact content:

```
Convoy — slash commands
───────────────────────

/convoy:where
  Orient yourself. Shows CONVOY_HOME, state DB, recent plans, recent run,
  whether the web viewer is up. Run this first if you're lost.

/convoy:ship <target> [flags]
  Plan + apply end-to-end against a GitHub URL or local path. Real by
  default: opens a PR, rehearses locally, deploys to Fly. Pauses at each
  human-approval gate (open PR, merge PR, promote).
    Examples:
      /convoy:ship https://github.com/owner/repo
      /convoy:ship ./my-app --platform=vercel
      /convoy:ship owner/repo --demo           # scripted, no real side effects

/convoy:ship-status [runId]
  Status of a Convoy run — most recent if no id given. Shows stage
  progress, pending approvals, rehearsal evidence, and any diagnosis.
    Examples:
      /convoy:ship-status
      /convoy:ship-status eaeceb13

/convoy:ship-resume [runId]
  Re-apply the plan from a paused or failed run after fixing the code.
  Defaults to the most recent run. Creates a new run row; the previous
  one is preserved as history. Accepts the same flags as ship/apply.
    Examples:
      /convoy:ship-resume
      /convoy:ship-resume d12862ac --probe-path=/orders

/convoy:ship-rollback <service>
  Roll a deployed service back to its previous healthy release.
  Privileged — always requires explicit human approval.
    Example:
      /convoy:ship-rollback my-fly-app

Pipeline order (reference)
──────────────────────────
  scan → pick → rehearse → author → canary → promote → observe
                           │        │
                           │        └─ approvals: open_pr, then merge_pr
                           └─ runs BEFORE any repo mutation; no PR opens
                              until rehearsal passes AND you approve

Environment
───────────
  CONVOY_HOME   defaults to ~/convoy (where the Convoy CLI lives)
  Web viewer    http://localhost:3737 (auto-spawned on first plan/apply)
  State         $CONVOY_HOME/.convoy/state.db
  Plans         $CONVOY_HOME/.convoy/plans/<id>.json

Run `/convoy:where` if any of these paths are unclear.
```

After emitting the cheatsheet, stop. Do not add commentary, do not suggest which command to run next unless the user asks.
