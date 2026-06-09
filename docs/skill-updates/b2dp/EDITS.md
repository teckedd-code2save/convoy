# Targeted edits — business-to-data-platform (SKILL.md)

## 1. Step 4 — Prisma 7 playbook: generator block

Prisma 7 dropped the `-js` provider suffix and made `output` required (the
client no longer generates into `node_modules`). Anywhere the playbook shows or
implies the generator block, it must read:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}
```

And imports follow the output path, not the package:

```typescript
// OLD (Prisma ≤6):
import { PrismaClient } from '@prisma/client'

// NEW (Prisma 7):
import { PrismaClient } from './generated/prisma'
```

Add to the playbook's numbered list:

```markdown
10. Generated client lives at the `output` path and should be gitignored
    (`src/generated/`). CI and Docker builds must run `prisma generate`
    before typecheck/build — the client is not restored by `npm ci`.
```

## 2. Step 4 — adapter note

Update the framing: `@prisma/adapter-pg` is **mandatory** in Prisma 7, not a
recommended default. Prisma 7 removed the built-in Rust query engine; driver
adapters are the only connection path.

## 3. Hard rules — add two

```markdown
- Never emit `provider = "prisma-client-js"` — the `-js` provider was removed
  in Prisma 7. Use `provider = "prisma-client"` with an explicit `output`.
- Never assume the generated client exists after `npm ci` — it lives at the
  schema's `output` path and requires `prisma generate` in every fresh
  environment (CI, Docker builder stage, new clones).
```

## 4. Handoff section — extend the chain to Convoy

After the existing `## Handoff to ship-to-vps` content, append:

```markdown
## Handoff to Convoy (observe / diagnose / rollback)

ship-to-vps gets the app live; Convoy keeps it alive. After the first deploy
succeeds, register the repo with Convoy so every subsequent change ships
through a rehearsed, observed, rollback-ready pipeline:

- CLI: `convoy plan <repo-path> --save` then `convoy apply <plan-id>`
- Agent-native: call the `convoy_plan` → `convoy_apply` → `convoy_status`
  MCP tools from any Claude Code / MCP-capable session

Convoy closes the loop this chain otherwise leaves open: a medic agent
diagnoses any breach (root cause, classification, owned-by), rollback is
pre-staged before every promote, and the run pauses for a human only at
secrets staging and developer-owned failures.
```

## 5. Compatibility — soften the Datafy hard dependency

Current frontmatter lists Datafy MCP under `requires`. For portability (and
for Convoy platform use where Datafy may not be configured), move it to
`optional` and add a fallback note in Step 6:

```markdown
If Datafy MCP is unavailable, fall back to direct `psql`/Prisma migration
execution against `DATABASE_URL`. Datafy adds schema inspection and safer
admin SQL, but is not required for provisioning.
```
