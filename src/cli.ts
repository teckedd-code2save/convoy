#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import { resolve } from 'node:path';

import { ConvoyBus, type ConvoyBusEvent } from './core/bus.js';
import { Orchestrator } from './core/orchestrator.js';
import { PlanStore, renderPlan } from './core/plan.js';
import { defaultStages, type OrchestratorOpts } from './core/stages.js';
import { RunStateStore } from './core/state.js';
import type { Platform, Run, RunEvent, StageName } from './core/types.js';
import { buildPlan } from './planner/index.js';

const STATE_PATH = process.env['CONVOY_STATE_PATH'] ?? '.convoy/state.db';
const PLANS_DIR = process.env['CONVOY_PLANS_DIR'] ?? '.convoy/plans';
const SUPPORTED_PLATFORMS: readonly Platform[] = ['fly', 'railway', 'vercel', 'cloudrun'];

const SYMBOL = {
  run: '◆',
  stage: '▸',
  ok: '✓',
  fail: '✗',
  bullet: '·',
  decision: '→',
  pause: '⏸',
} as const;

function isPlatform(value: string): value is Platform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function compact(payload: unknown, limit = 4): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload !== 'object') return String(payload);
  if (Array.isArray(payload)) return `[${payload.length} items]`;

  const entries = Object.entries(payload as Record<string, unknown>);
  return entries
    .slice(0, limit)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(' ');
}

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return '{...}';
  return typeof value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function renderRunEvent(event: RunEvent): void {
  switch (event.kind) {
    case 'started':
      process.stdout.write(`\n${pc.cyan(SYMBOL.stage)} ${pc.bold(event.stage)}\n`);
      return;
    case 'finished':
      process.stdout.write(`  ${pc.green(SYMBOL.ok)} ${pc.dim(compact(event.payload))}\n`);
      return;
    case 'failed':
      process.stdout.write(`  ${pc.red(SYMBOL.fail)} ${compact(event.payload)}\n`);
      return;
    case 'progress':
      process.stdout.write(`  ${pc.dim(SYMBOL.bullet)} ${pc.dim(compact(event.payload))}\n`);
      return;
    case 'decision':
      process.stdout.write(`  ${pc.cyan(SYMBOL.decision)} ${compact(event.payload, 2)}\n`);
      return;
    case 'diagnosis':
      process.stdout.write(`  ${pc.yellow('!')} ${compact(event.payload)}\n`);
      return;
    case 'log':
      process.stdout.write(`  ${pc.dim('|')} ${pc.dim(compact(event.payload))}\n`);
      return;
  }
}

function attachRenderer(bus: ConvoyBus, startedAt: Date): () => void {
  return bus.subscribe((e: ConvoyBusEvent) => {
    switch (e.type) {
      case 'run.created': {
        const head = `${pc.bold(pc.cyan(SYMBOL.run))} ${pc.bold(`Convoy run ${e.run.id.slice(0, 8)} started`)}`;
        process.stdout.write(`${head}\n  ${pc.dim('Repository:')} ${e.run.repoUrl}\n`);
        return;
      }
      case 'run.updated': {
        if (e.run.status === 'succeeded') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(
            `\n${pc.bold(pc.green(SYMBOL.run))} ${pc.bold(pc.green(`Convoy succeeded in ${formatDuration(ms)}`))}\n`,
          );
          if (e.run.liveUrl) {
            process.stdout.write(`  ${pc.dim('Live URL:')} ${pc.cyan(e.run.liveUrl)}\n`);
          }
        } else if (e.run.status === 'failed') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(
            `\n${pc.bold(pc.red(SYMBOL.run))} ${pc.bold(pc.red(`Convoy failed after ${formatDuration(ms)}`))}\n`,
          );
        }
        return;
      }
      case 'event.appended':
        renderRunEvent(e.event);
        return;
      case 'approval.requested':
        process.stdout.write(
          `  ${pc.yellow(SYMBOL.pause)} ${pc.yellow(`awaiting ${e.approval.kind} approval`)}\n`,
        );
        return;
      case 'approval.decided': {
        const mark = e.approval.status === 'approved' ? pc.green(SYMBOL.ok) : pc.red(SYMBOL.fail);
        process.stdout.write(`  ${mark} ${pc.dim(`${e.approval.kind} ${e.approval.status}`)}\n`);
        return;
      }
    }
  });
}

interface ShipOpts {
  platform?: string;
  live?: boolean;
  autoApprove: boolean;
}

async function runShip(repoUrl: string, opts: ShipOpts): Promise<void> {
  if (opts.live) {
    console.error(pc.yellow('--live is not supported yet in the hackathon scaffold. Running dry-run.'));
  }
  let platformOverride: Platform | undefined;
  if (opts.platform !== undefined) {
    if (!isPlatform(opts.platform)) {
      console.error(
        pc.red(
          `Unknown platform "${opts.platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
        ),
      );
      process.exit(2);
    }
    platformOverride = opts.platform;
  }

  const store = new RunStateStore(STATE_PATH);
  const bus = new ConvoyBus();
  const stages = defaultStages();
  const orchestrator = new Orchestrator(store, bus, stages);

  const startedAt = new Date();
  const unsubscribe = attachRenderer(bus, startedAt);

  const orchestratorOpts: OrchestratorOpts = {
    dryRun: true,
    autoApprove: opts.autoApprove,
    ...(platformOverride !== undefined && { platformOverride }),
  };

  try {
    await orchestrator.run(repoUrl, orchestratorOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`\nrun terminated: ${message}`));
    process.exitCode = 1;
  } finally {
    unsubscribe();
    store.close();
  }
}

interface PlanOpts {
  platform?: string;
  repoUrl?: string;
  save?: boolean;
  json?: boolean;
}

async function runPlan(path: string, opts: PlanOpts): Promise<void> {
  let platformOverride: Platform | undefined;
  if (opts.platform !== undefined) {
    if (!isPlatform(opts.platform)) {
      console.error(
        pc.red(
          `Unknown platform "${opts.platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
        ),
      );
      process.exit(2);
    }
    platformOverride = opts.platform;
  }

  const absPath = resolve(path);
  try {
    const plan = buildPlan(absPath, {
      ...(opts.repoUrl !== undefined && { repoUrl: opts.repoUrl }),
      ...(platformOverride !== undefined && { platformOverride }),
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderPlan(plan)}\n`);
    }

    if (opts.save) {
      const store = new PlanStore(PLANS_DIR);
      const saved = store.save(plan);
      process.stdout.write(`\n${pc.dim('Saved plan to')} ${saved}\n`);
      process.stdout.write(
        `${pc.dim('Apply with')} ${pc.bold(`convoy apply ${plan.id}`)} ${pc.dim('(not yet implemented)')}\n`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`plan failed: ${message}`));
    process.exitCode = 1;
  }
}

async function runStatus(runId?: string): Promise<void> {
  const store = new RunStateStore(STATE_PATH);
  try {
    const run: Run | null = runId
      ? store.getRun(runId)
      : (store.listRecentRuns(1)[0] ?? null);

    if (!run) {
      console.error(pc.yellow('No runs found.'));
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${pc.bold(pc.cyan(SYMBOL.run))} ${pc.bold(`Run ${run.id.slice(0, 8)}`)} ${pc.dim(`(${run.status})`)}\n`,
    );
    process.stdout.write(`  ${pc.dim('Repository:')} ${run.repoUrl}\n`);
    if (run.platform) process.stdout.write(`  ${pc.dim('Platform:')}   ${run.platform}\n`);
    if (run.liveUrl) process.stdout.write(`  ${pc.dim('Live URL:')}   ${pc.cyan(run.liveUrl)}\n`);
    process.stdout.write(`  ${pc.dim('Started:')}    ${run.startedAt.toISOString()}\n`);
    if (run.completedAt) {
      process.stdout.write(
        `  ${pc.dim('Completed:')}  ${run.completedAt.toISOString()} (${formatDuration(
          run.completedAt.getTime() - run.startedAt.getTime(),
        )})\n`,
      );
    }

    const events = store.listEvents(run.id);
    const perStage = new Map<StageName, { started: boolean; finished: boolean; failed: boolean }>();
    for (const event of events) {
      const entry = perStage.get(event.stage) ?? { started: false, finished: false, failed: false };
      if (event.kind === 'started') entry.started = true;
      if (event.kind === 'finished') entry.finished = true;
      if (event.kind === 'failed') entry.failed = true;
      perStage.set(event.stage, entry);
    }

    const order: StageName[] = ['scan', 'pick', 'author', 'rehearse', 'canary', 'promote', 'observe'];
    process.stdout.write(`\n  ${pc.dim('Stages')}\n`);
    for (const name of order) {
      const entry = perStage.get(name);
      const marker = entry?.failed
        ? pc.red(SYMBOL.fail)
        : entry?.finished
          ? pc.green(SYMBOL.ok)
          : entry?.started
            ? pc.yellow(SYMBOL.bullet)
            : pc.dim(SYMBOL.bullet);
      process.stdout.write(`  ${marker} ${name}\n`);
    }

    const pending = store.listPendingApprovals(run.id);
    if (pending.length > 0) {
      process.stdout.write(`\n  ${pc.yellow('Pending approvals:')}\n`);
      for (const approval of pending) {
        process.stdout.write(`  ${pc.yellow(SYMBOL.pause)} ${approval.kind} (${approval.id.slice(0, 8)})\n`);
      }
    }
  } finally {
    store.close();
  }
}

const program = new Command()
  .name('convoy')
  .description('Deployment agent that rehearses, ships, and observes — without touching your code.')
  .version('0.0.1');

program
  .command('ship <repoUrl>')
  .description('Drive a deployment from repository to production (dry-run only in the scaffold).')
  .option('--platform <platform>', 'explicit platform choice: fly | railway | vercel | cloudrun')
  .option('--live', 'run real deploys (not yet supported)')
  .option('--no-auto-approve', 'wait for external approval decisions instead of auto-approving in dry-run')
  .action(async (repoUrl: string, options: { platform?: string; live?: boolean; autoApprove: boolean }) => {
    await runShip(repoUrl, options);
  });

program
  .command('plan <path>')
  .description('Produce an inspectable plan of what `convoy apply` would do. Reads the target path; does not write or deploy anything.')
  .option('--platform <platform>', 'explicit platform choice: fly | railway | vercel | cloudrun')
  .option('--repo-url <url>', 'annotate the plan with a remote repo URL (does not fetch)')
  .option('--save', 'persist the plan to .convoy/plans/<id>.json', false)
  .option('--json', 'output the raw plan as JSON instead of the human-readable render', false)
  .action(async (path: string, options: { platform?: string; repoUrl?: string; save?: boolean; json?: boolean }) => {
    await runPlan(path, options);
  });

program
  .command('status [runId]')
  .description('Show the status of a run (defaults to most recent).')
  .action(async (runId?: string) => {
    await runStatus(runId);
  });

program
  .command('rollback <service>')
  .description('Roll back the most recent deployment for a service (not yet implemented).')
  .action((service: string) => {
    console.error(pc.yellow(`rollback ${service}: not yet implemented`));
    process.exit(2);
  });

await program.parseAsync();
