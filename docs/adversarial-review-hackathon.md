# Convoy — Hackathon Adversarial Review

**Date:** 2026-04-22  
**Scope:** Grand-prize demo readiness. Technical trust, narrative fidelity, visual impact, and "judge says show me" survival.  
**Built with:** Opus 4.7 (Claude Code hackathon, April 21–26, 2026)

---

## Executive Summary

Convoy has a **great README, a beautiful web UI, and a real Fly rollback story**. Those are genuine competitive advantages. But the gap between the story and the code is **wider than a hackathon demo can hide**.

The biggest risks for a grand prize are not cosmetic. They are:

1. **Two of the seven pipeline stages are completely fake.** Scan and pick hard-code "Next.js / TypeScript / node-20" regardless of the actual repository. A judge pointing Convoy at any non-Next.js repo will see the illusion shatter in seconds.
2. **The safety model is opt-out, not opt-in.** Auto-approve defaults to `true`. Real rehearsal defaults to `true`. The README says "humans decide" but the code says "humans can opt out of deciding."
3. **The web approval surface has zero authentication.** Any visitor to `localhost:3737` can approve any pending step for any run. The `runId` parameter in the server action is purely decorative.
4. **Rehearsal is an arbitrary code execution primitive** with the operator's full ambient environment, including API keys, SSH agents, and cloud credentials.
5. **Vercel rollback is broken by design** — it confuses deployment URLs with production aliases. The README markets this as "real."
6. **The demo script claims "All real — no scripted stages"** while the first two stages are literally `sleep(800)` + hardcoded constants.

**Bottom line:** If a judge asks a single follow-up question — "What if I point it at my Python backend?" or "Can anyone approve this?" — the demo pivots from "grand prize" to "polished prototype with optimistic assumptions."

The fixes below are ordered by **demo survival priority**, not engineering purity. Some are 5-minute code changes. Some are narrative pivots. All of them matter.

---

## Category A: "Judge Can Break This Live" — Critical

These will be exposed in the first 60 seconds of Q&A if the judge is technical.

### A1. Scan and Pick are scripted puppets

**Evidence:**

- `src/core/stages.ts:226-239` — `ScanStage` hardcodes:
  ```typescript
  const signals = {
    language: 'typescript',
    runtime: 'node-20',
    framework: 'next.js',
    topology: 'web+worker',
    data: ['postgres'],
    hints: { has_dockerfile: false, has_ci: true },
  };
  ```
  It does not read the repo. It does not call `scanRepository()`. It sleeps 800ms and emits fiction.

- `src/core/stages.ts:245-272` — `PickStage` hardcodes rankings with fly at 94, vercel at 54, and ignores the actual scan evidence. It respects `--platform` override but nothing else.

- The demo script (`docs/demo-script.md:22`) says: *"Act 1 — 'Here's the plan.' Convoy cloned the repo, scanned it — Next.js, Prisma, Postgres — and wrote this plan with Opus 4.7."*

- But if the target is `./demo-app` (an Express app), the scan stage **still emits `framework: 'next.js'`**.

**Why this kills the demo:**

A judge will point Convoy at their own repo, or at a Python project, or at a Go API. The scan stage will confidently emit "Next.js, Prisma, Postgres" while the actual repo is a Flask monolith with MongoDB. The operator will have to either (a) pretend they didn't notice, (b) claim it's a known limitation, or (c) admit the first two stages are theater.

None of those outcomes win grand prizes.

**What to do (in order of preference):**

1. **Best:** Wire the real `scanRepository()` into `ScanStage`. The function already exists in `src/planner/scanner.ts`. It takes a `localPath` and returns a real `ScanResult`. The orchestrator's `StageContext` has access to `opts.planId`; the plan already stores `plan.target.localPath`. Pass the real scan results through `prior` so `PickStage` can use them.
   - `ScanStage` calls `scanRepository(localPath)` and emits real signals.
   - `PickStage` calls `pickPlatform(scanResult, platformOverride)` and emits real rankings.
   - Both stages become evidence-based, not scripted.
   - The `sleep()` calls stay for pacing but the payload is real.

2. **Acceptable fallback:** If wiring the real scanner creates too much risk of demo instability, add a `--demo-scan` flag that uses the hardcoded values, and make the real scanner the default. Update the README to say "scan and pick are real by default; pass `--demo` for the scripted fast path."

3. **Narrative pivot (minimum):** If you truly cannot make scan/pick real, **never demo them on an unknown repo**. Only ever point Convoy at the pre-seeded `shipd` plan (Act 1) and `./demo-app` (Act 2), and pre-script the narration so the hardcoded values happen to match. This is fragile but survivable if the judge doesn't ask for a live variation.

### A2. Auto-approve defaults to `true` — the safety story is backwards

**Evidence:**

- `src/core/stages.ts:197-202`:
  ```typescript
  const autoApprove = ctx.opts.autoApprove ?? true;
  if (autoApprove) {
    await this.sleep(400, ctx.signal);
    const decided = ctx.store.decideApproval(approval.id, 'approved');
    ...
  }
  ```

- `src/cli.ts:319-324` — `ApplyOpts` declares `autoApprove: boolean` with no explicit default, but Commander's `--no-auto-approve` option means `autoApprove` is `true` when the flag is absent.

- `src/cli.ts:996-1001` — `apply` command description says "Use `--demo` for a scripted pipeline" but does not mention that approvals auto-pass by default.

- The README says: *"Nothing autonomous happens without the plan on the table"* and *"Approve the pending steps from the web UI."*

- But `npm run convoy -- ship ./demo-app` (no `--no-auto-approve`) will open a PR, merge it, and deploy without a single human click.

**Why this kills the demo:**

A judge will ask: "So if I run `convoy ship` right now, it opens a PR and merges it automatically?" The honest answer is yes. That contradicts the "humans decide" narrative. The README presents approvals as a core safety mechanism, but the default behavior bypasses them entirely.

**What to do:**

- Make `autoApprove` default to `false` in `ApplyOpts`.
- In `cli.ts`, change the `--no-auto-approve` flag to `--auto-approve` (opt-in, not opt-out).
- Add a `--fast` or `--yes` alias for the old behavior so demo recordings don't break.
- Update the README: "By default, Convoy pauses at every approval gate. Pass `--auto-approve` only when you have pre-reviewed the plan."

### A3. Web approvals are unauthenticated and unbound

**Evidence:**

- `web/app/actions.ts:7-20` — `decideApproval` accepts `runId`, `approvalId`, and `decision`, but only passes `approvalId` to `decide(approvalId, decision)`.
- `web/lib/runs.ts:179-206` — `decideApproval(id, status)` updates `approvals` by `id` only. No `run_id` verification. No actor identity.
- The `runId` parameter is never validated against the approval's actual `run_id`.

**Why this kills the demo:**

A judge on the same WiFi network who knows the run ID (it's in the URL) can hit the server action and approve/reject any step. In a shared hackathon environment with tunnels (ngrok, localtunnel), this is not theoretical — it's trivial.

More importantly, the judge will ask: "How do you know the person clicking Approve is the operator?" The current answer is "we don't."

**What to do:**

- At minimum, change the server action to:
  ```sql
  UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND run_id = ? AND status = ?
  ```
- Add a `decided_by` column (IP address, session token, or at least a timestamp with actor hint).
- If time permits, add a simple shared secret: `CONVOY_WEB_SECRET` env var. The server action rejects decisions without the secret in a header. The approval form passes it from a cookie set at dev-server startup.

### A4. Rehearsal executes arbitrary shell commands with full ambient environment

**Evidence:**

- `src/core/rehearsal-runner.ts:163-169`:
  ```typescript
  const proc = spawn('sh', ['-c', shellCmd], {
    cwd,
    env: { ...process.env, ...(this.#target.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ```

- `src/core/rehearsal-runner.ts:193-203` — Same for the start command.
- `src/cli.ts:760-793` — Builds rehearsal config from repo-derived commands plus env-file and CLI-supplied secrets.

**Why this kills the demo:**

A technical judge will immediately spot that `convoy ship owner/repo` means "clone arbitrary code and run its install/build/start scripts with my API keys in scope." That is the definition of a supply-chain attack vector.

In a hackathon setting, this objection is not about production security — it's about **engineering judgment**. The judge will think: "If they didn't consider this, what else didn't they consider?"

**What to do:**

- Add a `--trust-repo` flag that must be present for real rehearsal on cloned targets. Local paths can default to trusted.
- Scrub the environment: pass only `PATH`, `HOME`, `NODE_ENV`, and explicitly allowlisted vars. Never pass `ANTHROPIC_API_KEY`, `GH_TOKEN`, `AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, etc.
- Document this explicitly: "Rehearsal runs in a scrubbed subprocess. Only `PATH` and explicitly configured env vars are passed."

### A5. Vercel rollback targets the wrong hostname

**Evidence:**

- `src/core/stages.ts:844-866` — `PromoteStage.#runRealVercel` stores `prod.url` from `vercel deploy --prod` as `live_url`.
- `src/core/stages.ts:1109-1128` — `ObserveStage.#triggerVercelRollback` derives `prodAlias` by stripping `https://` from `live_url` and feeds it to `vercelRollback`.
- `src/adapters/vercel/runner.ts:251-265` — `vercelRollback` calls `vercel alias set <prior-url> <prod-alias>`.

**Why this kills the demo:**

`vercel deploy --prod` returns a deployment URL (e.g., `https://myapp-abc123.vercel.app`), not the stable production alias (e.g., `https://myapp.vercel.app` or a custom domain). Rolling back by aliasing a prior deployment URL to another deployment URL does nothing for actual user traffic.

If a judge knows Vercel (and many do), they'll spot this immediately. The README claims "preview → prod via vercel CLI, alias-based rollback" is real, but the actual implementation would fail in production.

**What to do:**

- **Short-term (demo):** De-scope Vercel rollback in the README. Change the claim from "real" to "preview deploy is real; rollback scaffolding is in place, full alias rollback is v2." Do not demo Vercel rollback unless you've tested it end-to-end with a custom domain.
- **Medium-term:** Capture the actual production alias before promotion. Store it separately from `live_url`. Use `vercel alias ls` or read `.vercel/project.json` to find the real alias.

---

## Category B: "Great README, Thin Control Loop" — High

These are mismatches between what the README promises and what the code proves. They won't necessarily break the demo, but they will surface in Q&A.

### B1. The canary stage does not actually split traffic

**Evidence:**

- `src/core/stages.ts:588-671` — `CanaryStage.#runRealFly` calls `flyDeploy` with `--strategy canary`. Fly's canary strategy is real — it deploys one machine, waits for health, then the rest. But there is **no traffic percentage control**. The emitted `traffic_split_percent: 5` is fiction.
- `src/core/stages.ts:730-756` — `PromoteStage` scripted path emits `traffic_split_percent: 10, 25, 50, 100` with nothing actually driving those splits.

**Why this matters:**

The README promises: *"Promote through canary steps only when real signals stay healthy"* and lists `10% → 25% → 50% → 100%`. But on Fly, there's no native traffic percentage control outside of `fly machine update --metadata` or proxy-level splitting. Convoy does not implement either.

**What to do:**

- Be honest in the README: "Fly canary strategy deploys one machine first, verifies health, then rolls to the rest. True traffic-percentage splitting requires proxy-level controls (v2)."
- In the demo, narrate what Fly actually does: "Fly's canary strategy — one machine at a time with health gates — is what we get here."

### B2. Health validation is much weaker than claimed

**Evidence:**

- README promises: *"canary percentages, baseline comparison, error fingerprint checks, and bake-window gating."*
- `src/core/stages.ts:935-1011` — Real Fly observe logic computes error rate and p99 from repeated probes to one health endpoint. No baseline delta. No fingerprint diffing. No traffic-split verification.
- `src/core/stages.ts:758-813` — Real Fly promote logic is just "3 consecutive health probe successes."

**Why this matters:**

A judge will ask: "How do you know the canary is healthy?" The honest answer is "we probe `/health` every 2 seconds." That's not canary analysis — that's a health check. Real canary analysis compares golden signals between baseline and candidate, weighted by traffic split.

**What to do:**

- Narrow the README claims to what the system actually proves.
- Add one real signal comparison: store `rehearsal.metricsAfter` on the run, then in observe, compare live p99 to rehearsal p99 with a configurable delta threshold.
- This is a 20-line change that makes the narrative real.

### B3. The medic's "config fix and retry" path is not implemented

**Evidence:**

- `docs/architecture.md:89` says: *"For config-level failures, medic may patch the Convoy-authored file and retry."*
- `src/core/medic.ts` produces a `Diagnosis` with `suggestedFix.patch`, but nothing in the orchestrator consumes that patch.
- `src/core/orchestrator.ts` catches `RehearsalBreachError`, sets status to `awaiting_fix`, and stops. There is no retry loop.

**Why this matters:**

The medic is one of the most visually impressive parts of the demo — the diagnosis card with Opus 4.7 reasoning, root cause, file:line, suggested fix. But the story says "config-level failures get patched and retried," and that doesn't happen.

**What to do:**

- Either implement the retry loop (medium effort), or change the narrative to: "Medic produces a diagnosis. For config issues, Convoy proposes a patch and pauses — you approve the retry. For code issues, the fix is yours."
- The web UI could show a "Retry with patch" button when `classification === 'config'` and `suggestedFix.patch` exists.

---

## Category C: Visual & Narrative Polish — Medium

These won't sink the demo, but they will make the difference between "good hackathon project" and "grand prize winner."

### C1. The web UI lacks live progress feel

**Evidence:**

- `web/app/runs/[id]/refresher.tsx` — full-page `router.refresh()` every 1.5 seconds. The entire page re-renders, causing visible flicker.
- There is no progress bar, no ETA, no "stage X of 7" indicator beyond the small pipeline badges.

**What to do:**

- Add a progress bar at the top of the run page: `(completedStages / 7) * 100%`.
- Add an ETA estimate based on `plan.estimate.runTimeMinutesMax` and elapsed time.
- Consider Server-Sent Events or a lightweight WebSocket for true push updates. Even a 15-minute implementation with `EventSource` would be dramatically more impressive than polling refresh.

### C2. The plan detail page has a disabled "Apply" button

**Evidence:**

- `web/app/plans/[id]/page.tsx:54-64` — The Apply button is `disabled` with a tooltip saying "Apply from CLI."

**What to do:**

- Make it real. Add a server action that spawns the CLI (`npm run convoy -- apply <plan-id>`) and redirects to the run page. This is the single most impactful web UI change for the demo — being able to click "Apply" in the browser and watch the pipeline start is a "wow" moment.

### C3. The CLI output is sparse during long operations

**Evidence:**

- `src/cli.ts:75-99` — `renderRunEvent` only shows compact payloads. During a 30-second `fly deploy`, the operator sees nothing except error lines.
- `src/adapters/fly/runner.ts:197-201` — Fly deploy logs are filtered through `onLog` but only lines matching `/error|failed|panic/i` are emitted.

**What to do:**

- Emit periodic progress dots during long operations: `fly.deploying ...` with a spinner.
- Show the most recent non-noise log line every 3-5 seconds so the operator knows something is happening.

### C4. The plugin is a skeleton

**Evidence:**

- `plugin/` contains markdown agent definitions and command stubs, but no actual integration with Claude Code's plugin system.
- `plugin/README.md` does not explain how to install or use the plugin.

**What to do:**

- If the plugin is not functional, remove it from the demo narrative or mark it clearly as "v2, in design."
- A broken plugin claim is worse than no plugin claim.

---

## Category D: Sharp Edges & Operator Risks

### D1. Prefix resolution is ambiguous

**Evidence:**

- `src/core/state.ts:178-189` — `getRun(id)` accepts a 7+ char prefix and returns the first match.
- `web/lib/runs.ts:106-119` — Same for `getRun` in the web layer.
- `src/cli.ts:823-832` — `resolvePlan` accepts prefix and returns the first match.

**Why this matters:**

Under stress (e.g., a live demo with multiple plans), prefix collision is real. A UUID prefix of `a1b2c3d` could match the wrong run.

**What to do:**

- Require exact IDs in the web UI (it already has the full ID from the database).
- In the CLI, if a prefix matches more than one plan/run, error with "ambiguous prefix — use the full ID."

### D2. Real author leaves the repo on the Convoy branch

**Evidence:**

- `src/core/github-runner.ts:167-180` — After `createPrFromAuthoredFiles`, the local checkout is on the `convoy/<id>` branch. There is no restoration of the previous branch or working context.

**Why this matters:**

After the demo, the operator's repo is on a feature branch. If they run `git status`, they'll see they're not on `main`. It feels unpolished.

**What to do:**

- Before branching, save the current branch name. After push, check out the original branch.
- This is a 3-line change.

### D3. No timeout on approval polling

**Evidence:**

- `src/core/stages.ts:205-219` — `awaitApproval` polls every 400ms with no timeout. The comment says "No timeout — operator drives."

**Why this matters:**

If the operator walks away, the run consumes a connection/thread indefinitely. In a demo, this is fine. In any real usage, it's a resource leak.

**What to do:**

- Add a configurable timeout (default 30 minutes) with a clear message: "Approval timed out after 30 minutes. Re-run `convoy apply` to resume."

---

## Category E: Opus 4.7 Integration Risks

### E1. The model string may not resolve

**Evidence:**

- `src/core/medic.ts:3` and `src/planner/enricher.ts:15` both use `const MODEL = 'claude-opus-4-7';`.
- Anthropic's actual model identifiers follow patterns like `claude-opus-4-7-20251001` or similar date-suffixed versions.

**Why this matters:**

If `'claude-opus-4-7'` is not a valid model identifier in the Anthropic API, every AI call will 404. The fallback (`skipped-no-key` or `error`) will trigger, and the demo will show deterministic, bland output instead of the impressive Opus narrative.

**What to do:**

- Verify the exact model identifier with the hackathon organizers or the Anthropic docs.
- Add a preflight check at startup: call the Anthropic API with a tiny request and confirm the model exists.
- If the model string is wrong, the entire "Built with Opus 4.7" story collapses.

### E2. No retry or backoff on AI calls

**Evidence:**

- `src/planner/enricher.ts:82-103` — Single `client.messages.create()` call. No retry on rate limit or transient failure.
- `src/core/medic.ts:60-86` — Same.

**Why this matters:**

Hackathon demo days mean high API load. A single rate-limit error will kill the Opus enrichment pass and the medic diagnosis.

**What to do:**

- Add a simple retry loop (3 attempts, exponential backoff) around AI calls.
- Cache successful enrichments aggressively (the cache already exists — make sure it works).

---

## Priority Action Plan — Before Demo Day

### Must-fix (demo will fail without these)

| # | Fix | Effort | Files |
|---|-----|--------|-------|
| 1 | **Wire real `scanRepository()` into `ScanStage`** | 30 min | `src/core/stages.ts` |
| 2 | **Wire real `pickPlatform()` into `PickStage`** | 15 min | `src/core/stages.ts` |
| 3 | **Make auto-approve opt-in (`--auto-approve`)** | 10 min | `src/cli.ts`, `src/core/stages.ts` |
| 4 | **Bind approval decisions to `run_id`** | 10 min | `web/lib/runs.ts`, `web/app/actions.ts` |
| 5 | **Verify `MODEL` string against Anthropic API** | 5 min | `src/core/medic.ts`, `src/planner/enricher.ts` |
| 6 | **De-scope or fix Vercel rollback claims** | 10 min | `README.md`, `docs/architecture.md` |

### Should-fix (judge will notice)

| # | Fix | Effort | Files |
|---|-----|--------|-------|
| 7 | **Add `--trust-repo` gate for rehearsal** | 20 min | `src/cli.ts`, `src/core/rehearsal-runner.ts` |
| 8 | **Scrub rehearsal environment** | 15 min | `src/core/rehearsal-runner.ts` |
| 9 | **Add rehearsal→observe baseline comparison** | 20 min | `src/core/stages.ts` |
| 10 | **Narrow README claims to reality** | 20 min | `README.md` |
| 11 | **Add retry loop around AI calls** | 15 min | `src/core/medic.ts`, `src/planner/enricher.ts` |
| 12 | **Restore original branch after PR creation** | 5 min | `src/core/github-runner.ts` |

### Could-fix (polish for grand prize)

| # | Fix | Effort | Files |
|---|-----|--------|-------|
| 13 | **Make "Apply" button work in web UI** | 30 min | `web/app/plans/[id]/page.tsx` + new server action |
| 14 | **Add progress bar to run page** | 20 min | `web/app/runs/[id]/page.tsx` |
| 15 | **Add SSE or push updates instead of polling refresh** | 45 min | `web/app/runs/[id]/refresher.tsx` + API route |
| 16 | **Add CLI spinner during long operations** | 15 min | `src/cli.ts`, `src/adapters/fly/runner.ts` |
| 17 | **Add timeout to approval polling** | 10 min | `src/core/stages.ts` |
| 18 | **Reject ambiguous prefixes** | 10 min | `src/cli.ts`, `src/core/state.ts` |

---

## What the Demo Script Should Actually Say

### Current (risky)

> "Convoy cloned the repo, scanned it — Next.js, Prisma, Postgres — and wrote this plan with Opus 4.7."

### Better (honest and still impressive)

> "Convoy scanned the repo in about a second — detected Node.js, Express, no Dockerfile, no existing platform config. The picker scored all four platforms; Fly won for an API-only service. Opus 4.7 then wrote the Dockerfile and the fly.toml tailored to this exact repo."

### Current (risky)

> "Preflight. Everything Convoy's about to do, verified before a single byte moves."

### Better

> "Preflight checks every real stage before it runs — gh auth, fly auth, start command detection. If anything's missing, Convoy stops and tells you exactly how to fix it."

### Current (risky)

> "Fly canary strategy — one machine at a time with health gates, then the rest. This just happened for real."

### Better (same, actually accurate)

> "Fly's canary strategy deploys one machine, verifies health, then rolls the rest. No traffic percentage control yet — that's v2 — but the health-gated progression is real."

---

## Bottom Line

Convoy is **genuinely impressive** in three areas:

1. **The web UI is beautiful.** The run timeline, medic diagnosis card, rolled-back banner, and plan detail page are production-quality. Judges will notice.
2. **The Fly rollback is real.** `docs/rollback-proof.md` proves it. The observe → breach → rollback → record sequence is end-to-end tested.
3. **The narrative is strong.** "We ship your code, we don't rewrite it" is a clear, defensible position.

The risk is not "the code doesn't work." The risk is **"the story is bigger than the code, and a curious judge will find the gap."**

If you fix the six must-fix items above, the demo becomes **narratively consistent** — what you say matches what happens. That consistency is what separates a polished prototype from a grand prize winner.

**The bar for grand prize is not "does it work on the happy path." It's "does the story hold up when the judge pushes."**

Make the story hold up.
