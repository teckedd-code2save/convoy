---
description: Show the status of a Convoy run — most recent, or a specific run id.
argument-hint: [run-id-or-prefix]
---

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
