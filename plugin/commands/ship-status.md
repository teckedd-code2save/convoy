---
description: Show the live timeline of a Convoy run — stages, events, approvals, and current blockers.
argument-hint: [run-id]
---

Report the status of a Convoy run.

## Behavior

- If `$ARGUMENTS` is empty, show the status of the **most recent run**.
- If a run ID is provided, show the status of that specific run.

## What to report

1. Run header: id, repo URL, platform, start time, elapsed, status.
2. Stage-by-stage summary with status per stage (scan, pick, author, rehearse, canary, promote, observe).
3. Current blocker if any — pending approval, awaiting developer commit, waiting for bake window.
4. Last five events with timestamps.
5. A link to the web viewer if configured.

Keep it terse. One screen is better than a long scroll.
