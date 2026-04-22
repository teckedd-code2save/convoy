# Convoy — Demo Script

Target length: **2–3 minutes**. Three acts.

## Setup (off-camera)

- Terminal 1: zoomed, in `convoy/`. `.env` has `ANTHROPIC_API_KEY` set.
- Terminal 2: in `convoy/demo-app/`. Idle.
- Browser: `http://localhost:3737` — running from `convoy/web`.
- State clean: `rm -rf .convoy/plans .convoy/cache` (keep `state.db` for history).

Pre-seed a plan so Act 1 doesn't have to wait on Opus:

```bash
npm run convoy -- plan ../shipd --save                  # or any real repo
npm run convoy -- plan ./demo-app --save
```

---

## Act 1 — "Here's the plan."  (45s)

> **Voiceover:** "This is Convoy. It turns a pull request into a safe deployment. Before it does anything, it shows you the plan."

1. In browser, go to `/plans`. Scroll the list of seeded plans for a beat.
2. Click the **shipd** plan. Let the summary paragraph render.

> "Convoy scanned this repo and summarized what it is — a Next.js app with Prisma and Postgres, going to Vercel."

3. Scroll to "What Convoy will author".
4. Expand the `vercel.json` file. Brief pause.

> "It only writes what I don't want to write — platform manifest, env schema, provenance record. It doesn't touch my `src/`."

5. Scroll to "How I'll ship this" section.

> "Seven numbered steps, first person. This is Convoy talking, not documentation. It's going to rehearse on a Vercel preview, then canary to 5%, then promote in stages, and roll back in ten seconds if anything breaches."

6. Scroll to "Why this platform".

> "It scored four platforms. Vercel wins for Next.js. If I wanted Railway, I'd pass `--platform=railway`."

---

## Act 2 — "Here's the approval loop."  (45s)

> **Voiceover:** "Convoy doesn't merge PRs or promote traffic on its own. I hold the approvals."

1. In Terminal 1, kick off the pipeline:

```bash
npm run convoy -- apply <demo-app-plan-id> --no-auto-approve
```

2. Let it run to the first approval gate (about 3 seconds). Timeline lights up through scan → pick → author.

3. Switch to browser, go to `/runs` — the new run is at the top with **awaiting approval** pulsing.

4. Click into the run. Show the pipeline stages lit up, then the **Waiting on you** approval card for `merge_pr`.

5. Click **Approve merge_pr**. The card disappears. Page auto-refreshes.

> "I just wrote to the same SQLite state DB the pipeline's polling. It's continuing."

6. Let rehearse run. When promote appears, approve it too.

7. Wait for succeeded. The live URL appears in the header.

> "Total time, two minutes. Two approvals from the browser, no terminal ever touched past the initial command."

---

## Act 3 — "Here's what happens when it breaks."  (60s)

> **Voiceover:** "But real systems break. This is what Convoy does when they do."

1. In Terminal 1, start a new apply with injected failure:

```bash
npm run convoy -- apply <demo-app-plan-id> --inject-failure=rehearse
```

2. Let it run. Pipeline proceeds through scan → pick → author → rehearse.

3. The rehearse stage fires `synthetic_load.breach` — on-screen you see `p99_ms=494 error_rate_pct=6.67 threshold=1.0`.

4. Then `medic.invoked`. Opus is reasoning on the real logs.

5. Switch to the browser. Refresh the run page.

6. The **Medic's diagnosis** card is up top.

> "Convoy's medic read the real log stream, noticed every tenth request timed out with `orders_query_timeout`, and identified it as a code-level failure in `src/routes/orders.ts` at line 44. Classification: code. Confidence: medium. Owned by: developer."

7. Scroll the card. Point at the narrative, the location, the suggested fix description, and the reminder at the bottom:
   *"Convoy will not modify your code. Push a fix and the pipeline resumes from the last clean stage."*

> "This is the point. Convoy doesn't silently patch your code. It tells you what it found, where to look, and waits. Your change, your call."

---

## Close — "This is Convoy." (15s)

1. Back to the `/plans` page for a beat.

> "Convoy. We ship your code — we don't rewrite it. Rehearse, ship, observe. Built with Opus 4.7 for the Claude Code hackathon."

2. Cut to the GitHub repo card or the architecture diagram.

---

## Fail-safes during recording

- If Opus is slow (~8s for enrichment): start plan generation before rolling.
- If dev server gets confused: `pkill -f "next dev" && rm -rf web/.next && npm run dev`.
- If state DB has stale data: `rm .convoy/state.db` before recording.
- Keep ANTHROPIC_API_KEY set — without it the narrative and medic fall back to deterministic output.
