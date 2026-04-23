# Convoy — Demo Script

Target length: **2:45–3:00**. Three acts. All real. The centerpiece is Act 3: the medic is a Claude agent with scoped tools, watching itself think in the browser.

## Setup (off-camera)

- **Terminal 1**: in `~/convoy`. `.env` has `ANTHROPIC_API_KEY`.
- **Terminal 2**: reserved (optional Fly check / resume).
- **Browser**: empty — the CLI will launch tabs via `--open`.
- **Prereqs verified**: `gh auth status`, `fly auth whoami` green.
- **Clean slate**:
  ```bash
  rm -rf .convoy/state.db .convoy/plans .convoy/clones .convoy/cache web/.next
  ```
- **Web viewer running**:
  ```bash
  (cd web && npm run dev)   # http://localhost:3737
  ```
- **Optional: pre-save one plan** for Act 3 so it's already picked for injection:
  ```bash
  npm run convoy -- plan ./demo-app --save
  ```

---

## Act 1 — "Here's the plan." (45s)

> **Voiceover:** "This is Convoy. Point it at a repo and it ships it. Nothing autonomous happens before you see the plan."

1. Terminal 1:

```bash
npm run convoy -- plan https://github.com/teckedd-code2save/urbanize --save --open
```

2. CLI streams: `clone.done`, scan evidence (`framework=next.js, topology=web+worker, data=[postgres], has_dockerfile=true, existing_platform=fly`), and the picker's `chosen=fly reason=continuing existing fly setup detected in the repo source=existing-config`.
3. The browser pops straight to the plan page (`--open`).

> "Convoy just scanned urbanize — a real Next.js 15 app with a separate BullMQ worker, PostGIS, Redis, and Clerk. It read package.json, fly.toml, the worker directory, docker-compose. The picker respected urbanize's existing fly.toml — source: existing-config. That's not hardcoded — it's live `scanRepository()` on every run."

4. Scroll the plan page: **What Convoy will author** — only `.env.schema` and `.convoy/manifest.yaml`.

> "Two files. That's it. The existing Dockerfile stays. `src/` stays. `worker/` stays. Convoy ships your code — it doesn't rewrite it."

5. Scroll to **How I'll ship this** — Opus 4.7's first-person narrative: scan, PR, rehearsal on a twin, approval, canary, observe, rollback.

> "Seven steps, first person. Convoy explains its own plan."

---

## Act 2 — "Shipping it live." (75s)

> **Voiceover:** "Let's ship a real service. Humans decide every gate."

1. Terminal 1 (switch to demo-app so rehearsal is fast):

```bash
npm run convoy -- ship ./demo-app --open
```

2. CLI streams:

```
Plan <id> saved (narrative: ai)
Target: demo-app (node, express)
Platform: fly (scored)
▶ Plan in web UI: http://localhost:3737/plans/<id>

Preflight
  ✓ anthropic model    claude-opus-4-7 resolved
  ✓ real author        gh authed as teckedd-code2save — will open PR
  ✓ real rehearsal     will spawn `node dist/server.js` on port 8080;
                       parent env scrubbed to PATH/HOME/NODE_ENV
  ✓ real fly           flyctl authed — will deploy
```

> "Preflight. Anthropic model resolved — the medic agent will be live. Rehearsal env is scrubbed by default so nothing exfiltrates — only PATH/HOME/NODE_ENV pass through unless I pass `--trust-repo`. Everything verified before any byte moves."

3. `◆ Convoy run <id> started — ▶ Watch live: http://localhost:3737/runs/<id>`. The browser auto-opens the run page.

> "Agent and I look at the same page. Approvals I click here unpause the pipeline in ~400ms."

4. Web UI: progress bar fills. `▸ author` → **Approval card pops up** for `merge_pr`.
5. Click **Approve** in the browser.

> "Approval is bound to the run id at the SQL level. Knowing an approval UUID isn't enough — the server action verifies the run it belongs to."

6. Terminal: `pr_url=... merged=true`. Progress bar ticks forward. `▸ rehearse` starts. Real `npm ci`, real boot, real probe.

> "Real subprocess. Real health probe. Real load. If it breaches, the medic takes over."

7. `▸ canary` requests `promote`. Approve.
8. `▸ promote`, `▸ observe`, `◆ Convoy succeeded. Live URL: https://...fly.dev`.
9. Click the live URL. 200 OK.

> "From `convoy ship` to serving traffic. Every gate a human decision. The CLI and the browser followed each other the whole way."

---

## Act 3 — "The medic is a Claude agent." (55s)

> **Voiceover:** "Here's the part nobody else is doing."

1. Terminal 1:

```bash
npm run convoy -- apply <plan-id> --inject-failure=rehearse -y --open
```

2. Pipeline advances to `▸ rehearse`. The injector trips a p99 breach. Then:

```
· phase=medic.invoked
◇ medic read_log_tail n=50
◇ medic grep_repo /orders_query_timeout|deadline/
◇ medic read_file src/routes/orders.ts
◇ medic finalize_diagnosis
! rootCause=src/routes/orders.ts has a DEMO_MODE=buggy branch...
  classification=code  confidence=high  owned=developer
```

> "The medic is not a prompt with some JSON at the end. It's Claude as an agent. Opus 4.7 with four scoped tools — read_log_tail, read_file, grep_repo, finalize_diagnosis. The agent chose what to call and when to stop."

3. Switch to browser — the run page already has a **Medic investigation** section listing each tool call as it happens.

> "You can watch the agent think. Here — it read the log tail, grepped for the timeout pattern, found it in orders.ts, read the file, finalized. Six tool calls, twelve seconds."

4. Scroll to the **Medic's diagnosis** card. Show:
   - classification=`code`
   - owned=`developer`
   - Location: `src/routes/orders.ts`
   - Suggested fix: plain-language description, NO patch

> "Code is developer-owned — Convoy will not patch it. The agent's system prompt says so, and the downstream logic enforces it. Path-traversal refused at the tool boundary — the agent literally cannot read files outside the repo. The pipeline pauses. I push a fix. `convoy apply` resumes."

5. (Optional, 15s) Point at `docs/rollback-proof.md` and show the rolled-back banner on a prior run.

> "And when it breaches in production — observe trips the rollback itself. `fly deploy --image <prior>`. Service recovers in seconds. Proof in rollback-proof.md."

---

## Close — "This is Convoy." (15s)

1. Cut back to `/runs` or the plan page.

> "Convoy. We ship your code — we don't rewrite it. Plan before act. Humans decide every gate. Medic is Claude as a managed agent with scoped tools — and as far as we can tell nobody else has shipped that pattern to production diagnostics. Built with Opus 4.7 for the hackathon."

2. (Optional) Cut to a Claude Code prompt:

```
/convoy:ship https://github.com/your-org/your-repo
```

> "Same pipeline, inside Claude Code."

---

## Fail-safes during recording

- **Keep `ANTHROPIC_API_KEY` set** or the medic agent loop falls back to deterministic output. Preflight warns you if the key is unset.
- **Pre-clone urbanize** offline-first (`convoy plan https://github.com/teckedd-code2save/urbanize --save` off-camera). The demo then re-uses the cache.
- **Pre-create the Fly app** for Act 2 or rely on `--fly-create-app` (default). Cold-start adds ~30s.
- **If the web dev server caches wrong**: `pkill -f "next dev" && rm -rf web/.next && (cd web && npm run dev)`.
- **If a Fly app from a prior take lingers**: `fly apps list | grep convoy-demo-` and `fly apps destroy <name>`.
- **Web approval lag**: the run page polls every 1.5s. Approve, count to two, narrate "continuing."
- **If the medic agent errors during Act 3**: the injected-failure fallback path still produces a diagnosis card — just deterministic. Still worth showing the scoped-tool concept.

## Fallback variants

- **Zero-credentials demo**: `ship ./demo-app --demo -y` runs the full 7 stages scripted. ~15s end to end.
- **Medic-agent-only demo** (no deploy): `apply <plan> --inject-failure=rehearse -y` triggers the agent loop against fixture logs — shows the six tool calls without any real deploy.
- **Rollback-only demo**: narrate from `docs/rollback-proof.md` — the sequence, timings, and `fly releases` output are already captured there.
