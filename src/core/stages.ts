import type { ConvoyBus } from './bus.js';
import { diagnose } from './medic.js';
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

    if (ctx.opts.dryRun && (ctx.opts.autoApprove ?? true)) {
      await this.sleep(400, ctx.signal);
      const decided = ctx.store.decideApproval(approval.id, 'approved');
      ctx.bus.emit({ type: 'approval.decided', approval: decided });
      return decided;
    }

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
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
    throw new Error(`Approval ${kind} timed out`);
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
}

export class RehearseStage extends BaseStage {
  readonly name = 'rehearse' as const;

  override async run(ctx: StageContext): Promise<unknown> {
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
}

export class PromoteStage extends BaseStage {
  readonly name = 'promote' as const;

  override async run(ctx: StageContext): Promise<unknown> {
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
}

export class ObserveStage extends BaseStage {
  readonly name = 'observe' as const;

  override async run(ctx: StageContext): Promise<unknown> {
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
