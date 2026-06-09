# Skill updates for ai-build-tools

Ready-to-apply fixes for the `business-to-data-platform` (b2dp) and `ship-to-vps`
skills in [teckedd-code2save/ai-build-tools](https://github.com/teckedd-code2save/ai-build-tools),
validated against the June 2026 state of the ecosystem. Every item maps to a
concrete breakage or deprecation; nothing here is stylistic.

These live in the Convoy repo because Convoy's VPS lane consumes the contract
these skills emit — Convoy integration only works against the fixed versions.

## What's broken and why

| # | File | Problem | Consequence if unfixed |
|---|------|---------|------------------------|
| 1 | `ship-to-vps/templates/github/workflows/ci.yml` | `checkout@v4`, `setup-node@v4`, Node 20 | Node 20 deprecated on GH runners Jun 2026, removed Sep 2026 — CI starts failing |
| 2 | `ship-to-vps/templates/github/workflows/deploy.yml` | `checkout@v4`, `build-push-action@v5`; Prisma invoked via `node node_modules/prisma/build/index.js` | Same runner deprecation; Prisma path is fragile (breaks the moment anyone slims the runner image) |
| 3 | `ship-to-vps/templates/Dockerfile.nextjs-prisma7` | `node:20-alpine` | Node 20 EOL Oct 2026 |
| 4 | `ship-to-vps/SKILL.md` Step 1 | Drops `site.caddy` into `/etc/caddy/sites/` but never verifies the main Caddyfile imports that dir | On a fresh VPS the site config silently does nothing — no TLS, no routing |
| 5 | `ship-to-vps/templates/docs/CONTRIBUTING.md` | Referenced in SKILL.md Step 3, file does not exist (404) | Render step fails or silently skips |
| 6 | `ship-to-vps/references/shippability-contract.md` item 1 | Migration invocation pattern predates Prisma 7.2 `--url` flag | Locks every consumer into shipping full `node_modules` + `prisma.config.ts` in the runner |
| 7 | `b2dp/SKILL.md` Step 4 | `provider = "prisma-client-js"`; no `output` | Prisma 7 dropped the `-js` provider and made `output` required — generate fails |
| 8 | `b2dp/SKILL.md` handoff | Chain ends at ship-to-vps; Convoy unknown | No observe/diagnose/rollback after deploy |
| 9 | `ship-to-vps/references/infisical-flow.md` | No mention of `@infisical/mcp` | Agents shell-exec the CLI when an auditable MCP tool path exists |

## How to apply

Full replacement files are provided where practical; targeted edits otherwise.

```
skill-updates/
├── README.md                       (this file)
├── ship-to-vps/
│   ├── ci.yml                      → replaces templates/github/workflows/ci.yml
│   ├── deploy.yml                  → replaces templates/github/workflows/deploy.yml
│   ├── Dockerfile.nextjs-prisma7   → replaces templates/Dockerfile.nextjs-prisma7
│   ├── CONTRIBUTING.md             → new file at templates/docs/CONTRIBUTING.md
│   └── EDITS.md                    → targeted edits to SKILL.md, shippability-contract.md, infisical-flow.md
└── b2dp/
    └── EDITS.md                    → targeted edits to SKILL.md
```

Copy the replacement files over their targets, then walk the two `EDITS.md`
files and apply each edit block. Re-run `check-shippability.sh` against a known
repo afterward to confirm the checker still passes.
