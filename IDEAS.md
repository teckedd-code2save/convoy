# IDEAS — Convoy Product Roadmap

> Forward-looking ideas for Convoy, organized by area. Not commitments — these are directions the product could grow based on real-world deployment needs.

---

## P0 — Core Stability & Safety

### Platform adapter template + scaffolding

Writing a new adapter (Fly, Railway, Render, Cloud Run, Kubernetes) requires duplicating boilerplate. Create a `convoy adapter init` command that scaffolds an adapter skeleton with the interface contract, plus template tests for real and scripted modes. This would let the community (and Convoy itself) ship adapters faster.

**Why P0:** Adapters are Convoy's moat. Every platform Convoy can deploy to is a deployment Convoy doesn't fail on.

### State migration + snapshot for long-running approvals

`.convoy/state.db` is ephemeral. If an operator runs `convoy plan` today, the plan exists. If they re-clone the repo tomorrow, the plan is gone. Add `convoy state snapshot` and `convoy state restore` that serializes/deserializes the state store to a checked-in file (`deployments/state.json`) so plans survive repo cloning. Also support schema version migration so old state files don't break on Convoy upgrades.

### GitHub deployment protection rules integration

Instead of a CLI flag `--auto-merge`, integrate with GitHub's deployment protection rules: Convoy creates a deployment, waits for required reviewers/environments, and only proceeds when the deployment gate passes. This makes Convoy safe for org-wide use where a human must approve before deploy.

---

## P1 — Multi-Platform & Infra

### Kubernetes adapter (kubectl + Helm)

The most-requested platform. Should support:
- `kubectl apply -f` for raw manifests
- `helm upgrade --install` for Helm charts
- Canary via `kubectl rollout status` and `kubectl set image`
- Rollback via `helm rollback` or `kubectl rollout undo`
- Observability via `kubectl logs --tail` and `kubectl get events`

### Docker Compose adapter (remote hosts)

Support deploying via `docker compose up` on a remote host over SSH, plus `docker compose ps` for health and `docker compose down` for rollback. This would cover self-hosted VPS setups (GroundControl synergy).

### Terraform adapter (infra provision → deploy)

Many teams use Terraform to provision infra and then deploy on top. Convoy could offer a two-phase adapter: (1) run `terraform apply`, wait for outputs; (2) use those outputs (e.g., load balancer DNS, DB connection string) in the deployment manifest. This bridges the infra/devops gap.

### Container registry guard (private registries)

Convoy currently pushes to Fly's registry. For Docker Compose and k8s adapters, it needs to push to a user-specified container registry (Docker Hub, GHCR, ECR, GCR) and handle auth via environment variables or credential helpers.

---

## P2 — Intelligence & UX

### Pre-commit scan diff mode

Instead of running `convoy plan` against the full repo, run `convoy plan --diff <sha>` that shows what changed between two commits and only generates deployment files for the changed services. Essential for monorepos with 20+ microservices.

### Auto-retry with backoff for transient failures

If rehearsal fails because the target didn't start in time, or canary signals breached briefly then recovered, Convoy should retry with exponential backoff instead of immediately rolling back. The operator sets a `--bake-window` (already partly implemented) and a `--retry-limit`.

### Convoy-as-MCP-server

Expose Convoy's entire capability as an MCP server so any MCP client (Claude Code, Codex, Gemini CLI) can run `plan` / `apply` / `rollback` as tool calls. The `plugin/` directory already has the MCP plugin structure — this would evolve it into a first-class server.

### Slack/Teams notification channel

Notify the operator (and their team) when a deployment starts, succeeds, fails, or auto-rolls back. Include links to the PR, the Fly app URL, and the convict signal dashboard. A webhook URL in `.convoy/config.json` would be the minimal integration.

---

## P3 — Experiments & Nice-To-Have

### Synthetic signal injection for medic demos

Already partially implemented via `--inject-failure=rehearse`. Extend to inject per-signal breaches (error-rate spike, p99 latency, request volume drop) so medic's rollback response can be demonstrated without a real broken deploy.

### Convoy web viewer as a deployment dashboard

The Next.js viewer currently reads the SQLite DB for approval decisions. Extend it to show a timeline of all deployments across all projects, with per-run signals, breach events, rollback history, and a "rollback now" button. This turns Convoy from a CLI tool into a deploy ops dashboard.

### Air-gapped / offline mode

Not everyone deploys to the public cloud. Air-gapped environments (defense, finance, healthcare) need Convoy to work without any external API calls (no GitHub, no Fly, no Hugging Face). A "local-only" mode where Convoy stages files but never talks to the network.

### SQLite → Postgres adapter for team state

When multiple operators run Convoy on the same repo, they need shared state. Swap the SQLite backend for a pluggable store interface with a Postgres implementation. This also enables the web viewer to be deployed as a multi-user dashboard.

### Cost estimation before deployment

Before applying, Convoy could estimate the cost of the deployment (Fly machine specs × duration, compute/gpu hours, storage). Useful for teams on a budget.

### Declarative deployment config

Instead of inferring everything from the repo, allow a `convoy.yaml` file at the repo root that explicitly declares platforms, environment variables, health check paths, and canary thresholds. This gives operators explicit control when the auto-detection gets it wrong.

---

## Under Consideration

- **Self-hosted Convoy Agent**: A lightweight daemon that runs on the deploy target and pings Convoy for new deployments, enabling pull-based (not push-based) deploys.
- **Database migration runner**: Before deploying new code, run pending migrations. Roll back the DB migration if the code deploy fails.
- **Blue/green traffic shifting**: For platforms that support it (k8s via Service mesh, Fly via volume attach), shift traffic gradually instead of deploying new instances alongside old ones.
- **Convoy plugin marketplace**: Community-written adapters, notification channels, and pre/post-deploy hooks as npm packages.
