---
description: Run the Convoy onboard interview for a repo — captures platform mandate, deployment style, approvers, compliance, and observability before the first plan.
argument-hint: [local-path] [--answers='{"platform":{"mandate":"fly"}}']
---

You are running the Convoy onboard interview. Onboard **precedes everything** — Convoy does not plan, score, or author files until it knows how the team ships.

## When to run this

- The user is about to `/convoy:ship` a repo for the first time and you don't see a `.convoy/preferences.json` in the target.
- The user says "onboard this repo", "tell Convoy how we deploy", "set the platform", or similar.
- The plan page shows "No team preferences on file."
- `/convoy:ship` emitted "⚠ No team preferences on file."

## What NOT to do

Do not try to answer the interview questions yourself or pass `--answers` with fabricated values. The interview exists so the **operator** declares their patterns — Convoy's job is to hold that conversation, not to guess.

The one exception: if the user has already stated their preferences in the chat (e.g. "we deploy to Fly, no compliance requirements, I approve PRs"), you may pass those as `--answers` to skip the interactive prompts. Confirm with the user before doing this.

## Resolve the target path

If `$ARGUMENTS` is empty, use the user's current working directory. Normalize relative paths to absolute based on the session cwd before passing to Convoy.

## Run the interview

```bash
cd "${CONVOY_HOME:-$HOME/convoy}" && npm run convoy -- onboard $ARGUMENTS
```

Keep this in the **foreground** — the interview is interactive, line-by-line.

## After the interview

Onboard writes `.convoy/preferences.json` in the target repo. Tell the user:

> Preferences saved. Now run `/convoy:ship <path>` — Convoy will use your declared platform, approvers, and compliance settings for every plan going forward.

If the user declared a platform mandate (e.g. "fly"), confirm:

> Platform locked to **fly** for this repo. Override any time with `convoy onboard --platform=<other>`.

If they answered "not deployed anywhere" + "first deploy" (greenfield), Convoy will pick the platform itself on the next plan and write that pick as the mandate. Tell them:

> Convoy will choose the platform based on your repo's signals and lock it in as your default. You can override it before applying if the choice doesn't fit.
