# Convoy — Demo Script

Target length: **2:30–3:00 minutes**. Three acts. All real — no scripted stages.

## Setup (off-camera)

- **Terminal 1**: in `~/convoy`. `.env` has `ANTHROPIC_API_KEY`.
- **Terminal 2**: reserved for the follow-up deploy or Fly CLI check.
- **Browser tab**: `http://localhost:3737` — web viewer running from `web/`.
- **Prereqs verified**: `gh auth status`, `fly auth whoami`, `vercel whoami` all green.
- **Clean slate** so the demo reads cleanly:
  ```bash
  rm -rf .convoy/plans .convoy/cache
  # keep .convoy/state.db for history; optional wipe if cluttered
  ```
- **Pre-seed one plan** for Act 1 so the video doesn't wait on Opus:
  ```bash
  npm run convoy -- plan https://github.com/teckedd-code2save/shipd --save
  ```

---

## Act 1 — "Here's the plan." (45s)

> **Voiceover:** "This is Convoy. You point it at a repo and it ships it. Before anything touches your systems, it shows you the plan."

1. In browser: `/plans`. The seeded **shipd** plan is at the top.
2. Click it. Let the summary paragraph render.

> "Convoy cloned the repo, scanned it — Next.js, Prisma, Postgres — and wrote this plan with Opus 4.7. Target: Vercel. Only deployment-surface files get written. `src/` is off-limits."

3. Scroll to **What Convoy will author**.
4. Expand `vercel.json`. Brief pause showing the JSON.

> "Vercel manifest, env schema, provenance record. Three files, all mine. None of yours."

5. Scroll to **How I'll ship this** — the numbered first-person narrative.

> "Seven steps in first person. Convoy explaining its own plan: open a PR, pause for me to merge it, rehearse locally with real metrics, pause again, deploy to a preview, verify, promote to prod, watch for a minute, and — if anything drifts — roll back in ten seconds."

6. Scroll to **Why this platform**. The four-card ranking with Vercel lit up.

> "It scored every platform. Vercel won for Next.js. Pass `--platform=fly` and it replans."

---

## Act 2 — "Here's the real thing." (75s)

> **Voiceover:** "Let's watch it ship a real service. Same repo, no tricks."

1. Terminal 1:

```bash
npm run convoy -- ship ./demo-app --no-auto-approve
```

2. Output streams:

```
clone.done ...
Plan <id> saved (narrative: ai)
Target: demo-app (node, express)
Platform: fly (scored)

Preflight
  ✓ real author        gh authed as teckedd-code2save — will open PR on teckedd-code2save/convoy
  ✓ real rehearsal     will spawn `node dist/server.js` on port 8080
  ✓ real fly           flyctl authed as createdliving1000@gmail.com — will deploy to Fly
```

> "Preflight. Everything Convoy's about to do, verified before a single byte moves."

3. Pipeline advances to `author` and opens a **real** pull request on the convoy repo.

> "Real PR. Branch pushed. Convoy paused — it won't merge without me."

4. Switch to browser → `/runs/<run-id>`. Pending `merge_pr` approval card.
5. Click **Approve merge_pr**.

> "Two clicks. Convoy auto-merged via gh pr merge and moved on."

6. Terminal 1 — `▸ rehearse` starts:

```
install.running cmd=npm ci
build.running  cmd=tsc
boot.ready     port=8080
load.running   requests=60 concurrency=4
load.done      error_rate_pct=0 p99=...
```

> "That's a real subprocess — real `npm ci`, real `tsc`, real HTTP against port 8080. If it broke, medic would be reading the stdout right now."

7. `▸ canary` requests `promote`. Approve in the browser.

8. Terminal 1:

```
fly.creating  app=convoy-demo-app-<hash>
fly.deploying strategy=canary
fly.deployed  hostname=convoy-demo-app-<hash>.fly.dev
```

> "Fly canary strategy — one machine at a time with health gates, then the rest. This just happened for real."

9. Terminal 1 → `◆ Convoy succeeded in 4m 12s` with a live URL.

10. Click the URL. Real `200 OK` in the browser.

> "Live. From `convoy ship` to serving traffic, four minutes, two clicks."

---

## Act 3 — "Here's what happens when it breaks." (60s)

> **Voiceover:** "Real systems break. This is the part that matters."

1. Point at `docs/rollback-proof.md` on-screen (or narrate).

> "Earlier I staged a bug — a fly secret that delayed `/health` by two seconds. Deployed it through Convoy. Here's what happened."

2. Either re-run or replay from the proof doc / recorded terminal:

```
observe.probe  probe_count=1 p99_ms=2817
observe.breach reason=p99 2817ms exceeded 1000ms
rollback.starting
rollback.done  restored_version=3
```

> "Observe measured p99 of 2.8 seconds against the live URL. Threshold was one second. Convoy tripped the rollback itself — `fly deploy --image` with the prior release. No human clicked anything. Service recovered in seconds."

3. Browser → the rolled-back run page. Show:
   - Amber `↺ Rolled back to v3` banner
   - Breach reason inline
   - Clickable live URL

> "Restored version — recorded. Reason — first-class on the run. Live URL — you can click it and it's still healthy. That's the reverse path being real."

4. Scroll the timeline, open any event row.

> "Every step has its full JSON payload. Replay the whole run for the post-mortem."

---

## Close — "This is Convoy." (15s)

1. Back to `/plans` home for a beat.

> "Convoy. We ship your code — we don't rewrite it. Real PRs, real rehearsals, real deploys, real rollbacks. Agents assisting, humans deciding. Built with Opus 4.7 for the Claude Code hackathon."

2. Cut to the plugin line in a Claude Code session:

```
/convoy:ship https://github.com/your-org/your-repo
```

> "Or run it from inside Claude Code. Plugin loaded, slash command, same pipeline."

---

## Fail-safes during recording

- **Keep `ANTHROPIC_API_KEY` set.** Without it narrative + medic fall back to deterministic, less impressive copy.
- **Pre-seed the Act 1 plan** (`plan --save`). Saves 10–15s of Opus wait.
- **Pre-create the Fly app** for Act 2 or count on `--fly-create-app` (default). Cold-start of a fresh app adds ~30s.
- **If the web dev server caches wrong**: `pkill -f "next dev" && rm -rf web/.next && (cd web && npm run dev)`.
- **If a Fly app from a prior take is cluttering state**: `fly apps list | grep convoy-demo-` and `fly apps destroy <name>` them before the recording.
- **Web approval lag**: the run page polls every 1.5s. Approve, count to two, then narrate "continuing."

## Fallback variants

- **Scripted-only demo** (no real credentials needed): `ship <path> --demo` runs the full 7 stages scripted. ~15s end to end. Useful if recording conditions don't allow real network calls.
- **Medic-on-fixture-logs demo**: `apply <plan> --inject-failure=rehearse` uses the built-in buggy log fixture and runs the medic diagnosis path without spinning up anything real.
- **Rollback-only demo**: narrate from `docs/rollback-proof.md` — the sequence, timings, and `fly releases` output are already captured there.
