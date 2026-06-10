# Convoy Demo Script

## Context

This script uses the **Meridian** scenario: a three-service fintech startup. Their principal engineer (Karan) is leaving next week. Production is throwing intermittent 503s on the orders service. The CTO wants to ship a payment-processing refactor and bring on a new service (reports/PDF renderer) — all before Karan walks out the door.

The audience is a technical founder, lead engineer, or DevOps-aware developer who has felt the pain of deployment becoming a team-wide bottleneck.

---

## 3-Minute Pitch

> _Speak this. Eye contact. No live demos yet._

"Let me paint a picture you've probably lived.

Your best engineer is context for how everything deploys. Not because they hoard knowledge — because deployments accumulated sharp edges and only they know which ones bite. New engineers are afraid to touch prod. The ones who aren't afraid break it.

You want to ship a payments refactor. Three questions you need answered before you can confidently merge it: Will it break the orders service? Are the new Stripe keys staged on Fly? If it does go sideways, how fast can you revert? Those answers are either in someone's head or in Slack history from 2022.

Convoy turns those questions into evidence that travels with every deployment.

**What it does:**
- Scans your repo — language, framework, health endpoint, Postgres, Stripe keys you're going to need
- Picks the right platform — fly, vercel, railway, cloud run, or your own VPS — with scored reasoning you can inspect
- Rehearses locally before writing a single line of config — synthetically loads the service, watches error rate and p99
- Authors exactly the files Fly/Vercel needs — Dockerfile, fly.toml, CI workflow, .env.schema
- Secrets gate before the deploy — diff against what's on the platform, pause if anything's missing
- Canary at 5%, observe for 2 minutes, promote or roll back automatically

Every forward action has a pre-staged reverse. The medic agent — Claude Opus — reads the logs and tells you the root cause in first-person: 'I found a global render lock in src/routes/render.ts that serialises all PDF requests through a single promise chain.'

The Meridian team ships Karan's work. Without Karan on the call."

---

## 10-Minute Live Walkthrough

### Setup (before the demo — do not narrate)

```bash
npm install && (cd web && npm install) && (cd demo-app && npm install)
cp .env.example .env   # add ANTHROPIC_API_KEY
(cd web && npm run dev) &   # http://localhost:3737
```

---

### Act 1 — Plan (2 min)

**Narrate:** "I'm going to point Convoy at the Meridian orders service — this is the Node/Express backend, the one throwing 503s."

```bash
npm run convoy -- plan ./demo-app --save
```

While it runs:
> "Watch the scanner. It's reading the package.json, finding the Express routes, detecting Prisma, inferring the health endpoint. No config — it reads the evidence."

After it finishes, open the plan URL from CLI output — or:
```bash
PLAN_ID=$(npm run convoy --silent -- plans | head -1 | awk '{print $1}')
open http://localhost:3737/plans/$PLAN_ID
```

**In the web UI, point out:**
- **"Why this platform"** section — Fly scored highest. Show the +25 for background-worker topology, +15 for container-native. "This isn't magic: it read that there's a BullMQ worker and a Dockerfile."
- **"What Convoy will author"** — expand the Dockerfile. "It detected Node 22, pnpm, the Prisma schema. The Dockerfile knows to run `npx prisma generate` before the build."
- **"Required secrets"** on the lane card — `DATABASE_URL`, `STRIPE_SECRET_KEY`. Amber dot — not staged yet. "The scanner read `.env.example`. It knows what prod needs before I do."

---

### Act 2 — Rehearse the Concurrency Bug (3 min)

**Narrate:** "Before we write any config files, Convoy rehearses. Let me turn on the concurrency failure mode — this is the PDF renderer bug Karan found last week."

```bash
npm run convoy -- apply $PLAN_ID --inject-failure=concurrency
```

> "Convoy is starting the service in concurrency mode — 30 simultaneous /render requests. Watch the p99."

After the breach:
> "p99 of 8,740ms. Zero errors — all requests succeeded. That's the deceptive part. Your error rate looks fine but every user waited 8 seconds for their report. The medic is reading the logs now."

When the medic card appears in the web UI, show it:
> "Opus read the logs and traced the `render_lock_acquired` entries. It found `renderLock` in `src/routes/render.ts` — a global `let renderLock: Promise<void>` that serialises every render through a single promise chain. It suggests replacing it with a semaphore."

**Key message:** _Convoy caught this in rehearsal, not in production. No customer saw an 8-second report load._

---

### Act 3 — Clean Run (2 min)

**Narrate:** "Let me fix the lock and rerun — but in scripted mode so we don't need real credentials for this demo."

```bash
npm run convoy -- apply $PLAN_ID
```

> "Rehearsal passes — p99 of 142ms, 8/8 smoke tests. Now Convoy pauses at the PR gate."

When the `open_pr` approval appears in the web UI:
> "The operator sees rehearsal evidence before approving. p99, error rate, smoke tests. You're approving from evidence, not from 'Karan says it's fine.'"

Click Approve in the web UI. Continue to canary:
> "Scripted canary — 5% traffic, baseline comparison shows +3ms p99 delta. Within tolerance. Convoy promotes."

---

### Act 4 — Secrets Gate (1 min)

**Narrate:** "Let me show what happens when `STRIPE_SECRET_KEY` is missing on Fly."

```bash
npm run convoy -- apply $PLAN_ID --real-fly --fly-app=meridian-orders
```

> "Before the deploy command runs, Convoy diffs the expected keys against what Fly has staged. `STRIPE_SECRET_KEY` is missing. It pauses — not fails, pauses — and shows you the gate in the web UI."

In the web UI, point to the `stage_secrets` approval card:
> "The form lets you paste the value right here. Convoy pushes it to Fly via `fly secrets set` and then continues the deploy. The pipeline never stalled — it paused, collected what it needed, and proceeded."

---

### Act 5 — The Handoff (2 min)

**Narrate:** "Here's the part that matters for the Karan scenario."

```bash
npm run convoy -- plans
```

> "This plan is a record. What was scanned, what was scored, what rehearsal found, what was staged. Karan's replacement opens this page, sees the Dockerfile preview, sees that `DATABASE_URL` is already marked staged, sees the p99 baseline from the last rehearsal."

Back to the web UI plan page:
> "They don't need Karan's tribal knowledge. They need this page and a `convoy apply`."

---

## Objection Handling

**"We already have CI/CD."**
> "CI runs on the commit you already pushed. Convoy runs before the PR — it rehearses your code on your machine before a single file is committed. The CI/CD pipeline and Convoy are complementary: Convoy validates before the PR, CI validates the PR content."

**"We have Terraform / Pulumi for infra."**
> "Convoy doesn't touch your Terraform. It authors the application layer — Dockerfile, fly.toml, the CI workflow that invokes your existing infra. If you have a VPS with docker-compose, it goes there instead."

**"We'd have to trust Convoy to not break anything."**
> "Convoy never authors your application code. It authors exactly five artifact types: Dockerfile, platform manifest, CI workflow, .env.schema, infra/ terraform stubs. Every forward action has a pre-staged reverse. The medic writes diagnoses; it doesn't write fixes."

**"What if Convoy's platform choice is wrong?"**
> "Override it. `--platform=vps` or `--platform=railway`. The score table still shows why each platform ranked where it did — you can audit it, disagree, and ship to wherever you want."
