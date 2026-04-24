---
description: Roll back a deployed service to its previous healthy release. Privileged — always requires approval.
argument-hint: <service-name-or-run-id>
---

Rollback is a privileged operation that reverts the production release without touching the newer images. Convoy supports it on Fly (redeploy the prior image via `fly deploy --image <ref> --strategy=immediate`) and Vercel (alias the prod domain to a prior deployment).

## State & paths — do NOT explore the filesystem

Convoy's state lives at fixed paths. Do not `find`, `ls`, or `grep` to discover them — they are authoritative:

- **CONVOY_HOME** — `${CONVOY_HOME:-$HOME/convoy}` (Convoy CLI source + all state)
- **State DB** — `$CONVOY_HOME/.convoy/state.db`
- **Web viewer** — `http://localhost:3737`

If `CONVOY_HOME` is unset and `~/convoy` doesn't exist, ask the user for the path to their Convoy checkout.

## Run the CLI

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- rollback $ARGUMENTS
```

> **Note:** the standalone `convoy rollback` CLI command is a placeholder today. Rollback is wired as an automatic response to observe-stage breach in the main pipeline — if a live deploy fails its bake window, Convoy calls the rollback path itself. For an **explicit** rollback of a healthy-but-unwanted release, run:
>
> **Fly:**
> ```bash
> fly releases --app <app-name>            # list versions + image refs
> fly deploy --image <prior-ref> --strategy=immediate --app <app-name>
> ```
>
> **Vercel:**
> ```bash
> vercel ls                                 # list deployments
> vercel alias set <prior-deployment-url> <prod-alias>
> ```

## Approvals

If an automatic rollback has already fired, the run's outcome is recorded in SQLite with the reason and restored version — check via `/convoy:ship-status <run-id>` or the web UI. No further action is needed to undo; the service is already serving the prior release.
