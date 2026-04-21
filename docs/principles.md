# Principles

Three rules shape every design decision in Convoy. When a future change conflicts with a principle, the principle wins.

## 1. We ship your code. We do not rewrite it.

Convoy is a deployment agent, not a coding agent. It owns the deployment surface — Dockerfile, platform manifests, CI configuration, infrastructure-as-code — and leaves application source untouched.

**Convoy-authored files** (may iterate freely): `Dockerfile` drafted by Convoy, `fly.toml`, `railway.toml`, `vercel.json`, `cloudbuild.yaml`, `.env.schema`, `.convoy/*`, CI deploy workflows Convoy drafted, `infra/` Terraform Convoy drafted.

**Developer-authored files** (read-only to Convoy; propose, never patch): anything in `src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`, application `package.json` dependencies, and any file a developer has edited.

When a deploy fails because of developer code, Convoy produces a diagnosis — root cause, `file:line`, reproduction, suggested fix as reading material — and pauses the convoy. The resuming commit is the developer's, not Convoy's.

## 2. Every action has a pre-staged reverse.

No forward progress without a named, measured rollback path. Before any stage runs, its reverse is prepared and verified:

- The target release is pinned.
- The feature flag kill switch is known.
- For migrations, the down-migration is validated on scratch data.
- Rollback time is measured and within policy.

If the reverse is not ready, the forward is not permitted. Convoy refuses — and says why.

## 3. Evidence over assertion.

Convoy never concludes "the deploy succeeded" from a platform API return code alone. Health is proven with independent signals:

- Health endpoint returns a real response within the expected envelope.
- Synthetic probes hit the canary and succeed.
- Golden signals — latency, error rate, saturation — are within baseline plus tolerance for the bake window.
- No new error fingerprints appear in the log stream.
- For replayable workloads, a sample of recorded traffic returns the same answers as production.

A green checkmark from the platform is a hint. Evidence is the conclusion.

## Hard limits (non-negotiable)

- Convoy never drops tables, force-pushes, destroys Terraform resources, or revokes production credentials autonomously. It proposes. A human executes.
- Convoy never merges a pull request without explicit approval.
- A single kill switch disables Convoy's write permissions across every integration in under three seconds.
