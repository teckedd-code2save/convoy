/**
 * Convoy MCP server — exposes the deployment pipeline as agent-callable
 * tools. Any MCP client (Claude Code mid-session, Cursor, a CI webhook
 * runner) can plan, apply, watch, approve, and diagnose deployments without
 * a human at the CLI.
 *
 * Tool registration lives in `registerConvoyTools` and is transport-agnostic:
 * `src/mcp/index.ts` wires it to stdio today; a Streamable HTTP endpoint can
 * reuse the exact same registration later for hosted/CI use.
 *
 * IMPORTANT: nothing in this module may write to stdout — the stdio transport
 * owns it for JSON-RPC frames. Diagnostics go to console.error only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PlanStore } from '../core/plan.js';
import { RunStateStore } from '../core/state.js';
import type { Approval, Platform, Run, RunEvent } from '../core/types.js';
import type { RealVpsGhcrOpt } from '../core/stages.js';
import { resolveAnthropicKey, type ByokConfig } from '../core/key-resolver.js';
import { buildPlan } from '../planner/index.js';
import type { IdentityRef } from '../core/identity-store.js';
import type { DeployTarget, AccessVerification } from '../onboard/preferences.js';

// ---------------------------------------------------------------------------
// Path resolution — mirror the CLI's STATE_PATH / PLANS_DIR contract. The CLI
// resolves the env overrides (or the bare defaults) against its cwd, and the
// apply subprocess below is always spawned with cwd = REPO_ROOT, so both
// processes land on the same .convoy/ directory.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STATE_PATH = resolve(REPO_ROOT, process.env['CONVOY_STATE_PATH'] ?? '.convoy/state.db');
const PLANS_DIR = resolve(REPO_ROOT, process.env['CONVOY_PLANS_DIR'] ?? '.convoy/plans');
const WEB_BASE = (process.env['CONVOY_WEB_URL'] ?? 'http://localhost:3737').replace(/\/$/, '');

const SUPPORTED_PLATFORMS: readonly Platform[] = ['fly', 'railway', 'vercel', 'cloudrun', 'vps'];

function isPlatform(value: string): value is Platform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function watchUrl(runId: string): string {
  return `${WEB_BASE}/runs/${runId}`;
}

// ---------------------------------------------------------------------------
// Tool result helpers — JSON text on success, isError + plain message on
// failure. Handlers never throw raw; every failure path returns a result the
// calling agent can read and act on.
// ---------------------------------------------------------------------------

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Open the run state store, run fn, always close. */
async function withStore<T>(fn: (store: RunStateStore) => Promise<T> | T): Promise<T> {
  const store = new RunStateStore(STATE_PATH);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Serialization — compact, agent-readable shapes.
// ---------------------------------------------------------------------------

function runSummary(run: Run): Record<string, unknown> {
  return {
    runId: run.id,
    status: run.status,
    platform: run.platform,
    repoUrl: run.repoUrl,
    planId: run.planId,
    liveUrl: run.liveUrl,
    createdAt: run.startedAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    ...(run.outcomeReason ? { outcomeReason: run.outcomeReason } : {}),
  };
}

function eventSummary(event: RunEvent): Record<string, unknown> {
  return {
    stage: event.stage,
    kind: event.kind,
    ...(event.laneId ? { laneId: event.laneId } : {}),
    payload: event.payload,
    at: event.createdAt.toISOString(),
  };
}

function approvalSummary(approval: Approval): Record<string, unknown> {
  return {
    id: approval.id,
    kind: approval.kind,
    status: approval.status,
    payload: approval.summary,
    ...(approval.decidedAt ? { decidedAt: approval.decidedAt.toISOString() } : {}),
  };
}

function resolvePlanId(idOrPrefix: string): { id: string } | { error: string } {
  const store = new PlanStore(PLANS_DIR);
  const match = store.match(idOrPrefix);
  if (match.kind === 'exact' || match.kind === 'prefix') return { id: match.id };
  if (match.kind === 'ambiguous') {
    return { error: `Plan id "${idOrPrefix}" is ambiguous — matches: ${match.ids.join(', ')}` };
  }
  return { error: `Plan "${idOrPrefix}" not found. Use convoy_list_plans to see saved plans, or convoy_plan to create one.` };
}

// ---------------------------------------------------------------------------
// Tool registration (transport-agnostic)
// ---------------------------------------------------------------------------

// Reusable BYOK input schema — same shape accepted by both convoy_plan and
// convoy_apply. Teams supply this once per call; the server resolves the
// Anthropic key (Infisical fetch or direct) before any AI work starts.
const byokSchema = z.object({
  provider: z.enum(['infisical', 'direct'])
    .describe('"infisical" fetches ANTHROPIC_API_KEY from your vault via universal auth; "direct" accepts the key inline'),
  apiKey: z.string().optional()
    .describe('Required when provider=direct — the raw sk-ant-... key'),
  siteUrl: z.string().optional()
    .describe('Infisical instance URL (default: https://app.infisical.com)'),
  clientId: z.string().optional()
    .describe('Infisical universal-auth client ID'),
  clientSecret: z.string().optional()
    .describe('Infisical universal-auth client secret'),
  projectId: z.string().optional()
    .describe('Infisical project/workspace ID'),
  environment: z.string().optional()
    .describe('Infisical environment (e.g. "prod", "staging")'),
  secretName: z.string().optional()
    .describe('Secret name to fetch (default: ANTHROPIC_API_KEY)'),
}).optional().describe('BYOK: supply your own Anthropic API key so Convoy does not bill you for AI calls. Omit to use the server\'s key (if any).');

export function registerConvoyTools(server: McpServer): void {
  server.registerTool(
    'convoy_plan',
    {
      description:
        'Scan a local repository and create a deployment plan (platform pick, drafted files, rehearsal + rollback strategy). Saves the plan and returns its planId. Next step: convoy_apply with that planId.',
      inputSchema: {
        repoPath: z.string().describe('Path to the repository to plan (absolute, or relative to the Convoy repo root)'),
        platform: z.enum(['fly', 'railway', 'vercel', 'cloudrun', 'vps']).optional()
          .describe('Force a platform instead of letting Convoy score one'),
        workspace: z.string().optional()
          .describe('Subdirectory to target inside a monorepo (e.g. "backend", "apps/web")'),
        byok: byokSchema,
      },
    },
    async ({ repoPath, platform, workspace, byok }) =>
      guarded(async () => {
        const localPath = resolve(REPO_ROOT, repoPath);
        if (!existsSync(localPath)) {
          return fail(`Repository path not found: ${localPath}`);
        }
        if (platform !== undefined && !isPlatform(platform)) {
          return fail(`Unknown platform "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}`);
        }

        const apiKey = await resolveAnthropicKey(byok as ByokConfig | undefined ?? null);
        const { plan, enrichmentSource } = await buildPlan(localPath, {
          ...(platform !== undefined && { platformOverride: platform }),
          ...(workspace !== undefined && { workspace }),
          ai: { ...(apiKey && { apiKey }) },
        });

        const store = new PlanStore(PLANS_DIR);
        store.save(plan);

        const deployable = plan.deployability.verdict !== 'not-cloud-deployable';
        return ok({
          planId: plan.id,
          target: plan.target.name,
          platform: plan.platform.chosen,
          deployable,
          verdict: plan.deployability.verdict,
          ...(deployable ? {} : { reason: plan.deployability.reason }),
          blockers: plan.risks.filter((r) => r.level === 'block').map((r) => r.message),
          summary: plan.summary,
          narrativeSource: enrichmentSource,
          ...(deployable ? { nextStep: `convoy_apply with planId ${plan.id}` } : {}),
        });
      }),
  );

  server.registerTool(
    'convoy_list_plans',
    {
      description: 'List saved deployment plans (newest first). Use a returned planId with convoy_apply.',
      inputSchema: {},
    },
    async () =>
      guarded(() => {
        const store = new PlanStore(PLANS_DIR);
        const plans = store
          .listAll()
          .map((id) => store.load(id))
          .filter((plan): plan is NonNullable<typeof plan> => plan !== null)
          .map((plan) => ({
            planId: plan.id,
            target: plan.target.name,
            platform: plan.platform.chosen,
            createdAt: plan.createdAt,
          }))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return ok(plans);
      }),
  );

  server.registerTool(
    'convoy_apply',
    {
      description:
        'Apply a saved plan: runs the pipeline (scan → pick → rehearse → author → canary → promote → observe). Returns the run ID immediately; the pipeline runs in the background. Use convoy_status to follow progress and convoy_approve when the run pauses at a gate. Real PR (realAuthor) and local rehearsal (realRehearsal) are opt-in. Deploy: Fly is real by default; VPS/Railway/Cloud Run only deploy when configured (e.g. realVpsGhcr) — applying a VPS/Railway/Cloud Run plan without a real-deploy target is REFUSED, not silently scripted, so the run never reports a false success without shipping. PREREQUISITE for a real deploy: establish access first with convoy_connect — it verifies Convoy can reach + authenticate to the target and persists the (non-secret) target. If a real run is attempted without verified access it hard-blocks with a convoy_connect remedy.',
      inputSchema: {
        planId: z.string().describe('Plan id (or unique prefix) from convoy_plan / convoy_list_plans'),
        autoApprove: z.boolean().optional()
          .describe('Auto-approve every gate instead of pausing for convoy_approve (default false)'),
        realRehearsal: z.boolean().optional()
          .describe('Actually boot the target locally and probe /health + metrics (default false)'),
        realAuthor: z.boolean().optional()
          .describe('Open a real GitHub PR with the drafted files (needs gh auth; default false)'),
        realFly: z.boolean().optional()
          .describe('Deploy for real via flyctl (needs fly auth; default false)'),
        realVpsGhcr: z.object({
          host: z.string().describe('SSH destination: user@host'),
          cwd: z.string().describe('Local path for docker build context'),
          deployRoot: z.string().describe('Base deploy directory on VPS, e.g. /opt/my-app'),
          appName: z.string().describe('App name used in logs and Caddy site file'),
          imageRef: z.string().describe('GHCR image ref without tag, e.g. ghcr.io/myorg/my-app'),
          ghcrUsername: z.string().describe('GitHub username for docker login'),
          ghcrToken: z.string().describe('GitHub token with packages:write (agent) and packages:read (box)'),
          buildArgs: z.record(z.string(), z.string()).optional().describe('Docker --build-arg key=value pairs'),
          composeService: z.string().optional().describe('Compose service name (default: web)'),
          runMigrations: z.boolean().optional().describe('Run Prisma migrate deploy before rolling (default false)'),
          manageCaddy: z.boolean().optional().describe('Write /etc/caddy/sites/<app>.caddy and reload Caddy'),
          domain: z.string().optional().describe('Domain for Caddy site file; required when manageCaddy=true'),
          containerPort: z.number().optional().describe('Container port (default 3000)'),
          healthPath: z.string().optional().describe('Health check path (default /)'),
          bakeWindowSeconds: z.number().optional().describe('Observe bake window in seconds (default 60)'),
          sshPort: z.number().optional().describe('SSH port (default 22)'),
          identityFile: z.string().optional().describe('SSH private key path'),
        }).optional()
          .describe('Deploy via GHCR (build + push locally, docker compose pull+up on VPS). Requires docker + ssh locally.'),
        byok: byokSchema,
      },
    },
    async ({ planId, autoApprove, realRehearsal, realAuthor, realFly, realVpsGhcr, byok }) =>
      guarded(async () => {
        const resolved = resolvePlanId(planId);
        if ('error' in resolved) return fail(resolved.error);
        const fullPlanId = resolved.id;

        return withStore(async (store) => {
          // One apply per plan at a time — same guard the web UI applies.
          const inFlight = store
            .listRunsForPlan(fullPlanId)
            .find((r) => r.status === 'pending' || r.status === 'running' || r.status === 'awaiting_approval' || r.status === 'awaiting_fix');
          if (inFlight) {
            return fail(
              `An apply for plan ${fullPlanId.slice(0, 8)} is already in flight (run ${inFlight.id}, status ${inFlight.status}). Follow it with convoy_status.`,
            );
          }

          // Spawn `convoy apply` exactly like the web UI does: same tsx
          // invocation via the npm script, detached + unref so the pipeline
          // outlives this tool call, stdio captured to a per-plan log.
          const logDir = join(REPO_ROOT, '.convoy');
          mkdirSync(logDir, { recursive: true });
          const logPath = join(logDir, `apply-${fullPlanId.slice(0, 8)}.log`);
          const logFd = openSync(logPath, 'a');

          const args = ['run', 'convoy', '--silent', '--', 'apply', fullPlanId];
          if (autoApprove === true) args.push('--auto-approve');
          // The CLI defaults every real stage ON; Convoy's rule is that real
          // stages are opt-in for agents, so stub each one unless requested.
          if (realAuthor !== true) args.push('--no-real-author');
          if (realRehearsal !== true) args.push('--no-real-rehearsal');
          if (realFly !== true) args.push('--no-real-fly');

          // GHCR VPS config is complex; write to a JSON file and pass the
          // path flag rather than trying to flatten it into CLI flags.
          if (realVpsGhcr !== undefined) {
            const configPath = join(logDir, `ghcr-${fullPlanId.slice(0, 8)}.json`);
            writeFileSync(configPath, JSON.stringify(realVpsGhcr as RealVpsGhcrOpt, null, 2), 'utf8');
            args.push('--real-vps-ghcr', '--real-vps-ghcr-config', configPath);
          }

          // Resolve BYOK key here so Infisical is fetched once on the server,
          // then injected into the child env. The subprocess CLI auto-loads
          // .convoy/byok.json too, so self-hosted teams without byok param
          // are still served.
          const byokKey = byok
            ? await resolveAnthropicKey(byok as ByokConfig)
            : null;

          const child = spawn('npm', args, {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              ...(byokKey ? { ANTHROPIC_API_KEY: byokKey } : {}),
            },
            stdio: ['ignore', logFd, logFd],
            detached: true,
          });
          child.unref();

          // Poll for the orchestrator-created run row so we can hand back a
          // runId. Preflight + the CLI's web-viewer autospawn run first and
          // can take ~10s combined, so the window is generous; we return the
          // moment the row lands.
          const startedAtFloor = Date.now();
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const fresh = store
              .listRunsForPlan(fullPlanId)
              .find((r) => r.startedAt.getTime() >= startedAtFloor - 500);
            if (fresh) {
              return ok({
                runId: fresh.id,
                status: fresh.status,
                watchUrl: watchUrl(fresh.id),
                log: logPath,
                nextStep: 'Poll convoy_status; when status is awaiting_approval, decide the gate with convoy_approve.',
              });
            }
            await sleep(200);
          }

          return fail(
            `Spawned convoy apply for plan ${fullPlanId.slice(0, 8)} but no run row appeared within 30s — preflight likely refused (hard blockers). Check ${logPath} for the CLI output, or convoy_list_runs in case the run started late.`,
          );
        });
      }),
  );

  server.registerTool(
    'convoy_vps_bootstrap',
    {
      description:
        'Install Docker + Caddy on a fresh VPS over SSH (idempotent — safe to re-run). ' +
        'Detects OS (Debian/Ubuntu or RHEL/CentOS/Rocky), installs each tool if absent, ' +
        'creates /etc/caddy/sites/ and patches the Caddyfile, creates the deploy root. ' +
        'Prerequisite: the SSH user must have passwordless sudo. Run once before the first convoy_apply with realVpsGhcr.',
      inputSchema: {
        host: z.string().describe('SSH destination: user@host'),
        deployRoot: z.string().optional()
          .describe('Base deploy directory on the VPS (default: /opt/convoy)'),
        sshPort: z.number().optional().describe('SSH port (default 22)'),
        identityFile: z.string().optional().describe('Path to SSH private key'),
        installDocker: z.boolean().optional().describe('Install Docker if absent (default true)'),
        installCaddy: z.boolean().optional().describe('Install Caddy if absent (default true)'),
      },
    },
    async ({ host, deployRoot, sshPort, identityFile, installDocker, installCaddy }) =>
      guarded(async () => {
        const { sshAvailable } = await import('../adapters/vps/runner.js');
        const { bootstrapVps } = await import('../adapters/vps/bootstrap.js');

        if (!(await sshAvailable())) {
          return fail('ssh is not installed on the Convoy server. Install OpenSSH and try again.');
        }

        const target = {
          host,
          deployRoot: deployRoot ?? '/opt/convoy',
          ...(sshPort !== undefined && { port: sshPort }),
          ...(identityFile !== undefined && { identityFile }),
        };

        const log: string[] = [];
        const report = await bootstrapVps(target, {
          installDocker: installDocker !== false,
          installCaddy: installCaddy !== false,
          onStep: (label, status, detail) => {
            log.push(`[${status}] ${label}${detail ? `: ${detail}` : ''}`);
          },
        });

        if (!report.ok) {
          const failed = report.steps.filter((s) => s.status === 'failed');
          return fail(
            `Bootstrap failed on ${host}.\n` +
            failed.map((s) => `  ${s.label}${s.detail ? `: ${s.detail}` : ''}`).join('\n'),
          );
        }

        return ok({
          host,
          deployRoot: target.deployRoot,
          osFamily: report.osFamily,
          user: report.user,
          steps: report.steps,
          log,
          nextStep: `Bootstrap complete. You can now call convoy_apply with realVpsGhcr.deployRoot="${target.deployRoot}".`,
        });
      }),
  );

  server.registerTool(
    'convoy_connect',
    {
      description:
        'Establish + verify deploy access for a platform BEFORE convoy_apply. Captures only NON-SECRET coordinates (vps host, GHCR image ref, domain, region) and a secret-source POINTER into the committed target (.convoy/preferences.json), records this machine\'s SSH identity locally (~/.convoy/identity.json), and probes that Convoy can actually reach + authenticate to the target. ' +
        'NEVER accepts raw secret values — tokens and private keys stay in env / ssh-agent / your secrets manager. Returns verified=true, or the blockers to clear. Run this before convoy_apply for vps/railway/cloudrun so the pipeline never stops for auth. Note: agents are non-interactive — a vps auth-failed (key not yet trusted) or a cloud not-logged-in needs a human shell (ssh-copy-id / `vercel login`); this tool reports it rather than running it.',
      inputSchema: {
        platform: z.enum(['fly', 'vercel', 'railway', 'cloudrun', 'vps']),
        planId: z.string().optional().describe('Plan id to derive the target repo path from (preferred).'),
        repoPath: z.string().optional().describe('Target repo path, if no planId.'),
        host: z.string().optional().describe('vps: SSH destination user@host (non-secret).'),
        appName: z.string().optional().describe('fly app / cloudrun service / railway service name.'),
        imageRef: z.string().optional().describe('GHCR image ref without tag, e.g. ghcr.io/org/app (non-secret).'),
        domain: z.string().optional(),
        region: z.string().optional(),
        deployRoot: z.string().optional(),
        sshKeyPath: z.string().optional().describe('vps: path to THIS machine\'s SSH private key (a path, never the key itself).'),
        secretSource: z.enum(['platform-native', 'env-file', 'interactive', 'doppler', 'infisical', 'vault', 'aws-sm', 'azure-devops']).optional()
          .describe('Where this project keeps secrets — a pointer, never values.'),
        probe: z.boolean().optional().describe('Reach out to verify access (default true). false = capture coordinates only.'),
      },
    },
    async ({ platform, planId, repoPath, host, appName, imageRef, domain, region, deployRoot, sshKeyPath, secretSource, probe }) =>
      guarded(async () => {
        const { getTarget, upsertTarget, parseSecretSource } = await import('../core/deploy-target.js');
        const { setIdentity } = await import('../core/identity-store.js');
        const { verifyDeployAccess } = await import('../core/verify-access.js');
        const { discoverLocalSshKeys } = await import('../adapters/vps/runner.js');

        let resolvedRepo = repoPath;
        if (!resolvedRepo && planId) {
          const r = resolvePlanId(planId);
          if ('id' in r) resolvedRepo = new PlanStore(PLANS_DIR).load(r.id)?.target.localPath ?? undefined;
        }
        if (!resolvedRepo) resolvedRepo = REPO_ROOT;

        const saved = getTarget(resolvedRepo, platform);
        const isVps = platform === 'vps';
        let identityRef: IdentityRef;
        if (isVps) {
          if (sshKeyPath) identityRef = { kind: 'ssh-key-path', path: sshKeyPath };
          else {
            const keys = discoverLocalSshKeys();
            identityRef = keys.length > 0 ? { kind: 'ssh-key-path', path: keys[0]! } : { kind: 'ssh-agent' };
          }
        } else {
          identityRef = { kind: 'cli-cache' };
        }
        // Host is sensitive — kept machine-local, never written to committed
        // config. `workingHost` is used for the probe; the persisted target omits it.
        const workingHost = host ?? saved?.host;
        const ident = setIdentity(resolvedRepo, platform, identityRef, isVps && workingHost ? { host: workingHost } : {});

        const probeTarget: DeployTarget = {
          platform,
          ...(workingHost ? { host: workingHost } : {}),
          ...(appName ?? saved?.appName ? { appName: appName ?? saved?.appName } : {}),
          ...(imageRef ?? saved?.imageRef ? { imageRef: imageRef ?? saved?.imageRef } : {}),
          ...(domain ?? saved?.domain ? { domain: domain ?? saved?.domain } : {}),
          ...(region ?? saved?.region ? { region: region ?? saved?.region } : {}),
          ...(deployRoot ?? saved?.deployRoot ? { deployRoot: deployRoot ?? saved?.deployRoot } : {}),
          secretSource: parseSecretSource(secretSource, saved?.secretSource ?? (isVps ? { kind: 'env-file' } : { kind: 'platform-native' })),
          verification: { verifiedAt: null, status: 'unverified' },
        };

        const probeRemote = probe !== false;
        const result = await verifyDeployAccess(platform, resolvedRepo, probeTarget, ident, { probeRemote });
        const detail = workingHost ? result.detail.split(workingHost).join('<host>') : result.detail;
        const verification: AccessVerification = result.ok
          ? { verifiedAt: new Date().toISOString(), status: 'verified', ...(result.account ? { account: result.account } : {}), detail }
          : probeRemote
            ? { verifiedAt: null, status: 'failed', detail }
            : { verifiedAt: null, status: 'unverified', detail: 'captured, not probed' };
        // Commit the host-free view — the sensitive host stays machine-local.
        const { host: _omitHost, ...committed } = probeTarget;
        upsertTarget(resolvedRepo, { ...committed, verification });

        return ok({
          platform,
          repoPath: resolvedRepo,
          verified: result.ok,
          detail: result.detail,
          checks: result.checks,
          blockers: result.blockers,
          nextStep: result.ok
            ? `Access verified — call convoy_apply with the real deploy config for ${platform}.`
            : `Clear the blockers above, then re-run convoy_connect. Interactive fixes (ssh-copy-id / platform login) must be run from a human shell.`,
        });
      }),
  );

  server.registerTool(
    'convoy_status',
    {
      description:
        'Get the status and recent timeline of a run. With no runId, returns the most recent run. Shows pending approval gates (decide them with convoy_approve); if status is failed/awaiting_fix, use convoy_diagnose for the root cause.',
      inputSchema: {
        runId: z.string().optional().describe('Run id (or 7+ char prefix); defaults to the most recent run'),
        eventLimit: z.number().int().min(1).max(200).optional().describe('How many recent events to include (default 20)'),
      },
    },
    async ({ runId, eventLimit }) =>
      guarded(() =>
        withStore((store) => {
          const run = runId ? store.getRun(runId) : (store.listRecentRuns(1)[0] ?? null);
          if (!run) {
            return fail(runId ? `Run not found: ${runId}` : 'No runs found. Start one with convoy_apply.');
          }

          const events = store.listEvents(run.id);
          const limit = eventLimit ?? 20;
          const recent = events.slice(-limit);
          const lastEvent = events[events.length - 1];
          const pending = store.listPendingApprovals(run.id);

          return ok({
            runId: run.id,
            status: run.status,
            stage: lastEvent?.stage ?? null,
            planId: run.planId,
            liveUrl: run.liveUrl,
            watchUrl: watchUrl(run.id),
            ...(run.outcomeReason ? { outcomeReason: run.outcomeReason } : {}),
            events: recent.map(eventSummary),
            pendingApprovals: pending.map(approvalSummary),
          });
        }),
      ),
  );

  server.registerTool(
    'convoy_approve',
    {
      description:
        'Approve or reject a pending approval gate on a run (open_pr, merge_pr, promote, stage_secrets). Get the approvalId from convoy_status pendingApprovals. The paused pipeline resumes (or aborts) once the decision lands.',
      inputSchema: {
        runId: z.string().describe('Run id (or 7+ char prefix) the approval belongs to'),
        approvalId: z.string().describe('Approval id from convoy_status pendingApprovals'),
        decision: z.enum(['approved', 'rejected']).describe('The decision to record'),
      },
    },
    async ({ runId, approvalId, decision }) =>
      guarded(() =>
        withStore((store) => {
          const run = store.getRun(runId);
          if (!run) return fail(`Run not found: ${runId}`);

          // Exact id first, then prefix match among this run's pending gates.
          let approval = store.getApproval(approvalId);
          if (!approval) {
            approval = store
              .listPendingApprovals(run.id)
              .find((a) => a.id.startsWith(approvalId)) ?? null;
          }
          if (!approval) return fail(`Approval not found: ${approvalId}`);
          // Bind the decision to the claimed run so a caller holding only an
          // approval UUID can't mutate a gate on an unrelated run.
          if (approval.runId !== run.id) {
            return fail(`Approval ${approval.id} belongs to run ${approval.runId}, not ${run.id}.`);
          }
          if (approval.status !== 'pending') {
            return fail(`Approval ${approval.id} was already ${approval.status}.`);
          }

          const updated = store.decideApproval(approval.id, decision);
          return ok({
            runId: run.id,
            approval: approvalSummary(updated),
            nextStep: 'Poll convoy_status — the pipeline picks the decision up within a few seconds.',
          });
        }),
      ),
  );

  server.registerTool(
    'convoy_diagnose',
    {
      description:
        "Get the medic agent's diagnosis for a failed run: root cause, classification, confidence, suggested fix, plus captured failure logs. With no runId, picks the most recent failed/awaiting_fix/rolled_back run.",
      inputSchema: {
        runId: z.string().optional().describe('Run id (or 7+ char prefix); defaults to the most recent failed run'),
      },
    },
    async ({ runId }) =>
      guarded(() =>
        withStore((store) => {
          const run = runId
            ? store.getRun(runId)
            : (store
                .listRecentRuns(50)
                .find((r) => r.status === 'failed' || r.status === 'awaiting_fix' || r.status === 'rolled_back') ?? null);
          if (!run) {
            return fail(runId ? `Run not found: ${runId}` : 'No failed or awaiting_fix runs found.');
          }

          const events = store.listEvents(run.id);
          const diagnosisEvent = [...events].reverse().find((e) => e.kind === 'diagnosis');
          const failureLogEvent = [...events].reverse().find((e) => {
            if (e.kind !== 'log' || e.stage !== 'rehearse') return false;
            const payload = e.payload as Record<string, unknown> | null;
            return payload?.['phase'] === 'rehearsal.failure_logs';
          });

          if (!diagnosisEvent) {
            const lastFailed = [...events].reverse().find((e) => e.kind === 'failed');
            return ok({
              runId: run.id,
              status: run.status,
              diagnosis: null,
              message: 'No medic diagnosis recorded for this run. Returning the last failure event instead.',
              ...(lastFailed
                ? { lastFailure: { stage: lastFailed.stage, payload: lastFailed.payload } }
                : { lastFailure: null }),
              ...(failureLogEvent ? { failureLog: failureLogEvent.payload } : {}),
            });
          }

          return ok({
            runId: run.id,
            status: run.status,
            stage: diagnosisEvent.stage,
            diagnosis: diagnosisEvent.payload,
            ...(failureLogEvent ? { failureLog: failureLogEvent.payload } : {}),
            watchUrl: watchUrl(run.id),
          });
        }),
      ),
  );

  server.registerTool(
    'convoy_list_runs',
    {
      description: 'List recent runs (newest first) with status, platform, and live URL. Use a runId with convoy_status or convoy_diagnose.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max runs to return (default 10)'),
      },
    },
    async ({ limit }) =>
      guarded(() =>
        withStore((store) => ok(store.listRecentRuns(limit ?? 10).map(runSummary))),
      ),
  );

  server.registerTool(
    'convoy_orient',
    {
      description: 'Discover what platforms, CI/CD, secrets, and observability a repo already uses. Run this before convoy_plan on an unfamiliar repo.',
      inputSchema: {
        path: z.string().describe('Absolute path to the repo root'),
        live: z.boolean().optional().describe('Probe live platform APIs (requires auth)'),
      },
    },
    async ({ path: localPath }) =>
      guarded(async () => {
        const { orientRepo } = await import('../orient/index.js');
        try {
          const result = await orientRepo(localPath);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text' as const, text: `orient failed: ${msg}` }], isError: true };
        }
      }),
  );

  server.registerTool(
    'convoy_onboard',
    {
      description: 'Capture team deployment preferences for a repo. Call before convoy_plan on a new project. Results persist to .convoy/preferences.json.',
      inputSchema: {
        path: z.string().describe('Absolute path to the repo root'),
        answers: z.object({
          mode: z.enum(['first', 'update']).optional(),
          approvers: z.array(z.string()).optional(),
          canaryStrategy: z.enum(['skip', 'canary', 'bluegreen']).optional(),
          bakeWindowSeconds: z.number().optional(),
          autoRollback: z.boolean().optional(),
          platformMandate: z.string().nullable().optional(),
          budgetTier: z.enum(['hobby', 'startup', 'growth', 'unconstrained']).optional(),
          releaseCadence: z.enum(['many-per-day', 'daily', 'weekly', 'infrequent']).optional(),
          releaseGate: z.enum(['pr-merged', 'pr-staging', 'pr-staging-approver', 'change-ticket']).optional(),
          secretsManager: z.string().optional(),
          compliance: z.array(z.enum(['soc2', 'hipaa', 'pci', 'gdpr'])).optional(),
          dataResidency: z.string().optional(),
          errorTracking: z.string().nullable().optional(),
          prComments: z.boolean().optional(),
        }).optional().describe('Pre-filled answers (from conversational collection). Omit fields to use defaults.'),
      },
    },
    async ({ path: localPath, answers }) =>
      guarded(async () => {
        const { runOnboard } = await import('../onboard/index.js');
        try {
          const prefs = await runOnboard(localPath, answers ?? {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(prefs, null, 2) }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text' as const, text: `onboard failed: ${msg}` }], isError: true };
        }
      }),
  );
}

export function createConvoyServer(): McpServer {
  const server = new McpServer({
    name: 'convoy',
    version: '0.0.1',
  });
  registerConvoyTools(server);
  return server;
}
