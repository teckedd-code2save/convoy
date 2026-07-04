# Convoy Web Viewer

**A Next.js dashboard for Convoy deployment plans — read SQLite state, approve or reject deploy runs, and inspect timeline artifacts.**

The web viewer reads the same `.convoy/state.db` SQLite database that the Convoy CLI writes to. This means every plan the CLI creates, every deployment it rehearses, and every rollback it executes is immediately visible in the viewer. Approvals and rejections made in the viewer are written back to the same database, so the CLI's medic and promote stages respect browser-made decisions.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) |
| UI | React 19 + Tailwind CSS 4 |
| Database | SQLite via `better-sqlite3` (shares DB with CLI) |

## Quick Start

```bash
cd web
npm install
npm run dev
```

The dev server runs on **http://localhost:3737**.

## How It Works

- The viewer opens `.convoy/state.db` (from the repo root) and renders plan artifacts as browsable cards.
- Each plan shows its status, stage timeline, and any logs or error output captured during execution.
- Approvals and rejections flow through a server action that writes the decision to the state DB.
- The Convoy CLI's `ObserveStage` and `Medic` read these decisions when deciding whether to promote or roll back.

## Relationship to the Convoy CLI

The viewer and the CLI are two faces of the same engine. The CLI handles automated pipelines (plan, rehearse, deploy, observe, rollback). The viewer provides human oversight: you see what the CLI decided, why it decided it, and you can override its choices before a promotion gate. They share the same state database and the same event bus — nothing is duplicated.
