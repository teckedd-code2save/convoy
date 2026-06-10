# Targeted edits — ship-to-vps

Replacement files (`ci.yml`, `deploy.yml`, `Dockerfile.nextjs-prisma7`,
`CONTRIBUTING.md`) live alongside this file. The edits below are for the three
large markdown files where a full duplicate would drift.

---

## 1. `SKILL.md` — Step 1, after item 5 ("Drop templates/vps/site.caddy …")

Insert:

```markdown
   **Caddy import check (required on fresh boxes):** Caddy does not auto-load
   files from subdirectories. Verify the main `/etc/caddy/Caddyfile` imports
   the sites dir, and add the import if missing:

   ```bash
   ssh ... 'grep -q "import /etc/caddy/sites" /etc/caddy/Caddyfile || \
     printf "\nimport /etc/caddy/sites/*.caddy\n" >> /etc/caddy/Caddyfile'
   ssh ... 'systemctl reload caddy'
   ```

   Without this, every site file dropped into `/etc/caddy/sites/` is silently
   ignored — no TLS cert, no routing, and nothing in the logs to say why.
```

## 2. `SKILL.md` — "Files this skill ships with"

Add `templates/docs/CONTRIBUTING.md` to the tree listing (it was referenced in
Step 3 but the template never existed).

## 3. `references/shippability-contract.md` — item 1, migrations bullet

Replace:

```markdown
- **Migrations invoked via `node ./node_modules/<orm-pkg>/bin.js` not `npx`.** The standalone runner doesn't ship `node_modules/.bin/` shims.
```

With:

```markdown
- **Migrations invoked via `node node_modules/prisma/build/index.js migrate deploy --url "$DATABASE_URL"`**
  (Prisma 7.2+). The `--url` flag bypasses `prisma.config.ts` in one-shot
  containers — without it, config loading drags in `effect` and other
  transitive deps that standalone bundles omit. Never use `npx`; the
  standalone runner doesn't ship `node_modules/.bin/` shims.
```

## 4. `references/infisical-flow.md` — append at end

```markdown
---

## Agent-native path: Infisical MCP server

Infisical ships an official MCP server (`@infisical/mcp`). In agent contexts
(Convoy MCP, Claude Code sessions), prefer it over shell-execing the CLI —
every secret operation becomes an auditable tool call instead of a subprocess.

```bash
npx -y @infisical/mcp
```

Auth (same Universal Auth identity as the CLI flow):

```
INFISICAL_AUTH_METHOD=universal-auth
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=...
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=...
INFISICAL_HOST_URL=https://<your-infisical-domain>
```

Exposes secret CRUD + project/environment/folder management tools. The CI
workflows (`infisical-sync.yml`) keep using the CLI — MCP is for interactive
agent flows, not scheduled jobs.
```

## 5. `SKILL.md` — GitHub Actions version note (optional but recommended)

In Step 3's artifact list, add a maintenance note:

```markdown
> Action versions: keep `actions/checkout@v6`, `actions/setup-node@v5`,
> `docker/build-push-action@v7` or newer. GitHub removes Node 20 from runners
> Sep 2026; older action majors will stop working.
```
