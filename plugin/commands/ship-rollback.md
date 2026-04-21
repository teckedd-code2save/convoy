---
description: Roll back the most recent successful deployment for a service.
argument-hint: <service-name> [--to=<release-id>]
---

Trigger a rollback of a deployed service.

## Arguments

- `$ARGUMENTS` — parse the service name (required) and optional target release.
  - `--to=<release-id>` — roll back to a specific prior release. Defaults to the
    release immediately before the current one.

## Operating procedure

1. Resolve the service to its current deployment and platform adapter.
2. Identify the target rollback release. Verify the release exists and is reachable.
3. Produce a summary: current release, target release, expected rollback duration,
   any data-layer implications (e.g., reversed migrations needed).
4. Pause for human approval (`rollback` approval kind). Rollback is a privileged
   action and always requires confirmation.
5. On approval, invoke the adapter's `rollback` method.
6. Verify the restored release with an independent health check — not just the
   platform's return code.
7. Emit a rollback event and a receipt: restored release, duration, verification result.

If the rollback fails, do not retry automatically. Escalate to the human with the
full context and suggested next steps.
