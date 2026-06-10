# Convoy as the delivery layer

Convoy fits into a larger agent workflow. This page documents how it connects to
the `business-to-data-platform` (b2dp) and `ship-to-vps` skills and why it
needs to be the last thing in the chain rather than an afterthought.

---

## The skill chain

```
b2dp                        → ship-to-vps              → Convoy
─────────────────────────      ─────────────────────      ────────────────────────────────────
Provision the data layer.      Build the first image.     Every subsequent change ships safely.
Schema, Prisma, migrations,    Docker + Caddy on the      Plan → rehearse → PR → canary →
seed data, Infisical secrets.  VPS. Infisical secrets      observe → auto-rollback. Medic on
                               pulled at runtime.          breach. Approval gates. Audit trail.
```

Without Convoy at the end, this chain gets an app live once and leaves it
there. Every subsequent deploy is a manual `docker pull && systemctl restart` —
no rehearsal, no canary, no rollback, no diagnosis when it breaks.

Convoy closes the loop:

- **Rehearsal** catches regressions before the PR opens. Not "CI passed" — the
  actual service booted, handled synthetic load, and stayed within SLOs.
- **Canary** promotes incrementally. A bad deploy gets caught at one machine,
  not all of them.
- **Observe** keeps watching after promote. Rollback fires on SLO breach, not
  when a human notices something is wrong at 2am.
- **Medic** diagnoses breaches with a Claude agent loop. Root cause,
  classification, owned-by. Structured card, not a log dump.

---

## Connecting a repo to Convoy after ship-to-vps

The first deploy via `ship-to-vps` gets the app live. From that point on, hand
off to Convoy:

```bash
# CLI
convoy plan <repo-path> --save --platform=vps \
  --vps-host=<host> --vps-ghcr-image=ghcr.io/<you>/<app>
convoy apply <plan-id>

# Or from inside a Claude Code session (MCP tools)
# convoy_plan → convoy_apply → convoy_status → convoy_approve
```

Convoy will:
1. Re-scan the repo (live scan, not a cache)
2. Confirm the platform pick (VPS, given the `--platform=vps` override or the
   existing deploy signals)
3. Author only the files it needs to manage: `.convoy/vps-deploy.sh`,
   `.convoy/vps-README.md`, updated CI workflow
4. Open a PR for review — you see the diff before anything deploys
5. Rehearse on a local twin after the PR merges
6. Push the new image to GHCR, SSH deploy with zero-downtime slot swap via Caddy

Subsequent changes: push a commit, `convoy apply <plan-id>`, approve at the
gates. The repo is now under Convoy's watch.

---

## Platform selection: how Convoy decides

The picker scores all five platforms against the repo's scan signals. You can
always override, but the default reasoning is:

| Signal | Platform boosted |
|---|---|
| Next.js / static output | Vercel (+35) |
| Existing `fly.toml` | Fly (+50) |
| Existing `docker-compose.yml` + SSH host set | VPS (+40) |
| Worker topology | Fly (+25) |
| GCP service account or existing Cloud Run config | Cloud Run (+30) |
| Railway config present | Railway (+50) |

The plan surfaces the full score table and the evidence that drove each
adjustment. Override with `--platform=X` when the signal-based pick isn't what
you want.

---

## Skill update status

The b2dp and ship-to-vps skills in
[`teckedd-code2save/ai-build-tools`](https://github.com/teckedd-code2save/ai-build-tools)
have known breakages against the June 2026 ecosystem (Prisma 7, Node 20 EOL,
Caddy import on fresh VPS, Infisical MCP). Ready-to-apply patches live in
[`docs/skill-updates/`](./skill-updates/README.md) — copy the replacement
files over their targets in `ai-build-tools` and walk the two `EDITS.md` files
to apply targeted edits to the large markdown files.

Until those patches are applied, a b2dp run on a Prisma 7 project will emit a
broken schema (`provider = "prisma-client-js"`) and Convoy's author stage will
need the enricher (Claude Sonnet 4.6) to fix it — or the operator needs to
patch it manually before the PR merges.
