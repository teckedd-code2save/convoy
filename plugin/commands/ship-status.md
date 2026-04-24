---
description: Show the status of a Convoy run — most recent, or a specific run id.
argument-hint: [run-id-or-prefix]
---

## State & paths — do NOT explore the filesystem

Convoy's state lives at fixed paths. Do not `find`, `ls`, or `grep` to discover them — they are authoritative:

- **CONVOY_HOME** — `${CONVOY_HOME:-$HOME/convoy}` (Convoy CLI source + all state)
- **State DB** — `$CONVOY_HOME/.convoy/state.db` (SQLite: runs, events, approvals, medic chat)
- **Saved plans** — `$CONVOY_HOME/.convoy/plans/<plan-id>.json`
- **Web viewer** — `http://localhost:3737`

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path to their Convoy checkout.

Run the Convoy status command:

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- status $ARGUMENTS
```

Surface the output verbatim. It includes:

- Run id, status (`pending` / `running` / `awaiting_approval` / `awaiting_fix` / `succeeded` / `failed` / `rolled_back`)
- Repository, platform, live URL
- Per-stage success / failure markers
- Pending approvals (with approval id)
- Outcome reason and restored version when a run was rolled back

If the user wants to see the full timeline, point them at:

```
http://localhost:3737/runs/<run-id>
```

That page auto-refreshes every 1.5s while the run is live and renders the medic diagnosis card prominently when present.
