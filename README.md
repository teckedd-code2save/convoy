# Convoy

**The deployment agent that ships your code — without rewriting it.**

Rehearse, ship, observe. Convoy drives a change from pull request to production through a rehearsal on a twin of your target environment, a canary promotion watched against real metrics, and an auto-rollback if the numbers regress. Your `src/` stays yours.

## What Convoy does

- **Rehearses** every deploy on an ephemeral twin of your target environment before touching production.
- **Ships** through a configurable ladder — preview → staging → canary → prod — with policy-driven gates.
- **Observes** golden signals and rolls back automatically if they breach.
- **Diagnoses** code-level failures and hands them back to you as a reading artifact — never patches your source.
- **Explains** every decision on-screen and in an append-only audit log.

## What Convoy does not do

- Does not modify files in `src/`, `app/`, `lib/`, `pages/`, `tests/`, or application `package.json` dependencies.
- Does not merge pull requests without explicit approval.
- Does not perform irreversible actions — drop tables, destroy resources, revoke credentials — autonomously.

## Supported platforms

Fly.io · Railway · Vercel · Cloud Run. Adapter interface is public; adding a platform is a README section.

## Status

Under construction during the *Built with Opus 4.7* Claude Code hackathon — Apr 21 through Apr 26, 2026 (EDT).

## Documentation

- [Architecture](./docs/architecture.md) — pipeline, components, adapter model.
- [Principles](./docs/principles.md) — the three rules that shape every design choice.
