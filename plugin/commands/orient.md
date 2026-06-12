---
description: Orient Convoy to a repo's existing deployment setup — reads CI workflows, platform configs, secrets manager, observability stack, and compares against saved preferences to surface drift.
argument-hint: [local-path] [--json]
---

You are running `convoy orient` — Convoy's per-run drift detector. Orient reads what IS (repo artifacts) and compares it against what the team declared in `convoy onboard` (`.convoy/preferences.json`). It never modifies anything.

## When to run this

- Before planning a repo that's been active for a while: "what's in this repo's deploy setup?"
- After a team changes platforms without updating preferences: drift will surface here.
- Debugging a plan that picked the wrong platform: orient shows you what signals Convoy read.
- The user says "check what's deployed", "what does this repo use", "why did Convoy pick X".

## What orient reads

- `.github/workflows/*.yml` — deploy steps, trigger branches, `${{ secrets.* }}` references
- `fly.toml`, `vercel.json`, `railway.json`, `render.yaml`, `Procfile`, `docker-compose.yml`, `Caddyfile`
- `package.json` deps → secrets-manager packages (Doppler, Infisical, Vault, AWS SM)
- `package.json` deps → observability (Sentry, Datadog, New Relic, pino/winston)
- `.convoy/preferences.json` (if present) — compared against artifacts; drift is flagged

## Resolve the target path

If `$ARGUMENTS` is empty or `.`, use the user's current working directory. Normalize relative paths to absolute.

## Run orient

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- orient $ARGUMENTS
```

## Interpret the output for the user

Structure a short response:

**What Convoy found**
- Existing platform (if any): name, evidence file
- CI deploy target (if any): workflow name, deploy step
- Secrets manager (if any): tool name, source
- Observability (if any): tool(s)

**Drift (if any)**
- Call out any mismatch between `preferences.json` and what orient found
- Include the exact remedy: `convoy onboard --platform=<correct>` to update preferences

**Next step**
- If preferences exist and no drift: `/convoy:ship <path>` — ready to plan
- If preferences missing: `/convoy:onboard <path>` first
- If drift found: update preferences before planning or the declared platform will win over the artifact signal
