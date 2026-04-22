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
import type { ConvoyBus } from './bus.js';
import {
  createPrFromAuthoredFiles,
  detectRepo,
  gitHubAuthStatus,
  mergePr,
  prStatus,
  type GitRepoContext,
} from './github-runner.js';
import { diagnose } from './medic.js';
import { RehearsalRunner, type MetricsSnapshot } from './rehearsal-runner.js';
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
  realRehearsal?: RealRehearsalOpt;
  realAuthor?: RealAuthorOpt;
  realFly?: RealFlyOpt;
  realVercel?: RealVercelOpt;
}

export interface RealAuthorOpt {
  repoPath: string;
  authoredFiles: { path: string; contentPreview: string; summary?: string }[];
  prTitle: string;
  prBody: string;
  mergeOnApproval: boolean;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
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
  repoPath: string;
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
}

export type InjectFailureOpt = {
  stage: 'rehearse' | 'canary';
  kind: 'latency' | 'error-rate' | 'build';
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

  protected emit(ctx: StageContext, kind: EventKind, payload: unknown): RunEvent {
    const event = ctx.store.appendEvent(ctx.run.id, this.name, kind, payload);
    ctx.bus.emit({ type: 'event.appended', event });
    return event;
  }

  protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleep(ms, signal);
  }

  protected async awaitApproval(
    ctx: StageContext,
    kind: ApprovalKind,
    summary: unknown,
  ): Promise<Approval> {
    const approval = ctx.store.requestApproval(ctx.run.id, kind, summary);
    ctx.bus.emit({ type: 'approval.requested', approval });
    this.emit(ctx, 'progress', { awaiting_approval: kind, approval_id: approval.id });

    const autoApprove = ctx.opts.autoApprove ?? true;
    if (autoApprove) {
      await this.sleep(400, ctx.signal);
      const decided = ctx.store.decideApproval(approval.id, 'approved');
      ctx.bus.emit({ type: 'approval.decided', approval: decided });
      return decided;
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
}

export class ScanStage extends BaseStage {
  readonly name = 'scan' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', { repo_url: ctx.run.repoUrl });
    await this.sleep(800, ctx.signal);
    const signals = {
      language: 'typescript',
      runtime: 'node-20',
      framework: 'next.js',
      topology: 'web+worker',
      data: ['postgres'],
      hints: { has_dockerfile: false, has_ci: true },
    };
    this.emit(ctx, 'finished', { signals });
    return signals;
  }
}

export class PickStage extends BaseStage {
  readonly name = 'pick' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', {});
    await this.sleep(300, ctx.signal);

    const chosen: Platform = ctx.opts.platformOverride ?? 'fly';
    const rankings = [
      { platform: 'fly', score: 94, reason: 'container + worker + regions' },
      { platform: 'railway', score: 91, reason: 'managed postgres + monorepo' },
      { platform: 'cloudrun', score: 82, reason: 'serious infra, VPC, IAM' },
      { platform: 'vercel', score: 54, reason: 'worker disqualifies frontend-first' },
    ];
    const decision = {
      chosen,
      reason:
        ctx.opts.platformOverride !== undefined
          ? `respecting explicit --platform=${chosen} override`
          : `${chosen} scored highest for web+worker + postgres topology`,
      rankings,
    };

    ctx.store.updateRun(ctx.run.id, { platform: chosen });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    this.emit(ctx, 'decision', decision);
    this.emit(ctx, 'finished', decision);
    return decision;
  }
}

export class AuthorStage extends BaseStage {
  readonly name = 'author' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realAuthor) {
      return this.#runReal(ctx, ctx.opts.realAuthor);
    }

    this.emit(ctx, 'started', {});
    await this.sleep(1200, ctx.signal);

    const files = ['Dockerfile', 'fly.toml', '.env.schema', '.convoy/manifest.yaml'];
    const prUrl = `https://github.com/placeholder/pr-for-${ctx.run.id.slice(0, 7)}`;

    this.emit(ctx, 'progress', { stage: 'pr_opened', files, pr_url: prUrl });

    await this.awaitApproval(ctx, 'merge_pr', {
      pr_url: prUrl,
      files,
      note: 'No developer code modified. Only Convoy-authored deployment surface.',
    });

    const result = { pr_url: prUrl, files, merged: true };
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

    let pr;
    try {
      pr = await createPrFromAuthoredFiles(
        repo,
        ctx.run.id,
        cfg.authoredFiles.map((f) => ({ path: f.path, contentPreview: f.contentPreview })),
        cfg.prTitle,
        cfg.prBody,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PR creation failed: ${message}`);
    }

    this.emit(ctx, 'progress', {
      phase: 'pr.opened',
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
    });

    await this.awaitApproval(ctx, 'merge_pr', {
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
      note: 'Only Convoy-authored deployment files were committed. Source code is untouched.',
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
    if (ctx.opts.realRehearsal) {
      return this.#runReal(ctx, ctx.opts.realRehearsal);
    }

    this.emit(ctx, 'started', {});
    this.emit(ctx, 'progress', { phase: 'ephemeral.creating' });
    await this.sleep(1200, ctx.signal);

    const ephemeralUrl = `https://convoy-rehearsal-${ctx.run.id.slice(0, 6)}.fly.dev`;
    this.emit(ctx, 'progress', { phase: 'ephemeral.ready', url: ephemeralUrl });
    await this.sleep(400, ctx.signal);

    this.emit(ctx, 'progress', { phase: 'smoke_tests.passed', count: 8 });
    await this.sleep(500, ctx.signal);

    const inject = ctx.opts.injectFailure;
    if (inject && inject.stage === 'rehearse') {
      this.emit(ctx, 'progress', {
        phase: 'synthetic_load.breach',
        p99_ms: 494,
        error_rate_pct: 6.67,
        threshold_error_rate_pct: 1.0,
      });
      await this.sleep(300, ctx.signal);

      const logs = await loadInjectedLogs(inject);

      this.emit(ctx, 'progress', { phase: 'medic.invoked' });

      const diagnosis = await diagnose({
        stage: 'rehearse',
        phase: 'synthetic_load',
        repoPath: inject.repoPath ?? '.',
        convoyAuthoredFiles: inject.convoyAuthoredFiles ?? [],
        logs,
        metrics: { p99_ms: 494, p95_ms: 410, error_rate_pct: 6.67, count: 90 },
        errorMessage: 'synthetic load breached error-rate tolerance (6.67% > 1%)',
      });

      this.emit(ctx, 'diagnosis', diagnosis);
      this.emit(ctx, 'progress', { phase: 'ephemeral.destroying' });
      await this.sleep(300, ctx.signal);

      throw new RehearsalBreachError(diagnosis);
    }

    this.emit(ctx, 'progress', { phase: 'synthetic_load.passed', p99_ms: 142 });
    await this.sleep(400, ctx.signal);

    this.emit(ctx, 'progress', { phase: 'ephemeral.destroying' });
    await this.sleep(300, ctx.signal);

    const result = {
      healthy: true,
      p99_ms: 142,
      smoke_tests_passed: 8,
      new_error_fingerprints: 0,
      ephemeral_url: ephemeralUrl,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runReal(ctx: StageContext, cfg: RealRehearsalOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-local', target: cfg.repoPath });

    const runner = new RehearsalRunner(
      {
        repoPath: cfg.repoPath,
        startCommand: cfg.startCommand,
        port: cfg.port,
        healthPath: cfg.healthPath,
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
      });
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

export class CanaryStage extends BaseStage {
  readonly name = 'canary' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel);
    }

    this.emit(ctx, 'started', {});

    await this.awaitApproval(ctx, 'promote', {
      note: 'Rehearsal clean. Promote to canary at 5% traffic?',
      bake_window_seconds: 120,
    });

    this.emit(ctx, 'progress', { traffic_split_percent: 5 });
    await this.sleep(1200, ctx.signal);

    this.emit(ctx, 'progress', {
      baseline_comparison: { p99_delta_ms: 3, error_rate_delta_pct: 0.0 },
    });
    await this.sleep(400, ctx.signal);

    const result = {
      healthy: true,
      traffic_split_percent: 5,
      p99_delta_ms: 3,
      error_rate_delta_pct: 0.0,
    };
    this.emit(ctx, 'finished', result);
    return result;
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
      });
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
      });
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

    this.emit(ctx, 'started', {});

    for (const pct of [10, 25, 50, 100]) {
      this.emit(ctx, 'progress', { traffic_split_percent: pct });
      await this.sleep(450, ctx.signal);
    }

    const liveUrl = `https://convoy-demo-${ctx.run.id.slice(0, 6)}.fly.dev`;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const result = { live_url: liveUrl, release: 'v1' };
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
}

function percentile(latencies: number[], q: number): number | undefined {
  if (latencies.length === 0) return undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

export function defaultStages(): Stage[] {
  return [
    new ScanStage(),
    new PickStage(),
    new AuthorStage(),
    new RehearseStage(),
    new CanaryStage(),
    new PromoteStage(),
    new ObserveStage(),
  ];
}
