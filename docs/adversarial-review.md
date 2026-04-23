# Convoy Adversarial Review

Date: 2026-04-22

Scope: repo-level adversarial review focused on operator trust, unsafe defaults, path/file integrity, deployment correctness, and "judge can break this live" failure modes.

## Executive Summary

Convoy has a strong story, but the current trust boundaries are looser than the README implies. The biggest risks are:

1. The approval path is effectively unauthenticated and does not bind a decision to the claimed run.
2. Saved plans are trusted as executable artifacts without integrity checks, and authored file paths are not containment-checked before writing to disk.
3. "Real by default" rehearsal runs repository-controlled shell commands with the operator's ambient environment.
4. The Vercel rollback path is likely incorrect in real-world production setups.

If you want this to feel grand-prize caliber, I would harden those four before polishing anything cosmetic.

## Findings

### 1. Critical: approval decisions are not authenticated and are not bound to the run ID

Evidence:

- `web/app/actions.ts:7-20` accepts `runId`, `approvalId`, and `decision`, but only uses `approvalId` to update state.
- `web/lib/runs.ts:179-206` updates `approvals` by `id` only; it does not verify that the approval belongs to the supplied run.
- The README presents the web UI as the control surface for live approvals: `README.md:29-36`, `README.md:159`.

Why this matters:

- Any caller that can hit the server action and knows or can obtain an approval UUID can approve or reject that step.
- The `runId` parameter is cosmetic today. A forged request can claim to act on one run while mutating another.
- If you demo the web UI over a tunnel or shared environment, this becomes a real control-plane vulnerability, not a theoretical one.

What I would do:

- Require operator auth before any approval mutation.
- Change the write path to `UPDATE approvals ... WHERE id = ? AND run_id = ? AND status = 'pending'`.
- Record actor identity on each decision.
- Consider signed, one-time approval tokens if the UI must stay lightweight.

### 2. High: saved plans are trusted blindly, which makes `apply` a file-writing primitive

Evidence:

- `src/core/plan.ts:137-140` loads arbitrary JSON from `.convoy/plans/<id>.json` with no integrity validation.
- `src/cli.ts:636-652` passes `plan.author.convoyAuthoredFiles` straight into the real author flow.
- `src/core/github-runner.ts:171-175` writes each file using `join(ctx.path, file.path)` with no containment check.

Why this matters:

- A tampered plan can change the authored file list and file contents without re-running scan/pick/author.
- Because file paths are not normalized and checked to stay inside the repo root, a path like `../somewhere-sensitive` can escape the target repository.
- That means the saved plan is not just a review artifact; it is an executable instruction set with no signature, no provenance re-check, and no path safety guard.

What I would do:

- Treat plans as signed artifacts: bind them to repo URL, SHA, workspace, and a hash of the authored file set.
- Revalidate authored file paths at `apply` time.
- Reject any path containing traversal or resolving outside the repo root.
- Consider regenerating the author step from deterministic inputs instead of trusting serialized file contents blindly.

### 3. High: real rehearsal executes untrusted repository commands with the operator's ambient environment

Evidence:

- `src/core/rehearsal-runner.ts:163-169` runs install/build commands via `spawn('sh', ['-c', shellCmd])` and passes `process.env`.
- `src/core/rehearsal-runner.ts:193-203` runs the repo start command the same way, again with ambient env.
- `src/cli.ts:760-793` builds rehearsal config from repo-derived commands plus env-file and CLI-supplied secrets.
- `src/cli.ts:319-324`, `src/cli.ts:938-1001`, and `README.md:149-168` make the real path the default behavior.

Why this matters:

- `convoy ship owner/repo` is effectively "clone untrusted code and run its install/build/start scripts on my machine with my tokens in scope."
- That repo can exfiltrate `ANTHROPIC_API_KEY`, `GH_TOKEN`, Fly/Vercel credentials, SSH material, cloud credentials, or anything else present in the operator environment.
- In a hackathon setting, this is the kind of objection that experienced judges will spot immediately.

What I would do:

- Make real rehearsal opt-in for cloned/remote targets.
- Run rehearsal inside a container or heavily scrubbed subprocess environment.
- Default-deny ambient env inheritance; pass only explicitly allowlisted vars.
- Add a trust gate such as `--trust-repo` or `--allow-local-exec`.

### 4. High: Vercel rollback likely targets the wrong hostname

Evidence:

- `src/core/stages.ts:844-866` stores `prod.url` from `vercel deploy --prod` as the run's `live_url`.
- `src/core/stages.ts:1109-1128` later derives `prodAlias` by stripping the hostname from that `live_url` and feeds it to `vercelRollback`.
- `README.md:165` claims "preview -> prod via vercel CLI, alias-based rollback" is real.

Why this matters:

- `prod.url` is typically a deployment URL, not necessarily the stable production alias or custom domain users are actually hitting.
- Re-using that value as the alias target for rollback is brittle and in many cases wrong.
- The failure mode is bad: the system can claim rollback support while being unable to restore the real production entrypoint under pressure.

What I would do:

- Capture the actual production alias or custom domains before promotion.
- Store rollback metadata explicitly instead of reconstructing it from `live_url`.
- Validate rollback end-to-end in a real Vercel project with custom domains before marketing it as production-ready.

### 5. Medium: the product's safety story does not match its runtime defaults

Evidence:

- The README says "Nothing autonomous happens without the plan on the table" (`README.md:43`) and frames the approval loop as human-driven (`README.md:29-36`, `README.md:159`).
- `src/core/stages.ts:197-202` auto-approves by default.
- `src/cli.ts:321-324`, `src/cli.ts:939-947`, and `src/cli.ts:996-1001` make real PR creation, real rehearsal, and real deploy the default path.

Why this matters:

- A first-time operator who follows the happy path can trigger merges and deployments with less friction than the README suggests.
- This is not just a messaging issue; it changes the risk posture of the whole tool.
- Judges are likely to ask whether the safety model is opt-in or opt-out. Right now it is mostly opt-out.

What I would do:

- Make production side effects explicit: `--real-author`, `--real-rehearsal`, `--real-deploy`, or a single `--execute-for-real`.
- Keep `plan` fully passive and `apply` approval-blocked by default.
- Preserve a fast demo mode separately so the safer default does not hurt your presentation.

### 6. Medium: real health validation is much weaker than the README claims

Evidence:

- The README promises canary percentages, baseline comparison, error fingerprint checks, and bake-window gating: `README.md:45-47`, `README.md:64-67`.
- Real Fly promote logic is just repeated health probes until three consecutive successes: `src/core/stages.ts:758-813`.
- Real Fly observe logic computes error rate and p99 from repeated probes to one health endpoint: `src/core/stages.ts:935-1011`.

Why this matters:

- A service can keep `/health` green while the real user path is degraded or broken.
- There is no actual baseline delta comparison, no new fingerprint detection, and no proof that traffic splitting matches the stated rollout narrative.
- This is exactly the kind of "great README, thin control loop" mismatch that gets exposed in live Q&A.

What I would do:

- Probe at least one real user path chosen from the scan/plan, not just `/health`.
- Compare post-deploy metrics to rehearsal baseline explicitly.
- Add fingerprint diffing on recent logs or errors.
- Narrow the README claims until the implementation catches up.

## Additional Sharp Edges

- Prefix resolution is ambiguous. `src/core/state.ts:178-189`, `web/lib/runs.ts:106-119`, and `src/cli.ts:823-832` accept prefix matches and return the first hit instead of requiring a unique match. That is convenient, but it is also how operators act on the wrong run or plan under stress.
- Real author mutates the target repo checkout in place and leaves it on the Convoy branch. `src/core/github-runner.ts:167-180` does not restore the previous branch or working context after opening the PR. That is more of an operator experience risk than a security bug, but it will feel rough in a live demo.

## Priority Order Before a Serious Demo

1. Lock down approvals.
2. Validate and contain plan-authored file paths.
3. Put real rehearsal behind an explicit trust boundary and env scrubber.
4. Fix or de-scope Vercel rollback claims.
5. Make the safety defaults match the story.
6. Tighten observability claims to what the system actually proves.

## Bottom Line

Convoy already has a compelling narrative and a strong repo shape. The current gap is not "more AI"; it is control-plane rigor.

If you harden approvals, plan integrity, local execution trust, and rollback correctness, the project will read much more like a serious deployment system and much less like a polished demo with optimistic assumptions.
