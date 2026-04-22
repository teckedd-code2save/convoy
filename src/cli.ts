#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import { resolve } from 'node:path';

import { existsSync, readFileSync } from 'node:fs';

import { ConvoyBus, type ConvoyBusEvent } from './core/bus.js';
import { Orchestrator } from './core/orchestrator.js';
import { PlanStore, renderPlan, type ConvoyPlan } from './core/plan.js';
import {
  defaultStages,
  type OrchestratorOpts,
  type RealAuthorOpt,
  type RealFlyOpt,
  type RealRehearsalOpt,
} from './core/stages.js';
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
        } else if (e.run.status === 'awaiting_fix') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(
            `\n${pc.bold(pc.yellow(SYMBOL.pause))} ${pc.bold(pc.yellow(`Paused after ${formatDuration(ms)} — awaiting developer fix`))}\n`,
          );
          process.stdout.write(
            `  ${pc.dim('Medic diagnosed a code-level failure. Fix your code, push the commit, and re-run \`convoy apply\`.')}\n`,
          );
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
  noAi?: boolean;
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
  const thinking = opts.json ? null : startThinking();
  try {
    const { plan, enrichmentSource } = await buildPlan(absPath, {
      ...(opts.repoUrl !== undefined && { repoUrl: opts.repoUrl }),
      ...(platformOverride !== undefined && { platformOverride }),
      ai: opts.noAi ? { disable: true } : {},
    });
    thinking?.stop();

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderPlan(plan)}\n`);
      process.stdout.write(`\n${pc.dim(`Narrative source: ${enrichmentSource}`)}\n`);
    }

    if (opts.save) {
      const store = new PlanStore(PLANS_DIR);
      const saved = store.save(plan);
      process.stdout.write(`\n${pc.dim('Saved plan to')} ${saved}\n`);
      process.stdout.write(
        `${pc.dim('Apply with')} ${pc.bold(`npm run convoy -- apply ${plan.id.slice(0, 8)}`)}\n`,
      );
    }
  } catch (err) {
    thinking?.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`plan failed: ${message}`));
    process.exitCode = 1;
  }
}

function startThinking(): { stop: () => void } {
  if (!process.stdout.isTTY) return { stop: () => {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${pc.cyan(frames[i % frames.length])} ${pc.dim('analyzing repo...')}`);
    i += 1;
  }, 80);
  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

interface ApplyOpts {
  autoApprove: boolean;
  realRehearsal?: boolean;
  realAuthor?: boolean;
  autoMerge?: boolean;
  mergeMethod?: string;
  realFly?: boolean;
  flyApp?: string;
  flyOrg?: string;
  flyCreateApp?: boolean;
  flyStrategy?: string;
  flySecretsFile?: string;
  flyBakeWindow?: number;
  injectFailure?: string;
  logs?: string;
  envFile?: string;
  probePath?: string[];
  probeRequests?: number;
  probeConcurrency?: number;
  env?: Record<string, string>;
}

async function runApply(planId: string, opts: ApplyOpts): Promise<void> {
  const plans = new PlanStore(PLANS_DIR);
  const plan = resolvePlan(plans, planId);

  if (!plan) {
    console.error(pc.red(`Plan not found: ${planId}`));
    console.error(pc.dim(`Looked in ${PLANS_DIR}. Run \`convoy plans\` to list saved plans.`));
    process.exit(2);
  }

  if (plan.deployability.verdict === 'not-cloud-deployable') {
    console.error(
      pc.red(`Plan ${plan.id.slice(0, 8)} is not deployable: ${plan.deployability.reason}`),
    );
    process.exit(2);
  }

  process.stdout.write(
    `${pc.dim('Applying plan')} ${pc.bold(plan.id.slice(0, 8))} ${pc.dim('—')} ${plan.target.name} ${pc.dim('→')} ${pc.cyan(plan.platform.chosen)}\n`,
  );
  if (plan.target.readmeTitle) {
    process.stdout.write(`${pc.dim(`  "${plan.target.readmeTitle}"`)}\n`);
  }
  process.stdout.write(`${pc.dim(`  ${plan.author.convoyAuthoredFiles.length} file(s) to author · rehearse before production`)}\n`);

  const store = new RunStateStore(STATE_PATH);
  const bus = new ConvoyBus();
  const stages = defaultStages();
  const orchestrator = new Orchestrator(store, bus, stages);

  const startedAt = new Date();
  const unsubscribe = attachRenderer(bus, startedAt);

  const orchestratorOpts: OrchestratorOpts = {
    dryRun: !opts.realRehearsal,
    autoApprove: opts.autoApprove,
    platformOverride: plan.platform.chosen,
    planId: plan.id,
  };

  if (opts.injectFailure === 'rehearse' || opts.injectFailure === 'canary') {
    orchestratorOpts.injectFailure = {
      stage: opts.injectFailure,
      kind: 'error-rate',
      repoPath: plan.target.localPath,
      convoyAuthoredFiles: plan.author.convoyAuthoredFiles.map((f) => f.path),
      ...(opts.logs !== undefined && { logsPath: opts.logs }),
    };
  }

  if (opts.realRehearsal) {
    const real = buildRealRehearsalOpts(plan, opts);
    if (!real) {
      console.error(pc.red('Could not build a real rehearsal config from this plan — missing start command.'));
      process.exit(2);
    }
    orchestratorOpts.realRehearsal = real;
    process.stdout.write(
      `${pc.dim('Real rehearsal:')} ${pc.bold(`${real.startCommand}`)} on port ${real.port}\n`,
    );
  }

  if (opts.realAuthor) {
    if (plan.author.convoyAuthoredFiles.length === 0) {
      console.error(pc.yellow('--real-author: nothing to author (plan has no Convoy-authored files).'));
    } else {
      const method = (opts.mergeMethod === 'merge' || opts.mergeMethod === 'squash' || opts.mergeMethod === 'rebase')
        ? opts.mergeMethod
        : 'squash';
      const realAuthor: RealAuthorOpt = {
        repoPath: plan.target.localPath,
        authoredFiles: plan.author.convoyAuthoredFiles.map((f) => ({
          path: f.path,
          contentPreview: f.contentPreview,
          summary: f.summary,
        })),
        prTitle: `convoy: deploy plumbing for ${plan.platform.chosen}`,
        prBody: buildPrBody(plan),
        mergeOnApproval: opts.autoMerge === true,
        mergeMethod: method,
      };
      orchestratorOpts.realAuthor = realAuthor;
      process.stdout.write(
        `${pc.dim('Real author:')} PR against ${pc.bold(plan.target.localPath)} ${opts.autoMerge ? pc.dim(`(auto-merge: ${method})`) : pc.dim('(manual merge)')}\n`,
      );
    }
  }

  if (opts.realFly) {
    if (plan.platform.chosen !== 'fly') {
      console.error(
        pc.red(
          `--real-fly requires the plan to target fly (this plan picked ${plan.platform.chosen}). Pass --platform=fly during plan or change targets.`,
        ),
      );
      process.exit(2);
    }
    if (!opts.flyApp) {
      console.error(pc.red('--real-fly requires --fly-app=<name>.'));
      process.exit(2);
    }
    const strategy = (opts.flyStrategy === 'canary' || opts.flyStrategy === 'rolling' || opts.flyStrategy === 'bluegreen' || opts.flyStrategy === 'immediate')
      ? opts.flyStrategy
      : 'canary';
    const secretsPath = opts.flySecretsFile ?? `${plan.target.localPath}/.env.convoy-secrets`;
    const secrets = existsSync(secretsPath) ? parseEnvFile(secretsPath) : {};

    const realFly: RealFlyOpt = {
      appName: opts.flyApp,
      cwd: plan.target.localPath,
      strategy,
      createIfMissing: opts.flyCreateApp === true,
      convoyAuthoredFiles: plan.author.convoyAuthoredFiles.map((f) => f.path),
      thresholdErrorRatePct: 1.0,
      thresholdP99Ms: 1000,
      bakeWindowSeconds: opts.flyBakeWindow ?? 60,
    };
    if (opts.flyOrg) realFly.org = opts.flyOrg;
    if (Object.keys(secrets).length > 0) realFly.secrets = secrets;
    orchestratorOpts.realFly = realFly;
    process.stdout.write(
      `${pc.dim('Real Fly deploy:')} ${pc.bold(opts.flyApp)} ${pc.dim(`(strategy: ${strategy}, bake: ${realFly.bakeWindowSeconds}s, secrets: ${Object.keys(secrets).length})`)}\n`,
    );
  }

  const repoUrl = plan.target.repoUrl ?? plan.target.localPath;
  try {
    const run = await orchestrator.run(repoUrl, orchestratorOpts);
    attachPlanReference(store, run.id, plan.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`\nrun terminated: ${message}`));
    process.exitCode = 1;
  } finally {
    unsubscribe();
    store.close();
  }
}

function buildPrBody(plan: ConvoyPlan): string {
  const files = plan.author.convoyAuthoredFiles
    .map((f) => `- \`${f.path}\` — ${f.summary}`)
    .join('\n');
  return `Generated by [Convoy](https://github.com/teckedd-code2save/convoy) from plan \`${plan.id.slice(0, 8)}\`.

## What changed

This PR adds deployment-surface files only. **Application source code was not modified.**

${files}

## Pipeline that follows the merge

Once this merges, Convoy will:

1. Rehearse on ${plan.rehearsal.targetDescriptor} — ${plan.rehearsal.validations.slice(0, 2).join('; ')}
2. Promote through canary → 10% → 25% → 50% → 100% if rehearsal is clean
3. Auto-rollback via \`${plan.rollback.strategy}\` (~${plan.rollback.estimatedSeconds}s) if anything breaches

## Safety

- Rollback is pre-staged; forward progress only happens with a named reverse ready.
- No irreversible actions without human approval.
- Convoy never modifies files outside the list above.

_Platform chosen: ${plan.platform.chosen} (${plan.platform.source})_
`;
}

function buildRealRehearsalOpts(plan: ConvoyPlan, opts: ApplyOpts): RealRehearsalOpt | null {
  const rehearsal = plan.rehearsal;
  const startCommand = rehearsal.startCommand;
  if (!startCommand) return null;

  const port = rehearsal.expectedPort ?? 8080;
  const healthPath = '/health';
  const metricsPath = '/metrics';
  const installCommand = detectInstallCommand(plan);
  const buildCommand = rehearsal.buildCommand ?? undefined;

  const envFilePath = opts.envFile ?? `${plan.target.localPath}/.env.convoy-rehearsal`;
  const fileEnv = existsSync(envFilePath) ? parseEnvFile(envFilePath) : {};
  const env: Record<string, string> = { ...fileEnv, ...(opts.env ?? {}) };

  const userProbePaths = opts.probePath && opts.probePath.length > 0 ? opts.probePath : null;
  const probePaths = userProbePaths ?? [healthPath];

  const result: RealRehearsalOpt = {
    repoPath: plan.target.localPath,
    startCommand,
    port,
    healthPath,
    metricsPath,
    convoyAuthoredFiles: plan.author.convoyAuthoredFiles.map((f) => f.path),
    probeRequests: opts.probeRequests ?? 60,
    probeConcurrency: opts.probeConcurrency ?? 4,
    probePaths,
    maxErrorRatePct: 1.0,
    maxP99Ms: 500,
  };
  if (installCommand) result.installCommand = installCommand;
  if (buildCommand) result.buildCommand = buildCommand;
  if (Object.keys(env).length > 0) result.env = env;
  return result;
}

function detectInstallCommand(plan: ConvoyPlan): string | null {
  const path = plan.target.localPath;
  if (existsSync(`${path}/pnpm-lock.yaml`)) return 'pnpm install --frozen-lockfile';
  if (existsSync(`${path}/yarn.lock`)) return 'yarn install --frozen-lockfile';
  if (existsSync(`${path}/bun.lockb`) || existsSync(`${path}/bun.lock`)) return 'bun install --frozen-lockfile';
  if (existsSync(`${path}/package-lock.json`)) return 'npm ci';
  if (existsSync(`${path}/requirements.txt`)) return 'pip install -r requirements.txt';
  if (existsSync(`${path}/pyproject.toml`)) return 'pip install .';
  return null;
}

function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

function resolvePlan(plans: PlanStore, idOrPrefix: string): ConvoyPlan | null {
  const exact = plans.load(idOrPrefix);
  if (exact) return exact;
  for (const id of plans.listRecent(50)) {
    if (id.startsWith(idOrPrefix)) {
      const match = plans.load(id);
      if (match) return match;
    }
  }
  return null;
}

function attachPlanReference(store: RunStateStore, runId: string, planId: string): void {
  store.appendEvent(runId, 'scan', 'log', { plan_id: planId, note: 'applied from saved plan' });
}

function runListPlans(): void {
  const plans = new PlanStore(PLANS_DIR);
  const ids = plans.listRecent(20);
  if (ids.length === 0) {
    console.error(pc.yellow('No saved plans found. Run `convoy plan <path> --save` to create one.'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${pc.bold('Recent plans')}\n`);
  for (const id of ids) {
    const plan = plans.load(id);
    if (!plan) continue;
    const short = id.slice(0, 8);
    const name = plan.target.name;
    const platform = plan.platform.chosen;
    const verdict = plan.deployability.verdict === 'not-cloud-deployable' ? pc.red('refused') : pc.green(platform);
    process.stdout.write(`  ${pc.bold(short)}  ${name.padEnd(22)}  ${verdict}  ${pc.dim(plan.createdAt)}\n`);
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
  .option('--no-ai', 'skip the Opus narrative pass and use the deterministic output')
  .action(async (path: string, options: PlanOpts) => {
    await runPlan(path, options);
  });

program
  .command('status [runId]')
  .description('Show the status of a run (defaults to most recent).')
  .action(async (runId?: string) => {
    await runStatus(runId);
  });

program
  .command('apply <planId>')
  .description('Execute a saved plan. Reads .convoy/plans/<planId>.json and runs the pipeline.')
  .option('--no-auto-approve', 'wait for external approval decisions instead of auto-approving')
  .option('--real-author', 'open a real PR against the target\'s GitHub repo (requires gh auth + write access)')
  .option('--auto-merge', 'when --real-author is set, merge the PR automatically on approval (otherwise waits for manual merge)')
  .option('--merge-method <method>', 'PR merge method: merge | squash | rebase (default: squash)')
  .option('--real-fly', 'deploy to Fly.io for real — canary/promote/observe stages call flyctl')
  .option('--fly-app <name>', 'Fly.io app name (required with --real-fly)')
  .option('--fly-org <org>', 'Fly.io organization (default: personal)')
  .option('--fly-create-app', 'create the Fly app if it does not exist')
  .option('--fly-strategy <s>', 'deploy strategy: canary | rolling | bluegreen | immediate (default: canary)')
  .option('--fly-secrets-file <path>', 'env-style file of secrets to stage via `fly secrets set` (default: <target>/.env.convoy-secrets)')
  .option('--fly-bake-window <seconds>', 'observe-stage bake window in seconds (default: 60)', (v) => Number(v))
  .option('--real-rehearsal', 'run the target locally as a subprocess, probe real metrics, feed real logs to medic')
  .option('--inject-failure <where>', 'inject a demo failure: rehearse|canary (triggers medic with fixture logs)')
  .option('--logs <path>', 'path to a file of log lines to feed medic when injecting a failure')
  .option('--env-file <path>', 'env file to load into the subprocess during --real-rehearsal (default: target repo\'s .env.convoy-rehearsal)')
  .option(
    '--probe-path <path>',
    'probe path for real rehearsal load (repeatable; default: the detected health path)',
    (value: string, acc: string[]) => [...acc, value],
    [] as string[],
  )
  .option('--probe-requests <n>', 'number of requests in the real rehearsal probe', (v) => Number(v))
  .option('--probe-concurrency <n>', 'concurrency in the real rehearsal probe', (v) => Number(v))
  .option('--env <kv>', 'env var to pass to the subprocess, KEY=VALUE (repeatable)', (value: string, acc: Record<string, string>) => {
    const idx = value.indexOf('=');
    if (idx > 0) acc[value.slice(0, idx)] = value.slice(idx + 1);
    return acc;
  }, {} as Record<string, string>)
  .action(async (planId: string, options: ApplyOpts) => {
    await runApply(planId, options);
  });

program
  .command('plans')
  .description('List recent saved plans.')
  .action(() => {
    runListPlans();
  });

program
  .command('rollback <service>')
  .description('Roll back the most recent deployment for a service (not yet implemented).')
  .action((service: string) => {
    console.error(pc.yellow(`rollback ${service}: not yet implemented`));
    process.exit(2);
  });

await program.parseAsync();
