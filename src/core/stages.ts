import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  flyAppExists,
  flyAuthStatus,
  flyCreateApp,
  flyctlAvailable,
  flyDeploy,
  flyHealthCheck,
  flyListReleases,
  flyRollback,
  flySetSecrets,
} from '../adapters/fly/runner.js';
import {
  vercelDeploy,
  vercelHealthCheck,
  vercelListDeployments,
  vercelRollback,
} from '../adapters/vercel/runner.js';
import { probePlatformConnection } from '../adapters/connections.js';
import {
  ensureDeployRoot,
  executeDeploy,
  probeRemote,
  readActiveSlot,
  rollbackSlot,
  rsyncAvailable,
  rsyncSource,
  sshAvailable,
  swapNginxUpstream,
  writeActiveSlot,
} from '../adapters/vps/runner.js';
import {
  buildAndPushGhcr,
  caddyAvailable,
  composeDeployViaGhcr,
  dockerAvailable,
  ensureCaddyImport,
  ghcrLogin,
  httpProbe,
  readCurrentComposeImage,
  reloadCaddy,
  rollbackComposeImage,
  writeCaddySiteFile,
  type GhcrDeployTarget,
} from '../adapters/vps/ghcr-runner.js';
import type { ConvoyBus } from './bus.js';
import {
  createPrFromAuthoredFiles,
  detectRepo,
  findExistingConvoyPr,
  gitHubAuthStatus,
  mergePr,
  planBranchName,
  plumbingMatchesDefaultBranch,
  prStatus,
  type GitRepoContext,
  type RepoSourceSnapshot,
} from './github-runner.js';
import { diagnose, type DiagnoseOptions } from './medic.js';
import { aggregateAuthoredFiles, normalizePlan, primaryLane, topoSortLanes, type ConvoyPlan, type DeploymentLane } from './plan.js';
import { RehearsalRunner, type MetricsSnapshot } from './rehearsal-runner.js';
import { pickPlatform } from '../planner/picker.js';
import { scanRepository, type ScanResult } from '../planner/scanner.js';
import type { RunStateStore } from './state.js';
import type {
  Approval,
  ApprovalKind,
  EventKind,
  Platform,
  Run,
  RunEvent,
  StageName,
} from './types.js';

export interface OrchestratorOpts {
  dryRun: boolean;
  platformOverride?: Platform;
  autoApprove?: boolean;
  injectFailure?: InjectFailureOpt;
  planId?: string | null;
  /**
   * Keys the operator self-declared via --already-set (or wrote to
   * .env.convoy-already-set) at apply time. CanaryStage's secrets gate
   * uses this to skip the approval pause for keys the operator vouched
   * for. The CLI computes the set in preflight and threads it through
   * here so CanaryStage doesn't need access to ApplyOpts.
   */
  alreadySetKeys?: string[];
  /**
   * When set, the orchestrator continues an existing run row instead of
   * creating a new one. Stages whose last event in this run is `finished`
   * are skipped and their prior payload is replayed into the context. The
   * first stage with a `failed`/incomplete history runs from scratch, and
   * everything after it follows normally. This is what `convoy resume`
   * threads through after the developer fixes a code-level failure.
   */
  continueRunId?: string;
  /**
   * Full plan handed to the stage context so ScanStage can re-run the live
   * scan on plan.target.localPath and PickStage can replay the authoritative
   * pickPlatform decision. Without this, those two stages have no evidence to
   * render — they used to emit hardcoded signals regardless of the repo.
   */
  plan?: ConvoyPlan;
  realRehearsal?: RealRehearsalOpt;
  realAuthor?: RealAuthorOpt;
  realFly?: RealFlyOpt;
  realVercel?: RealVercelOpt;
  realVps?: RealVpsOpt;
  realVpsGhcr?: RealVpsGhcrOpt;
  realRailway?: RealRailwayOpt;
  realCloudRun?: RealCloudRunOpt;
  /**
   * Resolved Anthropic API key for this run. Passed to the medic agent and
   * enricher so hosted Convoy can inject a team's BYOK key without touching
   * the server process's own ANTHROPIC_API_KEY env var.
   */
  apiKey?: string;
}

/**
 * VPS deploy configuration — what CanaryStage needs to ship a release to a
 * box over SSH. Cheaper than --real-fly to set up: no platform account, no
 * CLI install, just SSH access and a deploy root the operator owns.
 *
 * The runner (src/adapters/vps/runner.ts) does the actual rsync + docker
 * build + slot swap; this struct is the contract the CLI hands the
 * orchestrator. healthPath / bakeWindowSeconds match the Fly/Vercel shape
 * so observe-stage code can be shared.
 */
export interface RealVpsOpt {
  host: string;
  cwd: string;
  deployRoot: string;
  sshPort?: number;
  identityFile?: string;
  appName: string;
  manageNginx?: boolean;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

/**
 * GHCR-based VPS deploy configuration.
 *
 * Mirrors the ship-to-vps pattern: build the Docker image on the Convoy agent
 * machine, push to GHCR, then SSH to the box and let Docker pull the exact
 * SHA-tagged image and roll the compose service. No rsync, no build on box.
 *
 * Prefer this over --real-vps when the box is underpowered for Docker builds,
 * when the deploy must match a GitHub Actions workflow exactly, or when Caddy
 * is the reverse proxy (rather than nginx).
 */
export interface RealVpsGhcrOpt {
  /** SSH destination — `user@host` or `host`. */
  host: string;
  /** Local path for `docker buildx build` context. */
  cwd: string;
  /** Base deploy directory on the box, e.g. `/opt/my-app`. */
  deployRoot: string;
  /** SSH port. Default 22. */
  sshPort?: number;
  /** SSH identity file. */
  identityFile?: string;
  /** App name used in log messages and Caddy site file naming. */
  appName: string;
  /** GHCR image ref, e.g. `ghcr.io/myorg/my-app`. No tag — we append one. */
  imageRef: string;
  /** GitHub username for docker login on both sides. */
  ghcrUsername: string;
  /** GitHub token with packages:write (agent side) and packages:read (box side). */
  ghcrToken: string;
  /** Docker build args. */
  buildArgs?: Record<string, string>;
  /** Compose service name. Default: `web`. */
  composeService?: string;
  /** Run Prisma migrations container before rolling the service. Default false. */
  runMigrations?: boolean;
  /** Docker network for the migrations one-shot container. Default: appName. */
  migrationNetwork?: string;
  /** Write /etc/caddy/sites/<appName>.caddy and reload Caddy. Default false. */
  manageCaddy?: boolean;
  /** Domain for the Caddy site file. Required when manageCaddy=true. */
  domain?: string;
  /** Port the container serves on. Default 3000. Used in Caddy config. */
  containerPort?: number;
  /** Health check path. Default: `/`. */
  healthPath?: string;
  /** Bake window in seconds. Default 60. */
  bakeWindowSeconds?: number;
  /** Error rate threshold %. Default 5. */
  thresholdErrorRatePct?: number;
  /** P99 latency threshold ms. Default 1500. */
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealRailwayOpt {
  cwd: string;
  projectId?: string;
  secrets?: Record<string, string>;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealCloudRunOpt {
  cwd: string;
  service: string;
  image: string;
  region?: string;
  project?: string;
  secrets?: Record<string, string>;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealAuthorOpt {
  repoPath: string;
  authoredFiles: { path: string; contentPreview: string; summary?: string }[];
  prTitle: string;
  prBody: string;
  mergeOnApproval: boolean;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  /**
   * Snapshot of the exact local git HEAD that rehearsal validated. Author
   * must branch from this commit, not blindly from origin/<default>, or a
   * feature branch's committed-but-unpushed work disappears between rehearse
   * and deploy.
   */
  sourceSnapshot?: RepoSourceSnapshot;
  /**
   * Operator-authored uncommitted changes captured at preflight. When set,
   * AuthorStage carries these onto the plan-keyed branch as a separate
   * `fix:`-prefixed commit BEFORE writing its plumbing files, so a fix
   * that triggered the resume rides into production through the same PR
   * Convoy is opening — not via a separate `git push origin main` that
   * would trip git-deploy platforms (Vercel, Netlify, Cloud Run) into
   * shipping unproven code.
   *
   * `messageDefault` is the auto-generated commit subject Convoy will use
   * (e.g. "fix: <medic root cause>"). Operator can override later via
   * git rebase if they care; for the demo flow the default is fine.
   */
  carryUncommittedChanges?: {
    files: string[];
    messageDefault: string;
  };
}

export interface RealFlyOpt {
  appName: string;
  cwd: string;
  org?: string;
  createIfMissing?: boolean;
  strategy?: 'canary' | 'rolling' | 'bluegreen' | 'immediate';
  secrets?: Record<string, string>;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealVercelOpt {
  cwd: string;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealRehearsalOpt {
  /**
   * Repo root — where the lockfile lives. `pnpm install` / `npm ci` runs here.
   * Also used as repoPath for diagnosis context.
   */
  repoPath: string;
  /**
   * Where build and start commands run. Defaults to repoPath when absent.
   * For monorepo workspaces (e.g. `apps/web`) this is the subdir so
   * node_modules/.bin resolves framework binaries (next, vite, tsx, etc.).
   */
  serviceCwd?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  port: number;
  healthPath: string;
  metricsPath?: string;
  env?: Record<string, string>;
  probeRequests?: number;
  probeConcurrency?: number;
  probePaths?: string[];
  maxErrorRatePct?: number;
  maxP99Ms?: number;
  convoyAuthoredFiles?: string[];
  /**
   * When true, the rehearsal subprocess inherits the parent env (ANTHROPIC_API_KEY,
   * GH_TOKEN, AWS_*, etc.). Default false — scrubbed to a small allowlist so
   * cloned third-party repos can't exfiltrate operator credentials via their
   * install/start scripts. The CLI surfaces this as --trust-repo.
   */
  inheritAmbientEnv?: boolean;
}

export type InjectFailureOpt = {
  stage: 'rehearse' | 'canary';
  kind: 'latency' | 'error-rate' | 'build';
  /** 'concurrency' — serialised-renderer bottleneck (0% errors, catastrophic p99) */
  scenario?: 'concurrency';
  logsPath?: string;
  repoPath?: string;
  convoyAuthoredFiles?: string[];
};

export interface StageContext {
  run: Run;
  store: RunStateStore;
  bus: ConvoyBus;
  opts: OrchestratorOpts;
  prior: Record<string, unknown>;
  signal: AbortSignal;
}

export interface Stage {
  readonly name: StageName;
  run(ctx: StageContext): Promise<unknown>;
}

export class ApprovalRejectedError extends Error {
  constructor(readonly kind: ApprovalKind) {
    super(`Approval rejected: ${kind}`);
    this.name = 'ApprovalRejectedError';
  }
}

/**
 * Thrown by triggerRealFlyRollback after it has already set the run to
 * rolled_back. The orchestrator catches this specifically so it does NOT
 * overwrite the status back to 'failed' in its generic error path.
 */
export class RollbackTriggeredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly firedBy: 'promote' | 'observe',
    public readonly restoredVersion?: number,
  ) {
    super(`${firedBy} breach (${reason}) triggered rollback`);
    this.name = 'RollbackTriggeredError';
  }
}

/**
 * Reduce the rehearsal stage's finished-payload to the fields the operator
 * needs to decide whether to open a PR. Tolerates both scripted and real
 * modes, and handles the case where rehearsal didn't run or produced no
 * snapshot. Returns null when there's nothing to show — the approval card
 * then renders "no rehearsal evidence" instead of a half-populated object.
 */
function summarizeRehearsalForApproval(prior: unknown): Record<string, unknown> | null {
  if (!prior || typeof prior !== 'object') return null;
  const p = prior as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof p['mode'] === 'string') summary['mode'] = p['mode'];
  else summary['mode'] = 'real-local';
  if (typeof p['healthy'] === 'boolean') summary['healthy'] = p['healthy'];
  if (typeof p['duration_ms'] === 'number') summary['duration_ms'] = p['duration_ms'];
  if (typeof p['p99_ms'] === 'number') summary['p99_ms'] = p['p99_ms'];
  if (typeof p['smoke_tests_passed'] === 'number') summary['smoke_tests_passed'] = p['smoke_tests_passed'];
  if (typeof p['log_lines'] === 'number') summary['log_lines'] = p['log_lines'];
  if (p['metricsAfter'] && typeof p['metricsAfter'] === 'object') summary['metrics'] = p['metricsAfter'];
  else if (p['metricsBefore'] && typeof p['metricsBefore'] === 'object') summary['metrics'] = p['metricsBefore'];
  return Object.keys(summary).length > 0 ? summary : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

abstract class BaseStage implements Stage {
  abstract readonly name: StageName;
  abstract run(ctx: StageContext): Promise<unknown>;

  protected emit(ctx: StageContext, kind: EventKind, payload: unknown, laneId?: string | null): RunEvent {
    const event = ctx.store.appendEvent(ctx.run.id, this.name, kind, payload, laneId);
    ctx.bus.emit({ type: 'event.appended', event });
    return event;
  }

  protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleep(ms, signal);
  }

  /**
   * Streams each tool call the medic agent makes as a `medic.tool_use`
   * progress event so the CLI + web UI can replay "I read src/orders.ts
   * lines 40-80, then grepped for 'orderTotal'" live, instead of only
   * seeing the final diagnosis card.
   */
  protected medicTelemetry(ctx: StageContext): DiagnoseOptions {
    return {
      ...(ctx.opts.apiKey !== undefined && { apiKey: ctx.opts.apiKey }),
      onToolCall: (call) => {
        this.emit(ctx, 'progress', {
          phase: 'medic.tool_use',
          tool: call.name,
          input: call.input,
        });
      },
    };
  }

  protected async awaitApproval(
    ctx: StageContext,
    kind: ApprovalKind,
    summary: unknown,
    laneId?: string | null,
  ): Promise<Approval> {
    const approval = ctx.store.requestApproval(ctx.run.id, kind, summary, laneId);
    ctx.bus.emit({ type: 'approval.requested', approval });
    this.emit(ctx, 'progress', { awaiting_approval: kind, approval_id: approval.id }, laneId);

    // Default: pause at every approval gate (opt-out via --auto-approve / -y).
    // The previous default (auto-approve ON) contradicted the README's "humans
    // decide" story and was flagged by pre-demo adversarial review.
    const autoApprove = ctx.opts.autoApprove === true;
    if (autoApprove) {
      await this.sleep(400, ctx.signal);
      const decided = ctx.store.decideApproval(approval.id, 'approved');
      ctx.bus.emit({ type: 'approval.decided', approval: decided });
      return decided;
    }

    // Trust-based auto-approval (fires at level 1+ when compliance doesn't require manual)
    {
      const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : null;
      const repoPath = plan?.repo.localPath ?? null;
      if (repoPath) {
        const { readRunHistory, computeTrustLevel, shouldAutoApprove } = await import('./run-history.js');
        const { loadPreferences } = await import('../onboard/preferences.js');
        const serviceName = plan?.target.name ?? 'default';
        const history = readRunHistory(repoPath);
        const trust = computeTrustLevel(history, serviceName);
        const prefs = loadPreferences(repoPath);
        const hasCompliance = (prefs?.secrets.compliance.length ?? 0) > 0;
        const rehearsalPrior = ctx.prior['rehearse'];
        const rehearsalClean = rehearsalPrior && typeof rehearsalPrior === 'object'
          ? (rehearsalPrior as Record<string, unknown>)['healthy'] === true
          : false;

        if (shouldAutoApprove(trust, kind, rehearsalClean, hasCompliance)) {
          this.emit(ctx, 'progress', {
            phase: 'trust.action',
            action: `auto-approved ${kind}`,
            trust_level: trust.level,
            total_successful_deploys: trust.totalSuccessful,
            rehearsal_clean: rehearsalClean,
          });
          await this.sleep(400, ctx.signal);
          const decided = ctx.store.decideApproval(approval.id, 'approved');
          ctx.bus.emit({ type: 'approval.decided', approval: decided });
          return decided;
        }
      }
    }

    // No timeout — operator drives from the web UI on their own schedule.
    // Abort via Ctrl+C or killing the process if the run is no longer wanted.
    while (true) {
      if (ctx.signal.aborted) throw new Error('aborted');
      await this.sleep(400);
      const current = ctx.store.getApproval(approval.id);
      if (!current) throw new Error(`Approval ${approval.id} missing`);
      if (current.status !== 'pending') {
        ctx.bus.emit({ type: 'approval.decided', approval: current });
        if (current.status === 'rejected') {
          throw new ApprovalRejectedError(kind);
        }
        return current;
      }
    }
  }

  protected lanes(ctx: StageContext): DeploymentLane[] {
    const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : null;
    return plan?.lanes ?? [];
  }
}

const FAILURE_LOG_TAIL_LINE_LIMIT = 120;
const FAILURE_LOG_TAIL_CHAR_LIMIT = 12_000;

function buildFailureLogPayload(logs: string[], reason: string): {
  phase: 'rehearsal.failure_logs';
  reason: string;
  excerpt: string;
  totalLines: number;
  excerptLines: number;
  truncated: boolean;
} {
  const tail = logs.slice(-FAILURE_LOG_TAIL_LINE_LIMIT);
  let excerpt = tail.join('\n').trim();
  let truncated = logs.length > tail.length;
  if (excerpt.length > FAILURE_LOG_TAIL_CHAR_LIMIT) {
    excerpt = excerpt.slice(excerpt.length - FAILURE_LOG_TAIL_CHAR_LIMIT).trimStart();
    truncated = true;
  }
  return {
    phase: 'rehearsal.failure_logs',
    reason,
    excerpt,
    totalLines: logs.length,
    excerptLines: tail.length,
    truncated,
  };
}

export class ScanStage extends BaseStage {
  readonly name = 'scan' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', { repo_url: ctx.run.repoUrl });

    const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : undefined;
    if (plan) {
      try {
        const laneScans: Record<string, ScanResult | null> = {};
        for (const lane of plan.lanes) {
          const scanOpts = lane.servicePath === '.' ? {} : { workspace: lane.servicePath };
          const scan = scanRepository(plan.repo.localPath, scanOpts);
          laneScans[lane.id] = scan;
          const signals = {
            language: scan.language ?? scan.ecosystem,
            runtime: scan.runtime,
            framework: scan.framework,
            topology: scan.topology,
            data: scan.dataLayer,
            hints: {
              has_dockerfile: scan.hasDockerfile,
              has_ci: scan.hasCi,
              package_manager: scan.packageManager,
              monorepo: scan.isMonorepo ? scan.monorepoTool : null,
              existing_platform: scan.existingPlatform,
            },
            evidence: scan.evidence.slice(0, 6),
          };
          this.emit(ctx, 'finished', { signals }, lane.id);
        }
        return laneScans;
      } catch (err) {
        // Target directory may have moved since the plan was saved. Fall back
        // to the plan's recorded target metadata rather than emitting fiction.
        const message = err instanceof Error ? err.message : String(err);
        this.emit(ctx, 'progress', {
          note: `live scan unavailable: ${message}`,
          fallback: 'plan.target',
        });
        const laneScans: Record<string, ScanResult | null> = {};
        for (const lane of plan.lanes) {
          const signals = {
            language: lane.scan.ecosystem,
            runtime: null,
            framework: lane.scan.framework,
            topology: lane.scan.topology,
            data: lane.scan.dataLayer,
            hints: { source: 'plan-record' as const },
          };
          this.emit(ctx, 'finished', { signals }, lane.id);
          laneScans[lane.id] = null;
        }
        return laneScans;
      }
    }

    // No plan attached — shouldn't happen on the apply path, but keep a
    // minimal emission so downstream stages don't crash.
    this.emit(ctx, 'progress', { note: 'no plan attached to run; scan skipped' });
    this.emit(ctx, 'finished', { signals: null });
    return null;
  }
}

export class PickStage extends BaseStage {
  readonly name = 'pick' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', {});

    const scans = (ctx.prior['scan'] as Record<string, ScanResult | null> | undefined) ?? {};
    const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : undefined;

    // Prefer re-running pickPlatform against the live scan (that's the
    // honest "we just scored four platforms" demo). Fall back to the plan's
    // recorded decision if live scan failed. Last resort: platformOverride.
    const decisions: Record<string, unknown> = {};
    let platformSummary: Platform | 'multi' | null = null;
    if (plan) {
      for (const lane of plan.lanes) {
        const scan = scans[lane.id] ?? null;
        let decision;
        if (scan) {
          decision = pickPlatform(scan, ctx.opts.platformOverride);
          if (decision.chosen !== lane.platformDecision.chosen) {
            this.emit(ctx, 'progress', {
              note: 'live pick diverged from plan',
              plan_chose: lane.platformDecision.chosen,
              live_chose: decision.chosen,
            }, lane.id);
          }
        } else {
          decision = lane.platformDecision;
        }
        decisions[lane.id] = decision;
        this.emit(ctx, 'decision', decision, lane.id);
        this.emit(ctx, 'finished', decision, lane.id);
      }
      const chosen = [...new Set(plan.lanes.map((lane) => lane.platformDecision.chosen))];
      platformSummary = chosen.length === 1 ? chosen[0]! : 'multi';
    } else {
      const chosen: Platform = ctx.opts.platformOverride ?? 'fly';
      const decision = {
        chosen,
        reason: `fallback: ${chosen}`,
        source: 'override' as const,
        candidates: [],
      };
      decisions['default'] = decision;
      this.emit(ctx, 'decision', decision);
      this.emit(ctx, 'finished', decision);
      platformSummary = chosen;
    }

    ctx.store.updateRun(ctx.run.id, { platform: platformSummary });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
    return decisions;
  }
}

export class AuthorStage extends BaseStage {
  readonly name = 'author' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realAuthor) {
      return this.#runReal(ctx, ctx.opts.realAuthor);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });
    await this.sleep(1200, ctx.signal);

    // Pull the real authored-file list from the plan so the approval card
    // shows the same evidence the real-author path would: path, line count,
    // summary, and content preview. Previously scripted mode emitted a fake
    // pr_url and a bare string[] of filenames, leaving the operator to
    // approve blind.
    const plan = ctx.opts.plan;
    const files = plan
      ? plan.author.convoyAuthoredFiles.map((f) => ({
          path: f.path,
          lines: f.lines,
          summary: f.summary,
          contentPreview: f.contentPreview,
        }))
      : [
          { path: 'Dockerfile', lines: 0, summary: '(no plan attached)', contentPreview: '' },
        ];

    this.emit(ctx, 'progress', {
      phase: 'files_drafted',
      mode: 'scripted',
      files: files.map((f) => f.path),
      file_count: files.length,
    });

    // Scripted mode never opens a real PR, but the approval card still
    // shows what rehearsal produced + the file set — so the demo narrative
    // matches the real flow: operator sees rehearsal evidence, then says
    // "open it."
    await this.awaitApproval(ctx, 'open_pr', {
      mode: 'scripted',
      note: 'Scripted pipeline — no real PR will be opened. These are the files Convoy would commit after rehearsal.',
      rehearsal: summarizeRehearsalForApproval(ctx.prior['rehearse']),
      files,
    });

    const result = {
      mode: 'scripted' as const,
      files: files.map((f) => f.path),
      merged: true,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runReal(ctx: StageContext, cfg: RealAuthorOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-github', repo_path: cfg.repoPath });

    const repo = await detectRepo(cfg.repoPath);
    if (!repo) {
      throw new Error(
        `real-author requires ${cfg.repoPath} to be a git repo with a github.com remote. ` +
          `Found no .git directory there or no parseable GitHub origin.`,
      );
    }

    this.emit(ctx, 'progress', {
      phase: 'git.detected',
      owner: repo.owner,
      repo: repo.repo,
      default_branch: repo.defaultBranch,
    });

    const auth = await gitHubAuthStatus();
    if (!auth.ok) {
      throw new Error(
        `gh is not authenticated (${auth.error ?? 'unknown'}). Run: gh auth login`,
      );
    }
    this.emit(ctx, 'progress', { phase: 'gh.authenticated', user: auth.user, scopes: auth.scopes });

    // Plan-keyed branch name — stable across resumes. With this, a fix-and-
    // resume after a failed merge force-pushes the same branch and reuses
    // the same PR instead of opening a duplicate. Falls back to run id only
    // when no plan is in context (legacy callers / programmer error).
    const planId = ctx.opts.plan?.id ?? ctx.run.id;
    const branch = planBranchName(planId);

    // Probe BEFORE the open_pr approval. If a PR for this branch was already
    // merged in a prior attempt, AuthorStage has nothing to do and we should
    // tell the operator that — not pause for an approval gate they don't
    // need. If a PR is already open, the approval card surfaces "reuse" so
    // the operator isn't surprised when no new PR appears on GitHub.
    const existing = await findExistingConvoyPr(repo, branch);
    if (existing && existing.state === 'merged') {
      this.emit(ctx, 'progress', {
        phase: 'pr.already_merged',
        pr_url: existing.prUrl,
        pr_number: existing.prNumber,
        branch,
        note: 'A prior attempt of this plan already opened and merged a PR. Skipping author.',
      });
      const result = {
        pr_url: existing.prUrl,
        pr_number: existing.prNumber,
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'merged' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    // Symmetric to pr.already_merged but for the case where the plumbing
    // landed on origin/<default> via a different code path (a hand-merged
    // PR, a run on a legacy run-id-keyed branch, or a developer who copied
    // the files manually). findExistingConvoyPr can't see it because no
    // *open* convoy/<branch> PR exists, but the files ARE already shipped.
    // Without this check, AuthorStage would branch off origin/<default>,
    // write identical content, and crash on `git commit` with "nothing to
    // commit". With it, we recognize the no-op cleanly — but only when no
    // operator carry is needed; if the working tree is dirty we still need
    // to author so the carry commit rides into a PR.
    const plumbingShipped = await plumbingMatchesDefaultBranch(
      repo,
      cfg.authoredFiles.map((f) => ({ path: f.path, contentPreview: f.contentPreview })),
    );
    const willCarry = cfg.carryUncommittedChanges !== undefined;
    const sourceDiffersFromDefault = cfg.sourceSnapshot !== undefined;
    if (plumbingShipped && !willCarry && !existing && !sourceDiffersFromDefault) {
      this.emit(ctx, 'progress', {
        phase: 'pr.already_shipped',
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        default_branch: repo.defaultBranch,
        note: `Plumbing files already match origin/${repo.defaultBranch}. A prior PR (or a hand-merge) shipped them. Skipping author.`,
      });
      const result = {
        pr_url: null,
        pr_number: null,
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'already_on_default' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    // Pre-PR gate: before any git mutation, show the operator what rehearsal
    // produced + the authored file set, and wait for approval to open (or
    // reuse) the PR. This is the "rehearsal must pass AND operator must
    // confirm before PR opens" gate.
    const authoredForApproval = cfg.authoredFiles.map((f) => ({
      path: f.path,
      lines: f.contentPreview.split(/\r?\n/).length,
      summary: f.summary ?? '',
      contentPreview: f.contentPreview,
    }));

    // The carry block is the operator's uncommitted fix that Convoy will
    // commit onto its branch BEFORE writing plumbing. We surface the file
    // list + the planned commit subject in the approval card so the
    // operator sees the combined picture (their fix + Convoy's plumbing)
    // before clicking approve. They can reject if the dirty list looks
    // wrong (stray editor file, accidentally-staged secret, etc.) and
    // clean it up before the next resume.
    const carryForApproval = cfg.carryUncommittedChanges
      ? {
          files: cfg.carryUncommittedChanges.files,
          file_count: cfg.carryUncommittedChanges.files.length,
          commit_subject: cfg.carryUncommittedChanges.messageDefault,
          note:
            'These uncommitted files will be committed to the convoy branch as a separate `fix:` commit before Convoy writes its plumbing. Main stays untouched until you approve the merge.',
        }
      : undefined;
    const sourceForApproval = cfg.sourceSnapshot
      ? {
          branch: cfg.sourceSnapshot.branchName ?? null,
          head_sha: cfg.sourceSnapshot.headSha,
          note:
            'Convoy will branch from this local HEAD so the PR and deploy use the same code revision rehearsal validated.',
        }
      : undefined;

    const baseNote = existing?.state === 'open'
      ? `Rehearsal passed. A PR for this plan is already open at ${existing.prUrl}; Convoy will force-push the latest authored files to its branch and reuse it.`
      : 'Rehearsal passed. Convoy will open a PR from the rehearsed local snapshot and add these deployment-surface files.';
    const sourceNote = sourceForApproval
      ? ` The branch base is local HEAD ${sourceForApproval.head_sha.slice(0, 7)}${sourceForApproval.branch ? ` from \`${sourceForApproval.branch}\`` : ''}, so committed feature work from that snapshot stays in the run.`
      : '';
    const carryNote = carryForApproval
      ? ` In addition, Convoy is carrying ${carryForApproval.file_count} operator-authored file${carryForApproval.file_count === 1 ? '' : 's'} from your working tree as a separate \`fix:\` commit on the same branch — no push to ${repo.defaultBranch} is needed for those changes to deploy.`
      : '';

    await this.awaitApproval(ctx, 'open_pr', {
      mode: 'real',
      repo: `${repo.owner}/${repo.repo}`,
      default_branch: repo.defaultBranch,
      branch_to_create: branch,
      reuse_pr_url: existing?.state === 'open' ? existing.prUrl : undefined,
      note: `${baseNote}${sourceNote}${carryNote}`,
      rehearsal: summarizeRehearsalForApproval(ctx.prior['rehearse']),
      files: authoredForApproval,
      source: sourceForApproval,
      carry: carryForApproval,
    });

    let pr;
    try {
      pr = await createPrFromAuthoredFiles(
        repo,
        branch,
        cfg.authoredFiles.map((f) => ({ path: f.path, contentPreview: f.contentPreview })),
        cfg.prTitle,
        cfg.prBody,
        existing?.state === 'open' ? existing.prUrl : undefined,
        cfg.carryUncommittedChanges
          ? {
              files: cfg.carryUncommittedChanges.files,
              message: cfg.carryUncommittedChanges.messageDefault,
            }
          : undefined,
        cfg.sourceSnapshot,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PR creation failed: ${message}`);
    }

    // No-op signal from createPrFromAuthoredFiles: plumbing already matched
    // origin/<default> AND the carry's diff was empty (or no carry was
    // instructed). Possible if the operator's "dirty tree" was entirely
    // gitignored content (.vscode/, .env*.local, etc.), or if the
    // plumbingMatchesDefaultBranch pre-check missed the case for any
    // reason. Either way: nothing to push, nothing to PR, stage is a no-op.
    if (pr.noOp) {
      this.emit(ctx, 'progress', {
        phase: 'pr.no_op',
        branch: pr.branch,
        files: cfg.authoredFiles.map((f) => f.path),
        note:
          'Plumbing already on origin/<default> and no operator changes had a non-empty diff. Skipping PR; advancing to deploy.',
      });
      const result = {
        pr_url: null,
        pr_number: null,
        branch: pr.branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'no_op' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    if (cfg.carryUncommittedChanges) {
      this.emit(ctx, 'progress', {
        phase: 'pr.carry_committed',
        files: cfg.carryUncommittedChanges.files,
        commit_subject: cfg.carryUncommittedChanges.messageDefault,
        note: 'operator-authored fix committed to convoy branch alongside the deploy plumbing',
      });
    }

    this.emit(ctx, 'progress', {
      phase: 'pr.opened',
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
    });

    await this.awaitApproval(ctx, 'merge_pr', {
      mode: 'real',
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      rehearsal: summarizeRehearsalForApproval(ctx.prior['rehearse']),
      note: sourceForApproval
        ? `This PR is based on local HEAD ${sourceForApproval.head_sha.slice(0, 7)}${sourceForApproval.branch ? ` from \`${sourceForApproval.branch}\`` : ''}. Review the full GitHub diff, including any operator-authored application commits from that snapshot, then approve to merge.`
        : 'Review the full GitHub diff and approve to merge.',
      // Full file shape so the approval card can render the same content
      // preview the plan page shows. Operator should never approve blind.
      files: authoredForApproval,
      source: sourceForApproval,
    });

    if (cfg.mergeOnApproval) {
      this.emit(ctx, 'progress', { phase: 'pr.merging' });
      const merge = await mergePr(pr.prUrl, { method: cfg.mergeMethod ?? 'squash' });
      if (!merge.ok) {
        throw new Error(`PR merge failed: ${merge.error ?? 'unknown'}`);
      }
      this.emit(ctx, 'progress', { phase: 'pr.merged' });
    } else {
      // User opted out of auto-merge — poll indefinitely until someone merges
      // or closes the PR. No timeout; they drive on their own schedule.
      while (true) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const status = await prStatus(pr.prUrl);
        if (status === 'merged') break;
        if (status === 'closed') throw new Error('PR was closed without merging');
        await this.sleep(5000);
      }
    }

    const result = {
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
      merged: true,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }
}

export class RehearseStage extends BaseStage {
  readonly name = 'rehearse' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : undefined;
    if (ctx.opts.realRehearsal) {
      return this.#runReal(ctx, ctx.opts.realRehearsal);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });
    const lanes = plan?.lanes ?? [];
    const outputs: Record<string, unknown> = {};
    const targetLanes = lanes.length > 0 ? lanes : [{ id: 'default', servicePath: '.', role: 'backend', platformDecision: { chosen: 'fly' } }] as Array<Record<string, any>>;
    for (const lane of targetLanes) {
      this.emit(ctx, 'progress', { phase: 'ephemeral.creating', mode: 'scripted', service_path: lane.servicePath }, lane.id);
      await this.sleep(300, ctx.signal);
      this.emit(ctx, 'progress', { phase: 'ephemeral.ready', mode: 'scripted' }, lane.id);
      await this.sleep(150, ctx.signal);
      this.emit(ctx, 'progress', { phase: 'smoke_tests.passed', count: 8 }, lane.id);
      await this.sleep(150, ctx.signal);

      const inject = ctx.opts.injectFailure;
      if (inject && inject.stage === 'rehearse') {
        const isConcurrency = inject.scenario === 'concurrency';
        this.emit(ctx, 'progress', {
          phase: 'synthetic_load.breach',
          p99_ms: isConcurrency ? 8740 : 494,
          error_rate_pct: isConcurrency ? 0.0 : 6.67,
          threshold_error_rate_pct: isConcurrency ? 0.0 : 1.0,
          threshold_p99_ms: isConcurrency ? 500 : undefined,
        }, lane.id);
        const logs = isConcurrency ? defaultConcurrentLogs() : await loadInjectedLogs(inject);
        this.emit(ctx, 'progress', { phase: 'medic.invoked' }, lane.id);
        const diagnosis = await diagnose({
          stage: 'rehearse',
          phase: 'synthetic_load',
          laneId: lane.id,
          laneRole: lane.role,
          servicePath: lane.servicePath,
          platform: lane.platformDecision?.chosen ?? 'fly',
          connectionState: 'scripted',
          repoPath: inject.repoPath ?? '.',
          convoyAuthoredFiles: inject.convoyAuthoredFiles ?? [],
          logs,
          metrics: isConcurrency
            ? { p99_ms: 8740, p95_ms: 6210, error_rate_pct: 0.0, count: 300 }
            : { p99_ms: 494, p95_ms: 410, error_rate_pct: 6.67, count: 90 },
          errorMessage: isConcurrency
            ? 'synthetic load breached p99 tolerance (8740ms > 500ms) — all requests succeeded but serialised'
            : 'synthetic load breached error-rate tolerance (6.67% > 1%)',
        }, this.medicTelemetry(ctx));
        this.emit(ctx, 'diagnosis', diagnosis, lane.id);
        throw new RehearsalBreachError(diagnosis);
      }

      const result = {
        mode: 'scripted' as const,
        healthy: true,
        p99_ms: 142,
        smoke_tests_passed: 8,
        new_error_fingerprints: 0,
      };
      outputs[lane.id] = result;
      this.emit(ctx, 'finished', result, lane.id);
    }
    return outputs;
  }

  async #runReal(ctx: StageContext, cfg: RealRehearsalOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-local', target: cfg.repoPath });

    const runner = new RehearsalRunner(
      {
        installCwd: cfg.repoPath,
        serviceCwd: cfg.serviceCwd ?? cfg.repoPath,
        startCommand: cfg.startCommand,
        port: cfg.port,
        healthPath: cfg.healthPath,
        inheritAmbientEnv: cfg.inheritAmbientEnv === true,
        ...(cfg.installCommand !== undefined && { installCommand: cfg.installCommand }),
        ...(cfg.buildCommand !== undefined && { buildCommand: cfg.buildCommand }),
        ...(cfg.metricsPath !== undefined && { metricsPath: cfg.metricsPath }),
        ...(cfg.env !== undefined && { env: cfg.env }),
      },
      {
        maxErrorRatePct: cfg.maxErrorRatePct ?? 1.0,
        maxP99Ms: cfg.maxP99Ms ?? 500,
      },
      (phase, payload) => {
        this.emit(ctx, 'progress', { phase, ...(payload ?? {}) });
      },
    );

    const rehearsal = await runner.run(
      {
        requests: cfg.probeRequests ?? 60,
        concurrency: cfg.probeConcurrency ?? 4,
        paths: cfg.probePaths ?? [cfg.healthPath],
        timeoutMs: 5000,
      },
      ctx.signal,
    );

    if (!rehearsal.ok) {
      this.emit(
        ctx,
        'log',
        buildFailureLogPayload(
          rehearsal.logs,
          rehearsal.reason ?? 'rehearsal failed',
        ),
      );
      this.emit(ctx, 'progress', { phase: 'medic.invoked' });
      const diagnosis = await diagnose({
        stage: 'rehearse',
        phase: 'real_local',
        repoPath: cfg.repoPath,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: rehearsal.logs,
        metrics: {
          ...(rehearsal.metricsAfter ?? rehearsal.metricsBefore ?? {}) as Record<string, unknown>,
        },
        errorMessage: rehearsal.reason ?? 'rehearsal failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new RehearsalBreachError(diagnosis);
    }

    const result = {
      healthy: true,
      duration_ms: rehearsal.durationMs,
      metricsBefore: rehearsal.metricsBefore,
      metricsAfter: rehearsal.metricsAfter,
      log_lines: rehearsal.logs.length,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }
}

export class RehearsalBreachError extends Error {
  constructor(public readonly diagnosis: unknown) {
    super('rehearsal breached tolerance — medic produced a diagnosis');
    this.name = 'RehearsalBreachError';
  }
}

async function loadInjectedLogs(inject: InjectFailureOpt): Promise<string[]> {
  if (!inject.logsPath) return defaultBuggyLogs();
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(inject.logsPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return defaultBuggyLogs();
  }
}

function defaultBuggyLogs(): string[] {
  const now = new Date().toISOString();
  return [
    `{"ts":"${now}","level":"info","message":"server_started","port":8080,"mode":"production"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":1,"pageSize":20,"latency_ms":14}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":2,"pageSize":20,"latency_ms":12}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":3,"pageSize":20,"latency_ms":15}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":474,"endpoint":"/orders","page":1,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":4,"pageSize":20,"latency_ms":13}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":5,"pageSize":20,"latency_ms":18}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":492,"endpoint":"/orders","page":2,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":6,"pageSize":20,"latency_ms":14}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":461,"endpoint":"/orders","page":3,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
  ];
}

function defaultConcurrentLogs(): string[] {
  const now = new Date().toISOString();
  // Simulate 30 concurrent /render requests queuing through a global serialisation
  // lock. All requests succeed (HTTP 200) but wait times stack up linearly.
  // The medic should identify renderLock in src/routes/render.ts as the root cause.
  const entries: string[] = [
    `{"ts":"${now}","level":"info","message":"server_started","port":8080,"mode":"concurrent"}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-001","waited_ms":0}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-002","waited_ms":301}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-003","waited_ms":604}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-004","waited_ms":906}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-005","waited_ms":1208}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-010","waited_ms":2710}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-020","waited_ms":5720}`,
    `{"ts":"${now}","level":"info","message":"render_lock_acquired","reportId":"rep-029","waited_ms":8432}`,
    `{"ts":"${now}","level":"info","message":"render_complete","reportId":"rep-001","pages":1,"render_ms":301,"total_ms":301}`,
    `{"ts":"${now}","level":"info","message":"render_complete","reportId":"rep-002","pages":1,"render_ms":300,"total_ms":601}`,
    `{"ts":"${now}","level":"info","message":"render_complete","reportId":"rep-010","pages":1,"render_ms":299,"total_ms":3009}`,
    `{"ts":"${now}","level":"info","message":"render_complete","reportId":"rep-029","pages":1,"render_ms":301,"total_ms":8733}`,
  ];
  return entries;
}

export class CanaryStage extends BaseStage {
  readonly name = 'canary' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    // Secrets gate — fires only when we're about to do a real platform
    // deploy. Computes expected vs staged keys; if any required keys are
    // missing, OR if auth/project binding is missing, request a
    // stage_secrets approval and pause. The approval form (web UI) lets
    // the operator paste values inline; the server action writes them to
    // .env.convoy-secrets AND pushes them to the platform via the
    // platform CLI, so the deploy that follows actually has them.
    //
    // Unlike the first revision, this gate now probes the platform
    // connection read-only so the operator sees the exact missing lane
    // prerequisite before the deploy command fails late.
    const isRealDeploy = Boolean(ctx.opts.realFly || ctx.opts.realVercel || ctx.opts.realVps || ctx.opts.realVpsGhcr || ctx.opts.realRailway || ctx.opts.realCloudRun);
    if (isRealDeploy && ctx.opts.plan) {
      const plan = normalizePlan(ctx.opts.plan);
      for (const lane of plan.lanes) {
        await this.#secretsGate(ctx, plan, lane);
      }
    }

    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel);
    }
    if (ctx.opts.realVps) {
      return this.#runRealVps(ctx, ctx.opts.realVps);
    }
    if (ctx.opts.realVpsGhcr) {
      return this.#runRealVpsGhcr(ctx, ctx.opts.realVpsGhcr);
    }
    if (ctx.opts.realRailway) {
      return this.#runRealRailway(ctx, ctx.opts.realRailway);
    }
    if (ctx.opts.realCloudRun) {
      return this.#runRealCloudRun(ctx, ctx.opts.realCloudRun);
    }

    // Scripted path — DAG-aware multi-lane sequencing
    const plan = ctx.opts.plan ? normalizePlan(ctx.opts.plan) : null;
    const allLanes = plan?.lanes ?? [];
    const deps = plan?.dependencies ?? [];
    const waves = allLanes.length > 0 ? topoSortLanes(allLanes, deps) : [[null as DeploymentLane | null]];

    this.emit(ctx, 'started', {});
    const results: Record<string, unknown> = {};

    for (const wave of waves) {
      for (const lane of wave) {
        const laneId = lane?.id ?? null;
        await this.awaitApproval(ctx, 'promote', {
          note: 'Rehearsal clean. Promote to canary at 5% traffic?',
          bake_window_seconds: 120,
          ...(laneId ? { lane_id: laneId } : {}),
        }, laneId);
        this.emit(ctx, 'progress', { traffic_split_percent: 5 }, laneId);
        await this.sleep(1200, ctx.signal);
        this.emit(ctx, 'progress', { baseline_comparison: { p99_delta_ms: 3, error_rate_delta_pct: 0.0 } }, laneId);
        await this.sleep(400, ctx.signal);
        const result = { healthy: true, traffic_split_percent: 5, p99_delta_ms: 3, error_rate_delta_pct: 0.0 };
        results[laneId ?? 'default'] = result;
        this.emit(ctx, 'finished', result, laneId);
      }
    }
    return results;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-fly', app: cfg.appName, strategy: cfg.strategy ?? 'canary' });

    const available = await flyctlAvailable();
    if (!available) {
      throw new Error(
        'flyctl is not installed. Install it first: `curl -L https://fly.io/install.sh | sh`',
      );
    }
    const auth = await flyAuthStatus();
    if (!auth.ok) {
      throw new Error(`flyctl not authenticated: ${auth.error ?? 'unknown'}. Run: fly auth login`);
    }
    this.emit(ctx, 'progress', { phase: 'fly.authenticated', user: auth.user });

    const exists = await flyAppExists(cfg.appName);
    if (!exists) {
      if (!cfg.createIfMissing) {
        throw new Error(
          `Fly app "${cfg.appName}" does not exist. Create it first (fly apps create ${cfg.appName}) or pass --fly-create-app.`,
        );
      }
      this.emit(ctx, 'progress', { phase: 'fly.creating', app: cfg.appName, org: cfg.org ?? 'personal' });
      await flyCreateApp(cfg.appName, cfg.org);
      this.emit(ctx, 'progress', { phase: 'fly.created' });
    }

    if (cfg.secrets && Object.keys(cfg.secrets).length > 0) {
      this.emit(ctx, 'progress', { phase: 'secrets.staging', count: Object.keys(cfg.secrets).length });
      await flySetSecrets(cfg.appName, cfg.secrets);
      this.emit(ctx, 'progress', { phase: 'secrets.staged' });
    }

    await this.awaitApproval(ctx, 'promote', {
      app: cfg.appName,
      strategy: cfg.strategy ?? 'canary',
      note: `Rehearsal clean. Deploy to Fly app "${cfg.appName}" using ${cfg.strategy ?? 'canary'} strategy?`,
    });

    const preReleases = await flyListReleases(cfg.appName);
    const previousVersion = preReleases[0]?.version;
    if (previousVersion !== undefined) {
      this.emit(ctx, 'progress', { phase: 'rollback.prestaged', previous_version: previousVersion });
    }

    this.emit(ctx, 'progress', { phase: 'fly.deploying', strategy: cfg.strategy ?? 'canary' });

    const deployResult = await flyDeploy(cfg.appName, cfg.cwd, {
      strategy: cfg.strategy ?? 'canary',
      remoteOnly: true,
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!deployResult.ok) {
      this.emit(ctx, 'progress', { phase: 'fly.deploy_failed', error: deployResult.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'fly_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: deployResult.logs,
        errorMessage: deployResult.error ?? 'fly deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Fly deploy failed: ${deployResult.error}`);
    }

    const hostname = deployResult.hostname ?? `${cfg.appName}.fly.dev`;
    this.emit(ctx, 'progress', { phase: 'fly.deployed', hostname });

    const result = {
      healthy: true,
      strategy: cfg.strategy ?? 'canary',
      hostname,
      app: cfg.appName,
      ...(previousVersion !== undefined && { previous_version: previousVersion }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealVercel(ctx: StageContext, cfg: RealVercelOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vercel', cwd: cfg.cwd });

    const connection = await probePlatformConnection('vercel', cfg.cwd);
    if (!connection.cliAvailable) {
      throw new Error(connection.recommendedRemedy ?? 'vercel CLI is not available');
    }
    if (!connection.authenticated) {
      throw new Error(connection.recommendedRemedy ?? 'vercel CLI is not authenticated');
    }
    if (!connection.projectLinked) {
      throw new Error(connection.recommendedRemedy ?? 'workspace is not linked to a Vercel project');
    }
    this.emit(ctx, 'progress', {
      phase: 'vercel.connected',
      account: connection.account,
      project_binding: connection.projectBinding,
      env_keys: connection.envKeys,
    });

    await this.awaitApproval(ctx, 'promote', {
      note: 'Convoy-authored PR merged. Deploy to Vercel as a preview?',
      cwd: cfg.cwd,
    });

    // Capture prior prod for rollback.
    const priorDeployments = await vercelListDeployments(cfg.cwd, 20);
    const previousProd = priorDeployments.find((d) => d.target === 'production' && d.state === 'READY');
    if (previousProd) {
      this.emit(ctx, 'progress', {
        phase: 'rollback.prestaged',
        previous_production_url: previousProd.url,
      });
    }

    this.emit(ctx, 'progress', { phase: 'vercel.deploying_preview' });

    const preview = await vercelDeploy({
      cwd: cfg.cwd,
      target: 'preview',
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!preview.ok) {
      this.emit(ctx, 'progress', { phase: 'vercel.preview_failed', error: preview.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'vercel_preview',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: preview.logs,
        errorMessage: preview.error ?? 'vercel preview deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Vercel preview deploy failed: ${preview.error}`);
    }

    const previewUrl = preview.url!;
    this.emit(ctx, 'progress', { phase: 'vercel.preview_ready', preview_url: previewUrl });

    const result = {
      healthy: true,
      preview_url: previewUrl,
      ...(previousProd?.url && { previous_production_url: previousProd.url }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * VPS canary path: rsync source → run deploy script over SSH → wait for
   * the health probe baked into the script. The deploy script (authored by
   * Convoy at planning time) handles the blue/green slot logic; this stage
   * just kicks it off and surfaces its output.
   *
   * Pre-staged reverse: the previous slot's container is renamed to
   * `convoy-<slot>-prev` by the deploy script before the new one starts —
   * so a rollback is one nginx swap (or one active-slot file rewrite when
   * nginx is operator-managed) away.
   */
  async #runRealVps(ctx: StageContext, cfg: RealVpsOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vps', host: cfg.host, app: cfg.appName });

    const target = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };

    const sshOk = await sshAvailable();
    if (!sshOk) {
      throw new Error('OpenSSH client (`ssh`) is not installed. On macOS it ships by default; on Debian/Ubuntu run `apt install openssh-client`.');
    }
    const rsyncOk = await rsyncAvailable();
    if (!rsyncOk) {
      throw new Error('`rsync` is not installed locally. Convoy uses rsync as the cheapest delivery mechanism (only the diff transfers).');
    }

    const remote = await probeRemote(target);
    if (!remote.reachable) {
      throw new Error(`Cannot reach ${cfg.host} over SSH: ${remote.rawError ?? 'connection refused'}`);
    }
    if (!remote.hasDocker) {
      throw new Error(`Docker is not installed on ${cfg.host}. Run \`convoy vps bootstrap ${cfg.host}\` to install it (idempotent), or install Docker manually.`);
    }
    if (cfg.manageNginx && !remote.hasNginx) {
      throw new Error(`--vps-manage-nginx was set but nginx isn't installed on ${cfg.host}. Either install it or drop --vps-manage-nginx and route traffic yourself.`);
    }
    this.emit(ctx, 'progress', {
      phase: 'vps.connected',
      user: remote.user,
      docker: remote.hasDocker,
      nginx: remote.hasNginx,
      disk_free_gb: remote.diskFreeGb,
    });

    await this.awaitApproval(ctx, 'promote', {
      note: `Rehearsal clean. Deploy to ${cfg.host} (slot=blue/green, nginx=${cfg.manageNginx ? 'managed' : 'operator-owned'})?`,
      host: cfg.host,
      deploy_root: cfg.deployRoot,
    });

    if (!remote.deployRootExists) {
      this.emit(ctx, 'progress', { phase: 'vps.provisioning', deploy_root: cfg.deployRoot });
      const provision = await ensureDeployRoot(target);
      if (!provision.ok) {
        throw new Error(`Failed to provision ${cfg.deployRoot}: ${provision.stderr.trim().slice(0, 240)}`);
      }
    }

    const activeSlot = await readActiveSlot(target);
    const idleSlot: 'blue' | 'green' = activeSlot === 'blue' ? 'green' : 'blue';
    this.emit(ctx, 'progress', {
      phase: 'vps.slot_chosen',
      active: activeSlot,
      idle: idleSlot,
    });

    this.emit(ctx, 'progress', { phase: 'vps.rsync', cwd: cfg.cwd });
    const rsync = await rsyncSource(target, cfg.cwd, 'source', {
      onLog: (line) => {
        if (/error|failed/i.test(line)) this.emit(ctx, 'log', { line });
      },
    });
    if (!rsync.ok) {
      throw new Error(`rsync to ${cfg.host} failed: ${rsync.stderr.trim().slice(0, 240)}`);
    }

    const release = `r${Date.now().toString(36)}`;
    this.emit(ctx, 'progress', { phase: 'vps.deploying', release, slot: idleSlot });
    const deploy = await executeDeploy(target, release, idleSlot, {
      onLog: (line) => {
        if (line.includes('convoy.health.ok') || line.includes('convoy.health.fail') || /error|failed/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
      timeoutMs: 10 * 60 * 1000,
    });
    if (!deploy.ok) {
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'vps_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: (deploy.stdout + '\n' + deploy.stderr).split(/\r?\n/).slice(-200),
        errorMessage: `vps deploy failed on slot ${idleSlot}: ${deploy.stderr.trim().slice(0, 240)}`,
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`VPS deploy failed: ${deploy.stderr.trim().slice(0, 240)}`);
    }

    const result = {
      healthy: true,
      host: cfg.host,
      release,
      idle_slot: idleSlot,
      previous_slot: activeSlot,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * GHCR VPS canary path:
   *   1. Local docker build + push to GHCR
   *   2. Optional Caddy site file setup (idempotent)
   *   3. promote gate
   *   4. SSH: docker login → docker pull → (optional) migrations → compose up
   *
   * Pre-staged reverse: we read the currently-running image tag before the
   * deploy so ObserveStage can roll back to it if the bake window breaches.
   */
  async #runRealVpsGhcr(ctx: StageContext, cfg: RealVpsGhcrOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vps-ghcr', host: cfg.host, app: cfg.appName });

    const target: GhcrDeployTarget = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };

    // Preflight: local docker + remote SSH
    const dockerOk = await dockerAvailable();
    if (!dockerOk) {
      throw new Error('docker is not installed locally. Convoy uses `docker buildx build` to build and push the image to GHCR before deploying.');
    }

    const sshOk = await sshAvailable();
    if (!sshOk) {
      throw new Error('OpenSSH client (`ssh`) is not installed. On macOS it ships by default; on Debian/Ubuntu run `apt install openssh-client`.');
    }

    this.emit(ctx, 'progress', { phase: 'vps.ghcr.preflighting' });

    // Caddy setup (idempotent — safe to run on every deploy)
    if (cfg.manageCaddy) {
      if (!cfg.domain) {
        throw new Error('--vps-ghcr-manage-caddy requires --vps-ghcr-domain to be set.');
      }
      const hasCaddy = await caddyAvailable(target);
      if (!hasCaddy) {
        throw new Error(`Caddy is not installed on ${cfg.host}. Install it first: https://caddyserver.com/docs/install`);
      }
      this.emit(ctx, 'progress', { phase: 'caddy.setup' });
      const importResult = await ensureCaddyImport(target);
      if (!importResult.ok) {
        throw new Error(`Failed to ensure Caddy import on ${cfg.host}: ${importResult.stderr.trim().slice(0, 240)}`);
      }
      const siteResult = await writeCaddySiteFile(target, cfg.appName, cfg.domain, cfg.containerPort ?? 3000);
      if (!siteResult.ok) {
        throw new Error(`Failed to write Caddy site file: ${siteResult.stderr.trim().slice(0, 240)}`);
      }
      const reloadResult = await reloadCaddy(target);
      if (!reloadResult.ok) {
        throw new Error(`Caddy reload failed: ${reloadResult.stderr.trim().slice(0, 240)}`);
      }
      this.emit(ctx, 'progress', { phase: 'caddy.ready', domain: cfg.domain });
    }

    // Login to GHCR from local side so the build push succeeds
    this.emit(ctx, 'progress', { phase: 'ghcr.login' });
    const loginResult = await ghcrLogin('ghcr.io', cfg.ghcrUsername, cfg.ghcrToken);
    if (!loginResult.ok) {
      throw new Error(`docker login to ghcr.io failed: ${loginResult.stderr.trim().slice(0, 240)}`);
    }

    // Build + push — tag with a timestamp-based release id for determinism
    const tag = `r${Date.now().toString(36)}`;
    this.emit(ctx, 'progress', { phase: 'ghcr.building', image: cfg.imageRef, tag });

    const buildLogs: string[] = [];
    const buildResult = await buildAndPushGhcr(cfg.cwd, cfg.imageRef, {
      tag,
      extraTags: ['latest'],
      buildArgs: cfg.buildArgs,
      onLog: (line) => {
        buildLogs.push(line);
        if (/error|failed/i.test(line)) this.emit(ctx, 'log', { line });
      },
      timeoutMs: 20 * 60 * 1000,
    });

    if (!buildResult.ok) {
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'ghcr_build',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: buildLogs.slice(-200),
        errorMessage: buildResult.error ?? 'docker build failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Docker build failed: ${buildResult.error}`);
    }

    this.emit(ctx, 'progress', { phase: 'ghcr.pushed', image: buildResult.imageRef });

    // Read the currently-running image before deploying so we have the
    // rollback target ready before any state change.
    const previousImageRef = await readCurrentComposeImage(target, cfg.deployRoot, cfg.composeService ?? 'web');
    if (previousImageRef) {
      this.emit(ctx, 'progress', { phase: 'rollback.prestaged', previous_image: previousImageRef });
    }

    await this.awaitApproval(ctx, 'promote', {
      mode: 'real',
      app: cfg.appName,
      host: cfg.host,
      image: buildResult.imageRef,
      note: `Image built and pushed. Deploy to ${cfg.host} via docker compose?`,
      ...(previousImageRef ? { rollback_image: previousImageRef } : {}),
    });

    // Deploy on the box
    this.emit(ctx, 'progress', { phase: 'vps.ghcr.deploying', image: buildResult.imageRef });

    const deployLogs: string[] = [];
    const deployResult = await composeDeployViaGhcr(target, {
      imageRef: buildResult.imageRef,
      service: cfg.composeService ?? 'web',
      runMigrations: cfg.runMigrations ?? false,
      migrationNetwork: cfg.migrationNetwork ?? cfg.appName,
      ghcrUsername: cfg.ghcrUsername,
      ghcrToken: cfg.ghcrToken,
      onLog: (line) => {
        deployLogs.push(line);
        if (/error|failed/i.test(line)) this.emit(ctx, 'log', { line });
      },
    });

    if (!deployResult.ok) {
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'vps_ghcr_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: deployLogs.slice(-200),
        errorMessage: `compose deploy on ${cfg.host} failed: ${deployResult.error ?? ''}`,
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`VPS GHCR deploy failed: ${deployResult.error}`);
    }

    this.emit(ctx, 'progress', { phase: 'vps.ghcr.deployed' });

    const result = {
      healthy: true,
      host: cfg.host,
      image: buildResult.imageRef,
      tag,
      previous_image: previousImageRef,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * Secrets gate. Computes which required keys aren't yet staged and
   * requests a stage_secrets approval if any are missing. The approval's
   * summary carries the missing-key list plus platform/binding context so
   * the web UI can push values into the correct target. Ambient operator
   * decisions:
   *   - file: <repo>/.env.convoy-secrets (KEY=VALUE)
   *   - file: <repo>/.env.convoy-already-set (KEY= names)
   *   - flag: --already-set=K1,K2 (passed via opts.alreadySetKeys)
   *
   * Platform probing is read-only. We inspect auth/project/env state before
   * prompting so operators only see truly missing keys.
   */
  async #secretsGate(ctx: StageContext, plan: ConvoyPlan, lane: DeploymentLane): Promise<void> {
    const expected = new Set<string>(lane.secrets.expectedKeys);
    const sources = lane.secrets.sources;
    if (expected.size === 0) return;

    const targetCwd = lane.servicePath === '.'
      ? plan.repo.localPath
      : `${plan.repo.localPath}/${lane.servicePath}`;
    const secretsPath = `${plan.repo.localPath}/.env.convoy-secrets`;
    const alreadyPath = `${plan.repo.localPath}/.env.convoy-already-set`;

    const fileSecrets = readEnvKeyOnly(secretsPath);
    const fileAlready = readEnvKeyOnly(alreadyPath);
    const cliAlready = ctx.opts.alreadySetKeys ?? [];

    const staged = new Set<string>([...fileSecrets, ...fileAlready, ...cliAlready]);
    const connection = await probePlatformConnection(lane.platformDecision.chosen, targetCwd, {
      appName: ctx.opts.realFly?.appName,
      expectedSecrets: lane.secrets.expectedKeys,
    });
    const connectionKeys = new Set(connection.envKeys);
    const missing = [...expected].filter((k) => !staged.has(k) && !connectionKeys.has(k));
    const blockingChecks = connection.checks.filter((check) => check.required && !check.ok);

    // Filter platform-managed keys we never expect operators to stage.
    const filtered = missing.filter((k) => !isPlatformManagedKey(k, lane.platformDecision.chosen));

    if (filtered.length === 0 && blockingChecks.length === 0) {
      this.emit(ctx, 'progress', {
        phase: 'secrets.staged',
        sources,
        expected_count: expected.size,
        staged_count: expected.size - missing.length,
        connection_env_count: connection.envKeys.length,
      }, lane.id);
      return;
    }

    const platform = lane.platformDecision.chosen;
    const flyAppName = platform === 'fly'
      ? (ctx.opts.realFly?.appName ?? null)
      : null;

    this.emit(ctx, 'progress', {
      phase: 'secrets.gate',
      missing: filtered,
      sources,
      platform,
      note: blockingChecks.length > 0
        ? 'pausing for lane readiness — fix auth/project binding below, then re-check from the run UI before deploy'
        : 'pausing for stage_secrets approval — paste values in the UI or self-declare and Convoy will push to the platform before the deploy command runs',
      connection_state: blockingChecks.length > 0 ? 'blocked' : 'ready_for_secrets',
      connection_checks: connection.checks,
    }, lane.id);

    await this.awaitApproval(ctx, 'stage_secrets', {
      mode: 'real',
      lane_id: lane.id,
      service_path: lane.servicePath,
      display_name: lane.displayName,
      missing: filtered.map((key) => ({
        key,
        severity: classifySecretSeverity(key),
        purpose: secretPurposeHint(key),
      })),
      sources,
      platform,
      plan_id: plan.id,
      fly_app: flyAppName,
      target_cwd: targetCwd,
      expected_keys: [...expected],
      missing_expected_keys: filtered,
      blocking_connection_checks: blockingChecks,
      connection_checks: connection.checks,
      project_binding: connection.projectBinding,
      connection_account: connection.account,
      connection_env_keys: connection.envKeys,
      connection_raw: connection.raw ?? null,
      secrets_path: secretsPath,
      already_set_path: alreadyPath,
      note: blockingChecks.length > 0
        ? 'This lane is not ready yet. Fix the auth or project-binding gaps below, then re-check. If secrets are also missing, you can still stage them here once the lane connection is ready.'
        : 'These required env vars aren\'t staged yet. Paste each value below to push it to the platform now, mark it as already set if you set it elsewhere, or skip with explicit acknowledgment.',
    }, lane.id);

    this.emit(ctx, 'progress', { phase: 'secrets.gate.cleared', missing: filtered }, lane.id);
  }

  async #runRealRailway(ctx: StageContext, cfg: RealRailwayOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-railway', cwd: cfg.cwd });

    const { railwayAvailable, railwayAuthStatus, railwaySetSecrets, railwayDeploy } = await import('../adapters/railway/runner.js');

    const available = await railwayAvailable();
    if (!available) {
      throw new Error('railway CLI is not installed. Install it first: `npm i -g @railway/cli`');
    }
    const auth = await railwayAuthStatus();
    if (!auth.ok) {
      throw new Error(`railway CLI not authenticated: ${auth.error ?? 'unknown'}. Run: railway login`);
    }
    this.emit(ctx, 'progress', { phase: 'railway.authenticated', user: auth.user });

    if (cfg.secrets && Object.keys(cfg.secrets).length > 0) {
      this.emit(ctx, 'progress', { phase: 'secrets.staging', count: Object.keys(cfg.secrets).length });
      await railwaySetSecrets(cfg.secrets, cfg.cwd, cfg.projectId);
      this.emit(ctx, 'progress', { phase: 'secrets.staged' });
    }

    await this.awaitApproval(ctx, 'promote', {
      note: `Rehearsal clean. Deploy to Railway${cfg.projectId ? ` (project: ${cfg.projectId})` : ''}?`,
      cwd: cfg.cwd,
    });

    this.emit(ctx, 'progress', { phase: 'railway.deploying' });

    const deployResult = await railwayDeploy({
      cwd: cfg.cwd,
      projectId: cfg.projectId,
      onLog: (line) => {
        if (/error|failed/i.test(line)) this.emit(ctx, 'log', { line });
      },
    });

    if (!deployResult.ok) {
      this.emit(ctx, 'progress', { phase: 'railway.deploy_failed', error: deployResult.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'railway_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: deployResult.logs,
        errorMessage: deployResult.error ?? 'railway deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Railway deploy failed: ${deployResult.error}`);
    }

    const result = {
      healthy: true,
      url: deployResult.url,
      deploymentId: deployResult.deploymentId,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealCloudRun(ctx: StageContext, cfg: RealCloudRunOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-cloudrun', service: cfg.service, region: cfg.region ?? 'us-central1' });

    const { gcloudAvailable, cloudRunAuthStatus, cloudRunGetCurrentRevision, cloudRunDeploy } = await import('../adapters/cloudrun/runner.js');

    const available = await gcloudAvailable();
    if (!available) {
      throw new Error('gcloud CLI is not installed. Install it first: https://cloud.google.com/sdk/docs/install');
    }
    const auth = await cloudRunAuthStatus();
    if (!auth.ok) {
      throw new Error(`gcloud not authenticated: ${auth.error ?? 'unknown'}. Run: gcloud auth login`);
    }
    this.emit(ctx, 'progress', { phase: 'cloudrun.authenticated', account: auth.account, project: auth.project });

    const region = cfg.region ?? 'us-central1';

    // Pre-stage rollback target
    const previousRevision = await cloudRunGetCurrentRevision(cfg.service, region, cfg.project);
    if (previousRevision) {
      this.emit(ctx, 'progress', { phase: 'rollback.prestaged', previous_revision: previousRevision });
    }

    await this.awaitApproval(ctx, 'promote', {
      note: `Rehearsal clean. Deploy ${cfg.image} to Cloud Run service "${cfg.service}" in ${region}?`,
      service: cfg.service,
      image: cfg.image,
      region,
    });

    this.emit(ctx, 'progress', { phase: 'cloudrun.deploying', service: cfg.service, image: cfg.image, region });

    const deployResult = await cloudRunDeploy({
      service: cfg.service,
      image: cfg.image,
      region,
      project: cfg.project,
      envVars: cfg.secrets,
      onLog: (line) => {
        if (/error|failed/i.test(line)) this.emit(ctx, 'log', { line });
      },
    });

    if (!deployResult.ok) {
      this.emit(ctx, 'progress', { phase: 'cloudrun.deploy_failed', error: deployResult.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'cloudrun_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: deployResult.logs,
        errorMessage: deployResult.error ?? 'cloud run deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Cloud Run deploy failed: ${deployResult.error}`);
    }

    const result = {
      healthy: true,
      url: deployResult.url,
      revision: deployResult.revision,
      service: cfg.service,
      region,
      ...(previousRevision ? { previous_revision: previousRevision } : {}),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }
}

/**
 * Per-key severity classifier — drives the visual weight in the stage_secrets
 * approval card. DB / credential / token keys read as critical (the deploy
 * provably can't function without them); everything else is "standard."
 *
 * Pattern-based and intentionally heuristic — false negatives just downgrade
 * a key to "standard" (still surfaced, just less alarming). False positives
 * upgrade harmless keys to "critical" (operator notices, no harm done).
 */
function classifySecretSeverity(key: string): 'critical' | 'standard' {
  const k = key.toUpperCase();
  if (/(DATABASE|POSTGRES|MONGODB|REDIS|MYSQL|SQL)_?URL$/.test(k)) return 'critical';
  if (/_DATABASE_URL$|^PRISMA_DATABASE_URL$/.test(k)) return 'critical';
  if (/_CONNECTION_STRING$|_CONNECTION_URI$/.test(k)) return 'critical';
  if (/(API_KEY|SECRET|TOKEN|PRIVATE_KEY|CLIENT_SECRET)$/.test(k)) return 'critical';
  if (/^(STRIPE_|CLERK_SECRET|JWT_SECRET|AUTH_SECRET|NEXTAUTH_SECRET)/.test(k)) return 'critical';
  return 'standard';
}

/**
 * Hint string surfaced under the key name in the approval card so the
 * operator sees what the value is *for* without having to grep their schema.
 * Heuristic again — when no pattern matches we just say "required by .env.schema".
 */
function secretPurposeHint(key: string): string {
  const k = key.toUpperCase();
  if (/(DATABASE|POSTGRES|MYSQL|SQL)_?URL$/.test(k)) return 'database connection string';
  if (/MONGODB_?URL$/.test(k)) return 'MongoDB connection string';
  if (/REDIS_?URL$/.test(k)) return 'Redis connection string';
  if (/_API_KEY$/.test(k)) return 'API key';
  if (/_SECRET$|^.*_SECRET$/.test(k)) return 'secret';
  if (/_TOKEN$/.test(k)) return 'token';
  if (/^STRIPE_/.test(k)) return 'Stripe credential';
  if (/^CLERK_/.test(k)) return 'Clerk auth credential';
  if (/^NEXT_PUBLIC_/.test(k)) return 'public env var (shipped to client bundle)';
  return 'required by .env.schema';
}

/**
 * Filter out keys the platform itself sets at runtime — operators shouldn't
 * have to stage these and Convoy shouldn't pause for them.
 */
function isPlatformManagedKey(key: string, platform: Platform): boolean {
  if (platform === 'vercel') {
    return key.startsWith('VERCEL_') || key.startsWith('NEXT_PUBLIC_VERCEL_');
  }
  if (platform === 'fly') {
    return key.startsWith('FLY_') || key === 'PORT';
  }
  if (platform === 'cloudrun') {
    return key === 'PORT' || key === 'K_SERVICE' || key === 'K_REVISION' || key === 'K_CONFIGURATION';
  }
  return false;
}

/**
 * Plan-only computation of expected keys — duplicated from cli.ts's
 * computeExpectedKeys to keep stages.ts self-contained (the cli version
 * is imported from cli.ts, which would create a circular dep). Reads
 * .env.schema from the plan's authoredFiles + the target's .env.example.
 */
function computeExpectedKeysFromPlan(plan: ConvoyPlan): {
  keys: Set<string>;
  sources: string[];
} {
  const keys = new Set<string>();
  const sources: string[] = [];

  const schema = plan.author.convoyAuthoredFiles.find((f) => f.path === '.env.schema');
  if (schema) {
    const k = extractEnvKeysFromText(schema.contentPreview);
    k.forEach((key) => keys.add(key));
    if (k.length > 0) sources.push(`.env.schema (${k.length})`);
  }

  const targetCwd = plan.target.workspace
    ? path.resolve(plan.target.localPath, plan.target.workspace)
    : plan.target.localPath;
  for (const cand of ['.env.example', '.env.local.example']) {
    const candidates = [path.resolve(targetCwd, cand), path.resolve(plan.target.localPath, cand)];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const k = extractEnvKeysFromText(fs.readFileSync(p, 'utf8'));
          k.forEach((key) => keys.add(key));
          if (k.length > 0) sources.push(`${cand} (${k.length})`);
          break;
        } catch {
          // unreadable, skip
        }
      }
    }
  }

  return { keys, sources };
}

function extractEnvKeysFromText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) out.push(key);
  }
  return out;
}

function readEnvKeyOnly(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return extractEnvKeysFromText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

export class PromoteStage extends BaseStage {
  readonly name = 'promote' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel, ctx.prior['canary'] as Record<string, unknown> | undefined);
    }
    if (ctx.opts.realVps) {
      return this.#runRealVps(ctx, ctx.opts.realVps, ctx.prior['canary'] as Record<string, unknown> | undefined);
    }
    if (ctx.opts.realVpsGhcr) {
      return this.#runRealVpsGhcr(ctx, ctx.opts.realVpsGhcr, ctx.prior['canary'] as Record<string, unknown> | undefined);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });

    for (const pct of [10, 25, 50, 100]) {
      this.emit(ctx, 'progress', { traffic_split_percent: pct });
      await this.sleep(450, ctx.signal);
    }

    // No fake live URL in scripted mode. Before this change the demo path
    // emitted https://convoy-demo-<hash>.fly.dev which never resolved — the
    // CLI printed it green, the web UI linked to it, both lied. Scripted
    // runs end without a live URL; only real deploys populate run.liveUrl.
    const result = { mode: 'scripted' as const, release: 'v1', note: 'scripted pipeline — no deployment' };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    // Fly's canary strategy already rolled out to all machines inside the
    // CanaryStage. PromoteStage just verifies the live hostname for a short
    // window — this is the earliest moment we can say users are served the
    // new image.
    this.emit(ctx, 'started', { mode: 'real-fly', phase: 'verify-live' });

    const hostname = `${cfg.appName}.fly.dev`;
    const healthPath = cfg.healthPath ?? '/health';
    const verifyWindowMs = 20_000;
    const probeTimeoutMs = 5_000;
    const deadline = Date.now() + verifyWindowMs;
    const latencies: number[] = [];
    let consecutive = 0;
    let lastFailure: { status?: number; error?: string } | null = null;
    while (Date.now() < deadline && consecutive < 3) {
      const h = await flyHealthCheck(hostname, healthPath, probeTimeoutMs);
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);
      this.emit(ctx, 'progress', {
        phase: 'fly.health_probe',
        status: h.status ?? 0,
        latency_ms: h.latencyMs,
        ok: h.ok,
      });
      if (h.ok) {
        consecutive += 1;
      } else {
        consecutive = 0;
        lastFailure = { ...(h.status !== undefined && { status: h.status }), ...(h.error !== undefined && { error: h.error }) };
      }
      await this.sleep(1500, ctx.signal);
    }

    if (consecutive < 3) {
      const reason = lastFailure
        ? `${healthPath} did not pass (last probe: status=${lastFailure.status ?? 0}${lastFailure.error ? `, error=${lastFailure.error}` : ''})`
        : `${healthPath} did not return 200 three times in a row within ${verifyWindowMs}ms`;
      return triggerRealFlyRollback(ctx, cfg, reason, 'promote');
    }

    const liveUrl = `https://${hostname}`;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const releases = await flyListReleases(cfg.appName);
    const currentVersion = releases[0]?.version;

    const result = {
      live_url: liveUrl,
      hostname,
      p99_ms: percentile(latencies, 0.99),
      ...(currentVersion !== undefined && { release_version: currentVersion }),
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #runRealVercel(
    ctx: StageContext,
    cfg: RealVercelOpt,
    canaryResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vercel', phase: 'promote-to-prod' });

    // Verify the preview deployment is healthy before promoting.
    const previewUrl = typeof canaryResult?.['preview_url'] === 'string' ? canaryResult['preview_url'] : null;
    const healthPath = cfg.healthPath ?? '/';
    if (previewUrl) {
      const probe = await vercelHealthCheck(previewUrl, healthPath);
      this.emit(ctx, 'progress', {
        phase: 'preview.probe',
        url: previewUrl,
        status: probe.status ?? 0,
        latency_ms: probe.latencyMs,
        ok: probe.ok,
      });
      if (!probe.ok) {
        throw new Error(
          `preview at ${previewUrl}${healthPath} did not respond 200 (status=${probe.status ?? 0}, error=${probe.error ?? 'n/a'})`,
        );
      }
    }

    this.emit(ctx, 'progress', { phase: 'vercel.deploying_production' });

    const prod = await vercelDeploy({
      cwd: cfg.cwd,
      target: 'production',
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!prod.ok) {
      throw new Error(`Vercel production deploy failed: ${prod.error}`);
    }

    const liveUrl = prod.url!;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const result = {
      live_url: liveUrl,
      ...(prod.deploymentId && { deployment_id: prod.deploymentId }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * VPS promote: flip traffic to the slot that CanaryStage just deployed
   * into. When operator-managed nginx, this is just a marker file write —
   * we trust the operator's upstream config to read it. With Convoy-managed
   * nginx it's an atomic upstream rewrite + reload (zero connection drop).
   */
  async #runRealVps(
    ctx: StageContext,
    cfg: RealVpsOpt,
    canaryResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const idleSlot = (canaryResult?.['idle_slot'] === 'green' ? 'green' : 'blue') satisfies 'blue' | 'green';
    const previousSlot = (canaryResult?.['previous_slot'] === 'blue' ? 'blue' : canaryResult?.['previous_slot'] === 'green' ? 'green' : null) as 'blue' | 'green' | null;
    this.emit(ctx, 'started', { mode: 'real-vps', phase: 'flip-traffic', new_slot: idleSlot });

    const target = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };

    if (cfg.manageNginx) {
      this.emit(ctx, 'progress', { phase: 'vps.nginx_swap' });
      const swap = await swapNginxUpstream(target, cfg.appName, idleSlot);
      if (!swap.ok) {
        // Pre-staged reverse: previous slot is still serving traffic
        // because nginx never reloaded. Rollback is implicit — just don't
        // mark the new slot active.
        throw new Error(`nginx upstream swap failed: ${swap.stderr.trim().slice(0, 240)}. Previous slot is still serving traffic.`);
      }
    }

    const writeMarker = await writeActiveSlot(target, idleSlot);
    if (!writeMarker.ok) {
      throw new Error(`failed to record active slot on ${cfg.host}: ${writeMarker.stderr.trim().slice(0, 240)}`);
    }

    const liveUrl = `http://${cfg.host.split('@').pop()}${cfg.healthPath ?? '/'}`;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const result = {
      live_url: liveUrl,
      active_slot: idleSlot,
      ...(previousSlot && { previous_slot: previousSlot }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * GHCR VPS promote: the compose service is already rolling in CanaryStage.
   * This stage just probes the live URL 3× in a row to confirm the new image
   * is serving healthy responses before handing off to the observe window.
   */
  async #runRealVpsGhcr(
    ctx: StageContext,
    cfg: RealVpsGhcrOpt,
    canaryResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vps-ghcr', phase: 'verify-live' });

    const image = typeof canaryResult?.['image'] === 'string' ? canaryResult['image'] : cfg.imageRef;
    const liveHost = cfg.host.split('@').pop() ?? cfg.host;
    const liveUrl = cfg.manageCaddy && cfg.domain
      ? `https://${cfg.domain}${cfg.healthPath ?? '/'}`
      : `http://${liveHost}:${cfg.containerPort ?? 3000}${cfg.healthPath ?? '/'}`;

    const verifyWindowMs = 30_000;
    const deadline = Date.now() + verifyWindowMs;
    const latencies: number[] = [];
    let consecutive = 0;
    let lastFailure: { status?: number; error?: string } | null = null;

    while (Date.now() < deadline && consecutive < 3) {
      const probe = await httpProbe(liveUrl, 5_000);
      if (probe.latencyMs !== undefined) latencies.push(probe.latencyMs);
      this.emit(ctx, 'progress', {
        phase: 'vps.ghcr.health_probe',
        url: liveUrl,
        ok: probe.ok,
        status: probe.status ?? 0,
        latency_ms: probe.latencyMs,
      });
      if (probe.ok) {
        consecutive += 1;
      } else {
        consecutive = 0;
        lastFailure = { ...(probe.status !== undefined && { status: probe.status }), ...(probe.error !== undefined && { error: probe.error }) };
      }
      if (consecutive < 3) await this.sleep(2_000, ctx.signal);
    }

    if (consecutive < 3) {
      const reason = lastFailure
        ? `${liveUrl} did not return 200 (last probe: status=${lastFailure.status ?? 0}${lastFailure.error ? `, error=${lastFailure.error}` : ''})`
        : `${liveUrl} did not return 200 three times in a row within ${verifyWindowMs}ms`;
      const previousImage = typeof canaryResult?.['previous_image'] === 'string' ? canaryResult['previous_image'] : null;
      await this.#triggerVpsGhcrRollback(ctx, cfg, reason, 'promote', previousImage);
    }

    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const result = { live_url: liveUrl, image, previous_image: canaryResult?.['previous_image'] ?? null };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #triggerVpsGhcrRollback(
    ctx: StageContext,
    cfg: RealVpsGhcrOpt,
    reason: string,
    firedBy: 'promote' | 'observe',
    previousImage: string | null,
  ): Promise<never> {
    const emit = (kind: EventKind, payload: unknown): void => {
      const event = ctx.store.appendEvent(ctx.run.id, firedBy, kind, payload);
      ctx.bus.emit({ type: 'event.appended', event });
    };
    emit('progress', { phase: 'rollback.starting', reason, previous_image: previousImage });

    const target: GhcrDeployTarget = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };

    if (previousImage) {
      const rb = await rollbackComposeImage(target, cfg.deployRoot, previousImage, cfg.composeService ?? 'web');
      if (!rb.ok) {
        emit('progress', { phase: 'rollback.failed', error: rb.stderr.trim().slice(0, 240) });
        ctx.store.updateRun(ctx.run.id, { outcomeReason: `${reason}; rollback failed`, completedAt: new Date() });
        throw new Error(`${firedBy} breach AND rollback failed: ${rb.stderr.trim().slice(0, 240)}`);
      }
      emit('progress', { phase: 'rollback.done', restored_image: previousImage });
    } else {
      emit('progress', { phase: 'rollback.skipped', reason: 'no previous image recorded — cannot roll back automatically' });
    }

    ctx.store.updateRun(ctx.run.id, { status: 'rolled_back', completedAt: new Date(), outcomeReason: reason });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
    throw new RollbackTriggeredError(reason, firedBy);
  }
}

/**
 * Shared rollback helper invoked by promote and observe stages when they
 * detect a breach. Emits phases, calls flyRollback, updates run status to
 * rolled_back, and throws so the orchestrator records a clean failure.
 */
async function triggerRealFlyRollback(
  ctx: StageContext,
  cfg: RealFlyOpt,
  reason: string,
  firedBy: 'promote' | 'observe',
): Promise<never> {
  const emit = (kind: EventKind, payload: unknown): void => {
    const event = ctx.store.appendEvent(ctx.run.id, firedBy, kind, payload);
    ctx.bus.emit({ type: 'event.appended', event });
  };
  emit('progress', { phase: 'rollback.starting', reason });
  const result = await flyRollback(cfg.appName);
  if (!result.ok) {
    emit('progress', { phase: 'rollback.failed', error: result.error });
    ctx.store.updateRun(ctx.run.id, {
      outcomeReason: `${reason}; rollback failed: ${result.error}`,
      completedAt: new Date(),
    });
    throw new Error(`${firedBy} breach AND rollback failed: ${result.error}`);
  }
  emit('progress', {
    phase: 'rollback.done',
    restored_version: result.restoredVersion,
  });
  ctx.store.updateRun(ctx.run.id, {
    status: 'rolled_back',
    completedAt: new Date(),
    outcomeReason: reason,
    outcomeRestoredVersion: result.restoredVersion ?? null,
  });
  const updated = ctx.store.getRun(ctx.run.id);
  if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
  throw new RollbackTriggeredError(reason, firedBy, result.restoredVersion);
}

export class ObserveStage extends BaseStage {
  readonly name = 'observe' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel, ctx.prior['promote'] as Record<string, unknown> | undefined);
    }
    if (ctx.opts.realVps) {
      return this.#runRealVps(ctx, ctx.opts.realVps, ctx.prior['promote'] as Record<string, unknown> | undefined);
    }
    if (ctx.opts.realVpsGhcr) {
      return this.#runRealVpsGhcr(ctx, ctx.opts.realVpsGhcr, ctx.prior['promote'] as Record<string, unknown> | undefined);
    }

    this.emit(ctx, 'started', { bake_window_seconds: 2 });
    await this.sleep(2000, ctx.signal);

    const result = {
      window_seconds: 2,
      slo_healthy: true,
      observations: { p99_ms: 138, error_rate_pct: 0.0 },
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const hostname = `${cfg.appName}.fly.dev`;
    const healthPath = cfg.healthPath ?? '/health';
    const thresholdErrorRatePct = cfg.thresholdErrorRatePct ?? 1.0;
    const thresholdP99Ms = cfg.thresholdP99Ms ?? 1000;

    const probeEveryMs = 2000;
    const deadline = Date.now() + window * 1000;
    let probeCount = 0;
    let errors = 0;
    const latencies: number[] = [];
    let lastEmittedOk: boolean | null = null;
    let lastEmittedAt = 0;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const h = await flyHealthCheck(hostname, healthPath);
      probeCount += 1;
      if (!h.ok) errors += 1;
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);

      const errorRatePct = (errors / probeCount) * 100;
      const p99 = percentile(latencies, 0.99);

      // Throttle: emit on first probe, on ok-state change, every 5 probes, or
      // when a threshold is crossed. Keeps the timeline readable on long
      // bake windows without losing signal.
      const stateChanged = lastEmittedOk !== null && lastEmittedOk !== h.ok;
      const periodic = probeCount === 1 || probeCount % 5 === 0;
      const willBreach =
        (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) ||
        (p99 !== undefined && p99 > thresholdP99Ms);
      const shouldEmit = stateChanged || periodic || willBreach || Date.now() - lastEmittedAt > 10000;
      if (shouldEmit) {
        this.emit(ctx, 'progress', {
          phase: 'observe.probe',
          probe_count: probeCount,
          error_rate_pct: Number(errorRatePct.toFixed(2)),
          p99_ms: p99,
          ok: h.ok,
        });
        lastEmittedOk = h.ok;
        lastEmittedAt = Date.now();
      }

      if (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `error rate ${errorRatePct.toFixed(2)}% exceeded ${thresholdErrorRatePct}%`,
        });
        return this.#triggerRollback(ctx, cfg, `error rate ${errorRatePct.toFixed(2)}% > ${thresholdErrorRatePct}%`);
      }
      if (p99 !== undefined && p99 > thresholdP99Ms) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `p99 ${p99}ms exceeded ${thresholdP99Ms}ms`,
        });
        return this.#triggerRollback(ctx, cfg, `p99 ${p99}ms > ${thresholdP99Ms}ms`);
      }

      await this.sleep(probeEveryMs, ctx.signal);
    }

    const p99 = percentile(latencies, 0.99);
    const errorRatePct = probeCount === 0 ? 0 : (errors / probeCount) * 100;
    const result = {
      window_seconds: window,
      slo_healthy: true,
      probe_count: probeCount,
      error_rate_pct: Number(errorRatePct.toFixed(2)),
      p99_ms: p99,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #triggerRollback(ctx: StageContext, cfg: RealFlyOpt, reason: string): Promise<unknown> {
    return triggerRealFlyRollback(ctx, cfg, reason, 'observe');
  }

  async #runRealVercel(
    ctx: StageContext,
    cfg: RealVercelOpt,
    promoteResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const liveUrl = typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null;
    if (!liveUrl) {
      // Nothing to probe — skip observe window.
      const result = { window_seconds: 0, slo_healthy: false, reason: 'no live URL from promote' };
      this.emit(ctx, 'finished', result);
      return result;
    }

    const healthPath = cfg.healthPath ?? '/';
    const thresholdErrorRatePct = cfg.thresholdErrorRatePct ?? 1.0;
    const thresholdP99Ms = cfg.thresholdP99Ms ?? 2000;

    const probeEveryMs = 3000;
    const deadline = Date.now() + window * 1000;
    let probeCount = 0;
    let errors = 0;
    const latencies: number[] = [];
    let lastEmittedAt = 0;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const h = await vercelHealthCheck(liveUrl, healthPath);
      probeCount += 1;
      if (!h.ok) errors += 1;
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);

      const errorRatePct = (errors / probeCount) * 100;
      const p99 = percentile(latencies, 0.99);

      const shouldEmit = probeCount === 1 || probeCount % 5 === 0 || Date.now() - lastEmittedAt > 10000 || !h.ok;
      if (shouldEmit) {
        this.emit(ctx, 'progress', {
          phase: 'observe.probe',
          probe_count: probeCount,
          error_rate_pct: Number(errorRatePct.toFixed(2)),
          p99_ms: p99,
          ok: h.ok,
        });
        lastEmittedAt = Date.now();
      }

      if (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `error rate ${errorRatePct.toFixed(2)}% exceeded ${thresholdErrorRatePct}%`,
        });
        return this.#triggerVercelRollback(ctx, cfg, promoteResult, `error rate ${errorRatePct.toFixed(2)}% > ${thresholdErrorRatePct}%`);
      }
      if (p99 !== undefined && p99 > thresholdP99Ms) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `p99 ${p99}ms exceeded ${thresholdP99Ms}ms`,
        });
        return this.#triggerVercelRollback(ctx, cfg, promoteResult, `p99 ${p99}ms > ${thresholdP99Ms}ms`);
      }

      await this.sleep(probeEveryMs, ctx.signal);
    }

    const p99 = percentile(latencies, 0.99);
    const errorRatePct = probeCount === 0 ? 0 : (errors / probeCount) * 100;
    const result = {
      window_seconds: window,
      slo_healthy: true,
      probe_count: probeCount,
      error_rate_pct: Number(errorRatePct.toFixed(2)),
      p99_ms: p99,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #triggerVercelRollback(
    ctx: StageContext,
    cfg: RealVercelOpt,
    promoteResult: Record<string, unknown> | undefined,
    reason: string,
  ): Promise<unknown> {
    this.emit(ctx, 'progress', { phase: 'rollback.starting', reason });

    // For Vercel, "rollback" = alias the prod hostname back to a prior prod
    // deployment. We look up prior prod deployments and pick the most recent
    // stable one that isn't what we just shipped.
    const currentLive = typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null;
    const deployments = await vercelListDeployments(cfg.cwd, 20);
    const priorProd = deployments.find((d) => d.target === 'production' && d.state === 'READY' && d.url !== currentLive);
    if (!priorProd) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: 'no prior production deployment to roll back to' });
      ctx.store.updateRun(ctx.run.id, {
        outcomeReason: `${reason}; rollback failed: no prior production deployment`,
        completedAt: new Date(),
      });
      throw new Error(`observe breach AND rollback failed: no prior production deployment`);
    }

    // Derive production alias from the current live URL's hostname (best effort).
    const prodAlias = currentLive ? currentLive.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    if (!prodAlias) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: 'could not determine production alias' });
      throw new Error('rollback: could not determine production alias from live URL');
    }

    const result = await vercelRollback(cfg.cwd, prodAlias, priorProd.url);
    if (!result.ok) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: result.error });
      ctx.store.updateRun(ctx.run.id, {
        outcomeReason: `${reason}; rollback failed: ${result.error}`,
        completedAt: new Date(),
      });
      throw new Error(`observe breach AND rollback failed: ${result.error}`);
    }
    this.emit(ctx, 'progress', {
      phase: 'rollback.done',
      restored_deployment: priorProd.url,
    });
    ctx.store.updateRun(ctx.run.id, {
      status: 'rolled_back',
      completedAt: new Date(),
      outcomeReason: reason,
    });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
    throw new RollbackTriggeredError(reason, 'observe');
  }

  /**
   * VPS observe: poll the live URL through the bake window. On breach,
   * rollback by flipping the active slot back. The previous container is
   * still running (the deploy script renamed it `convoy-<slot>-prev`), so
   * recovery is one nginx swap (managed) or one marker file (operator-owned)
   * — that's the principle's pre-staged reverse.
   */
  async #runRealVps(
    ctx: StageContext,
    cfg: RealVpsOpt,
    promoteResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const target = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };
    const liveUrl = (typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null) ?? `http://${cfg.host.split('@').pop()}${cfg.healthPath ?? '/'}`;
    const previousSlot = (promoteResult?.['previous_slot'] === 'blue' || promoteResult?.['previous_slot'] === 'green') ? promoteResult['previous_slot'] as 'blue' | 'green' : null;

    const samples: { ok: boolean; ms: number }[] = [];
    const deadline = Date.now() + window * 1000;
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const res = await fetch(liveUrl, { method: 'GET' });
        const ms = Date.now() - t0;
        samples.push({ ok: res.ok, ms });
      } catch {
        samples.push({ ok: false, ms: Date.now() - t0 });
      }
      await this.sleep(5000, ctx.signal);
    }

    const failures = samples.filter((s) => !s.ok).length;
    const errorRatePct = samples.length === 0 ? 0 : (failures / samples.length) * 100;
    const p99 = percentile(samples.map((s) => s.ms), 0.99) ?? 0;
    const errorThreshold = cfg.thresholdErrorRatePct ?? 5;
    const p99Threshold = cfg.thresholdP99Ms ?? 1500;

    this.emit(ctx, 'progress', {
      phase: 'vps.bake_summary',
      samples: samples.length,
      error_rate_pct: errorRatePct,
      p99_ms: p99,
    });

    if (errorRatePct > errorThreshold || p99 > p99Threshold) {
      const reason = `bake breach: error_rate=${errorRatePct.toFixed(1)}% (>${errorThreshold}%) or p99=${p99}ms (>${p99Threshold}ms)`;
      if (previousSlot) {
        this.emit(ctx, 'progress', { phase: 'vps.rollback', to_slot: previousSlot, reason });
        await rollbackSlot(target, cfg.appName, previousSlot, cfg.manageNginx === true);
      }
      ctx.store.updateRun(ctx.run.id, {
        status: 'rolled_back',
        completedAt: new Date(),
        outcomeReason: reason,
      });
      const updated = ctx.store.getRun(ctx.run.id);
      if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
      throw new RollbackTriggeredError(reason, 'observe');
    }

    const result = {
      window_seconds: window,
      slo_healthy: true,
      observations: { p99_ms: p99, error_rate_pct: errorRatePct, samples: samples.length },
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * GHCR VPS observe: same bake-window polling as the rsync VPS path, but
   * rollback means re-running compose with the image tag recorded before the
   * deploy in CanaryStage.
   */
  async #runRealVpsGhcr(
    ctx: StageContext,
    cfg: RealVpsGhcrOpt,
    promoteResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const liveUrl = (typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null)
      ?? (cfg.manageCaddy && cfg.domain
        ? `https://${cfg.domain}${cfg.healthPath ?? '/'}`
        : `http://${cfg.host.split('@').pop()}:${cfg.containerPort ?? 3000}${cfg.healthPath ?? '/'}`);
    const previousImage = typeof promoteResult?.['previous_image'] === 'string' ? promoteResult['previous_image'] : null;

    const target: GhcrDeployTarget = {
      host: cfg.host,
      deployRoot: cfg.deployRoot,
      ...(cfg.sshPort !== undefined && { port: cfg.sshPort }),
      ...(cfg.identityFile !== undefined && { identityFile: cfg.identityFile }),
    };

    const samples: { ok: boolean; ms: number }[] = [];
    const deadline = Date.now() + window * 1000;
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const probe = await httpProbe(liveUrl, 5_000);
      samples.push({ ok: probe.ok, ms: probe.latencyMs ?? 5_000 });

      const errorRatePct = (samples.filter((s) => !s.ok).length / samples.length) * 100;
      const p99Now = percentile(samples.map((s) => s.ms), 0.99) ?? 0;
      if (samples.length === 1 || samples.length % 5 === 0) {
        this.emit(ctx, 'progress', {
          phase: 'observe.probe',
          probe_count: samples.length,
          error_rate_pct: Number(errorRatePct.toFixed(2)),
          p99_ms: p99Now,
          ok: probe.ok,
        });
      }
      await this.sleep(5_000, ctx.signal);
    }

    const failures = samples.filter((s) => !s.ok).length;
    const errorRatePct = samples.length === 0 ? 0 : (failures / samples.length) * 100;
    const p99 = percentile(samples.map((s) => s.ms), 0.99) ?? 0;
    const errorThreshold = cfg.thresholdErrorRatePct ?? 5;
    const p99Threshold = cfg.thresholdP99Ms ?? 1500;

    this.emit(ctx, 'progress', {
      phase: 'vps.bake_summary',
      samples: samples.length,
      error_rate_pct: errorRatePct,
      p99_ms: p99,
    });

    if (errorRatePct > errorThreshold || p99 > p99Threshold) {
      const reason = `bake breach: error_rate=${errorRatePct.toFixed(1)}% (>${errorThreshold}%) or p99=${p99}ms (>${p99Threshold}ms)`;
      this.emit(ctx, 'progress', { phase: 'observe.breach', reason });
      if (previousImage) {
        this.emit(ctx, 'progress', { phase: 'vps.ghcr.rollback', to_image: previousImage, reason });
        const rb = await rollbackComposeImage(target, cfg.deployRoot, previousImage, cfg.composeService ?? 'web');
        if (!rb.ok) {
          ctx.store.updateRun(ctx.run.id, { outcomeReason: `${reason}; rollback failed: ${rb.stderr.trim().slice(0, 120)}`, completedAt: new Date() });
          throw new RollbackTriggeredError(reason, 'observe');
        }
        this.emit(ctx, 'progress', { phase: 'rollback.done', restored_image: previousImage });
      } else {
        this.emit(ctx, 'progress', { phase: 'rollback.skipped', note: 'no previous image recorded' });
      }
      ctx.store.updateRun(ctx.run.id, { status: 'rolled_back', completedAt: new Date(), outcomeReason: reason });
      const updated = ctx.store.getRun(ctx.run.id);
      if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
      throw new RollbackTriggeredError(reason, 'observe');
    }

    const result = {
      window_seconds: window,
      slo_healthy: true,
      observations: { p99_ms: p99, error_rate_pct: errorRatePct, samples: samples.length },
    };
    this.emit(ctx, 'finished', result);
    return result;
  }
}

function percentile(latencies: number[], q: number): number | undefined {
  if (latencies.length === 0) return undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

export function defaultStages(): Stage[] {
  // Order matters: rehearse runs BEFORE author so no PR is opened and no
  // repo state is mutated until Convoy has proof the service boots and
  // responds healthy. The operator approves opening the PR with rehearsal
  // evidence on-screen, then approves merging the PR after reviewing it on
  // GitHub. Previously author ran first and could merge before rehearsal,
  // which meant a rehearsal failure could leave the repo in a merged-but-
  // undeployed state.
  return [
    new ScanStage(),
    new PickStage(),
    new RehearseStage(),
    new AuthorStage(),
    new CanaryStage(),
    new PromoteStage(),
    new ObserveStage(),
  ];
}
