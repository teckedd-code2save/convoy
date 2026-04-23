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
  type RealVercelOpt,
} from './core/stages.js';
import { RunStateStore } from './core/state.js';
import type { Platform, Run, RunEvent, StageName } from './core/types.js';
import { buildPlan } from './planner/index.js';
import { resolveTarget } from './planner/target-resolver.js';

const STATE_PATH = process.env['CONVOY_STATE_PATH'] ?? '.convoy/state.db';
const PLANS_DIR = process.env['CONVOY_PLANS_DIR'] ?? '.convoy/plans';
const SUPPORTED_PLATFORMS: readonly Platform[] = ['fly', 'railway', 'vercel', 'cloudrun'];
const WEB_BASE = (process.env['CONVOY_WEB_URL'] ?? 'http://localhost:3737').replace(/\/$/, '');

function webUrl(path: string): string {
  return `${WEB_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
  try {
    const args = process.platform === 'win32' ? ['', url] : [url];
    const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    proc.unref();
  } catch {
    // non-fatal — user can click the printed link
  }
}

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
    case 'progress': {
      // Give medic agent tool calls a distinct line so the operator sees
      // "medic is reading src/..., medic is grepping for..." as investigative
      // steps, not indistinguishable progress dots.
      const p = event.payload as Record<string, unknown> | null | undefined;
      if (p && p['phase'] === 'medic.tool_use') {
        const tool = String(p['tool'] ?? 'tool');
        const input = p['input'];
        let hint = '';
        if (input && typeof input === 'object') {
          const io = input as Record<string, unknown>;
          if (typeof io['path'] === 'string') hint = io['path'];
          else if (typeof io['pattern'] === 'string') hint = `/${io['pattern']}/`;
          else if (typeof io['n'] === 'number') hint = `n=${io['n']}`;
        }
        process.stdout.write(
          `  ${pc.magenta('◇')} ${pc.magenta('medic')} ${pc.dim(tool)} ${hint ? pc.dim(hint) : ''}\n`,
        );
        return;
      }
      process.stdout.write(`  ${pc.dim(SYMBOL.bullet)} ${pc.dim(compact(event.payload))}\n`);
      return;
    }
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

function attachRenderer(bus: ConvoyBus, startedAt: Date, openInUI = false): () => void {
  return bus.subscribe((e: ConvoyBusEvent) => {
    switch (e.type) {
      case 'run.created': {
        const head = `${pc.bold(pc.cyan(SYMBOL.run))} ${pc.bold(`Convoy run ${e.run.id.slice(0, 8)} started`)}`;
        const url = webUrl(`/runs/${e.run.id}`);
        process.stdout.write(`${head}\n  ${pc.dim('Repository:')} ${e.run.repoUrl}\n`);
        process.stdout.write(`  ${pc.cyan('▶')} ${pc.dim('Watch live:')} ${pc.cyan(url)}\n`);
        if (openInUI) void openInBrowser(url);
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

interface ShipOpts extends ApplyOpts {
  platform?: string;
  workspace?: string;
  noAi?: boolean;
}


/**
 * `convoy ship <path-or-url>` = plan + save + apply in one shot. The target
 * is resolved via resolveTarget (local path OR github URL/shorthand), a plan
 * is built and persisted, and the orchestrator runs with whatever --real-*
 * flags were passed. Default is the scripted pipeline; add flags to make
 * stages real.
 */
async function runShip(
  target: string,
  opts: ShipOpts,
): Promise<void> {
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

  const thinking = startThinking();
  try {
    const resolved = await resolveTarget(target, {
      onProgress: (phase, detail) => {
        thinking.stop();
        const line = detail ? `  ${pc.dim(phase)} ${detail}` : `  ${pc.dim(phase)}`;
        process.stdout.write(`${line}\n`);
      },
    });

    const inferredRepoUrl = resolved.repoUrl ?? undefined;

    const { plan, enrichmentSource } = await buildPlan(resolved.localPath, {
      ...(inferredRepoUrl !== undefined && { repoUrl: inferredRepoUrl }),
      ...(resolved.branch !== undefined && { branch: resolved.branch }),
      ...(resolved.sha !== undefined && { sha: resolved.sha }),
      ...(platformOverride !== undefined && { platformOverride }),
      ...(opts.workspace !== undefined && { workspace: opts.workspace }),
      ai: opts.noAi ? { disable: true } : {},
    });
    thinking.stop();

    const planStore = new PlanStore(PLANS_DIR);
    planStore.save(plan);

    const planUrl = webUrl(`/plans/${plan.id}`);
    process.stdout.write(
      `${pc.dim('Plan')} ${pc.bold(plan.id.slice(0, 8))} ${pc.dim('saved')} ${pc.dim(`(narrative: ${enrichmentSource})`)}\n`,
    );
    process.stdout.write(`${pc.cyan('▶')} ${pc.dim('Plan in web UI:')} ${pc.cyan(planUrl)}\n`);
    process.stdout.write(
      `${pc.dim('Target:')} ${plan.target.name} ${pc.dim(`(${plan.target.ecosystem}${plan.target.framework ? `, ${plan.target.framework}` : ''})`)}\n`,
    );
    if (plan.deployability.verdict === 'not-cloud-deployable') {
      process.stdout.write(
        `${pc.red('Refused:')} ${plan.deployability.reason}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(
      `${pc.dim('Platform:')} ${plan.platform.chosen} ${pc.dim(`(${plan.platform.source})`)}\n\n`,
    );

    await runApply(plan.id, opts);
  } catch (err) {
    thinking.stop();
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`\nship failed: ${message}`));
    process.exitCode = 1;
  }
}

interface PlanOpts {
  platform?: string;
  repoUrl?: string;
  workspace?: string;
  save?: boolean;
  json?: boolean;
  noAi?: boolean;
  open?: boolean;
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

  const thinking = opts.json ? null : startThinking();
  try {
    const resolved = await resolveTarget(path, {
      onProgress: (phase, detail) => {
        if (!opts.json) {
          thinking?.stop();
          const line = detail ? `  ${pc.dim(phase)} ${detail}` : `  ${pc.dim(phase)}`;
          process.stdout.write(`${line}\n`);
        }
      },
    });

    const inferredRepoUrl = opts.repoUrl ?? resolved.repoUrl ?? undefined;

    const { plan, enrichmentSource } = await buildPlan(resolved.localPath, {
      ...(inferredRepoUrl !== undefined && { repoUrl: inferredRepoUrl }),
      ...(resolved.branch !== undefined && { branch: resolved.branch }),
      ...(resolved.sha !== undefined && { sha: resolved.sha }),
      ...(platformOverride !== undefined && { platformOverride }),
      ...(opts.workspace !== undefined && { workspace: opts.workspace }),
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
      const url = webUrl(`/plans/${plan.id}`);
      process.stdout.write(`\n${pc.dim('Saved plan to')} ${saved}\n`);
      process.stdout.write(
        `${pc.dim('Apply with')} ${pc.bold(`npm run convoy -- apply ${plan.id.slice(0, 8)}`)}\n`,
      );
      process.stdout.write(`${pc.cyan('▶')} ${pc.dim('Inspect in the web UI:')} ${pc.cyan(url)}\n`);
      if (opts.open === true) void openInBrowser(url);
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
  // Opt-in — absence of --auto-approve / --yes pauses at every approval gate.
  autoApprove?: boolean;
  // These default to true (real). Use --no-real-X to stub, or --demo for all three.
  realAuthor: boolean;
  realRehearsal: boolean;
  realFly: boolean;
  demo?: boolean;
  autoMerge: boolean;
  mergeMethod?: string;
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
  open?: boolean;
  trustRepo?: boolean;
}

interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

interface PreflightReport {
  realAuthor: boolean;
  realRehearsal: boolean;
  realFly: boolean;
  checks: PreflightCheck[];
  hardFailures: string[];
}

const MEDIC_MODEL = 'claude-opus-4-7';

/**
 * Verify the Anthropic model id resolves before the pipeline does real work.
 * Uses models.retrieve — no token cost, one HEAD-ish GET. If the string has
 * drifted (e.g. a dated suffix now required), we warn the operator now
 * instead of letting enricher + medic silently fall back on every call.
 */
async function preflightAnthropicModel(
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });
    await client.models.retrieve(model);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

async function preflightApply(plan: ConvoyPlan, opts: ApplyOpts): Promise<PreflightReport> {
  const report: PreflightReport = {
    realAuthor: opts.realAuthor,
    realRehearsal: opts.realRehearsal,
    realFly: opts.realFly,
    checks: [],
    hardFailures: [],
  };

  if (opts.demo) {
    report.realAuthor = false;
    report.realRehearsal = false;
    report.realFly = false;
    report.checks.push({
      name: 'demo mode',
      ok: true,
      detail: 'all stages stubbed for the demo (no PR, no subprocess, no Fly deploy)',
    });
    return report;
  }

  // Verify the Anthropic model before the pipeline runs. Medic + enricher
  // degrade gracefully on API errors, but silent degradation during the demo
  // would turn the "Claude agent medic" centerpiece into a deterministic
  // fallback card with no warning.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) {
    const modelCheck = await preflightAnthropicModel(apiKey, MEDIC_MODEL);
    if (modelCheck.ok) {
      report.checks.push({
        name: 'anthropic model',
        ok: true,
        detail: `${MEDIC_MODEL} resolved`,
      });
    } else {
      report.checks.push({
        name: 'anthropic model',
        ok: false,
        detail: `${MEDIC_MODEL} did not resolve: ${modelCheck.reason?.slice(0, 140) ?? 'unknown'}`,
        remedy: `Verify the model id (current: ${MEDIC_MODEL}). The pipeline will still run, but medic + enricher will fall back to deterministic output.`,
      });
    }
  } else {
    report.checks.push({
      name: 'anthropic model',
      ok: true,
      detail: 'ANTHROPIC_API_KEY not set — medic + enricher will use deterministic fallback',
    });
  }

  // --- real author ---
  if (opts.realAuthor) {
    if (plan.author.convoyAuthoredFiles.length === 0) {
      report.realAuthor = false;
      report.checks.push({
        name: 'real author',
        ok: true,
        detail: 'skipped — plan has no files to author',
      });
    } else {
      const { detectRepo: detect, gitHubAuthStatus: authStatus } = await import('./core/github-runner.js');
      const repo = await detect(plan.target.localPath);
      if (!repo) {
        report.realAuthor = false;
        report.hardFailures.push(
          `real author: target at ${plan.target.localPath} is not a git repo with a github.com remote. ` +
            `If it's a fresh clone, make sure --real-author is desired, or pass --no-real-author.`,
        );
        report.checks.push({
          name: 'real author',
          ok: false,
          detail: 'target has no .git with github.com origin',
          remedy: 'ensure the repo has a github.com remote, or pass --no-real-author',
        });
      } else {
        const auth = await authStatus();
        if (!auth.ok) {
          report.realAuthor = false;
          report.hardFailures.push(
            `real author: gh is not authenticated (${auth.error ?? 'unknown'}). Run \`gh auth login\` or pass --no-real-author.`,
          );
          report.checks.push({
            name: 'real author',
            ok: false,
            detail: 'gh not authenticated',
            remedy: 'gh auth login',
          });
        } else {
          report.checks.push({
            name: 'real author',
            ok: true,
            detail: `gh authed as ${auth.user ?? 'unknown'} — will open PR on ${repo.owner}/${repo.repo}`,
          });
        }
      }
    }
  } else {
    report.checks.push({ name: 'real author', ok: true, detail: 'skipped (--no-real-author)' });
  }

  // --- real rehearsal ---
  if (opts.realRehearsal) {
    if (!plan.rehearsal.startCommand) {
      report.realRehearsal = false;
      // Surface detected sub-services as remediation — the common case is a
      // monorepo where the start command lives inside apps/* or packages/*.
      const subPaths = extractMonorepoSuggestions(plan);
      const workspaceHint = subPaths.length > 0
        ? `This looks like a monorepo. Try --workspace=${subPaths[0]}${subPaths.length > 1 ? ` (other services: ${subPaths.slice(1).join(', ')})` : ''}.`
        : 'Add a \`start\` script to the target, or pass --no-real-rehearsal.';
      report.hardFailures.push(`real rehearsal: no start command detected. ${workspaceHint}`);
      report.checks.push({
        name: 'real rehearsal',
        ok: false,
        detail: 'no start command detected',
        remedy: workspaceHint,
      });
    } else {
      const cwdHint = plan.target.workspace ? ` in \`${plan.target.workspace}/\`` : '';
      const trusted = opts.trustRepo === true;
      const envHint = trusted
        ? '; parent env inherited (--trust-repo)'
        : '; parent env scrubbed to PATH/HOME/NODE_ENV (+ --env and env-file). Use --trust-repo to inherit your shell env.';
      report.checks.push({
        name: 'real rehearsal',
        ok: true,
        detail: `will spawn \`${plan.rehearsal.startCommand}\`${cwdHint} on port ${plan.rehearsal.expectedPort ?? 8080}${envHint}`,
      });
    }
  } else {
    report.checks.push({ name: 'real rehearsal', ok: true, detail: 'skipped (--no-real-rehearsal)' });
  }

  // --- real deploy (platform-specific) ---
  const platform = plan.platform.chosen;
  if (platform === 'fly') {
    if (opts.realFly) {
      const { flyctlAvailable, flyAuthStatus } = await import('./adapters/fly/runner.js');
      const available = await flyctlAvailable();
      if (!available) {
        report.realFly = false;
        report.hardFailures.push(
          `real fly: flyctl not installed. Install: \`curl -L https://fly.io/install.sh | sh\`. Or pass --no-real-fly.`,
        );
        report.checks.push({ name: 'real fly', ok: false, detail: 'flyctl not in PATH', remedy: 'brew install flyctl' });
      } else {
        const auth = await flyAuthStatus();
        if (!auth.ok) {
          report.realFly = false;
          report.hardFailures.push(
            `real fly: flyctl is not authenticated. Run \`fly auth login\`. Or pass --no-real-fly.`,
          );
          report.checks.push({ name: 'real fly', ok: false, detail: 'flyctl not authenticated', remedy: 'fly auth login' });
        } else {
          report.checks.push({
            name: 'real fly',
            ok: true,
            detail: `flyctl authed as ${auth.user ?? 'unknown'} — will deploy to Fly`,
          });
        }
      }
    } else {
      report.checks.push({ name: 'real fly', ok: true, detail: 'skipped (--no-real-fly)' });
    }
  } else if (platform === 'vercel') {
    // For vercel targets, the "realFly" flag is irrelevant; use realFly as the
    // "real deploy is on" signal and attempt vercel.
    report.realFly = false;
    if (opts.realFly) {
      const { vercelAvailable, vercelAuthStatus } = await import('./adapters/vercel/runner.js');
      const available = await vercelAvailable();
      if (!available) {
        report.hardFailures.push(
          `real vercel: vercel CLI not installed. Install: \`npm i -g vercel\`. Or pass --no-real-fly.`,
        );
        report.checks.push({ name: 'real vercel', ok: false, detail: 'vercel CLI not in PATH', remedy: 'npm i -g vercel' });
      } else {
        const auth = await vercelAuthStatus();
        if (!auth.ok) {
          report.hardFailures.push(
            `real vercel: vercel CLI is not authenticated. Run \`vercel login\`. Or pass --no-real-fly.`,
          );
          report.checks.push({ name: 'real vercel', ok: false, detail: 'vercel CLI not authenticated', remedy: 'vercel login' });
        } else {
          report.checks.push({
            name: 'real vercel',
            ok: true,
            detail: `vercel authed as ${auth.user ?? 'unknown'} — will deploy to Vercel`,
          });
        }
      }
    } else {
      report.checks.push({ name: 'real vercel', ok: true, detail: 'skipped (--no-real-fly)' });
    }
  } else {
    // railway / cloudrun — not wired yet
    report.realFly = false;
    report.checks.push({
      name: 'real deploy',
      ok: true,
      detail: `skipped — plan chose ${platform}; only fly and vercel adapters are live today. Re-plan with --platform=fly, or pass --no-real-fly.`,
    });
  }

  return report;
}

function renderPreflight(report: PreflightReport): void {
  process.stdout.write(`${pc.bold('Preflight')}\n`);
  for (const c of report.checks) {
    const mark = c.ok ? pc.green('✓') : pc.red('✗');
    process.stdout.write(`  ${mark} ${c.name.padEnd(18)} ${pc.dim(c.detail)}\n`);
    if (!c.ok && c.remedy) {
      process.stdout.write(`    ${pc.yellow('remedy:')} ${c.remedy}\n`);
    }
  }
  process.stdout.write('\n');
}

/**
 * Pull sub-service suggestions out of the plan's risks. The scanner emits a
 * "Multi-service repo detected: apps/web, apps/worker" warn when it finds
 * workspace members; parse that for --workspace hints in preflight output.
 */
function extractMonorepoSuggestions(plan: ConvoyPlan): string[] {
  for (const risk of plan.risks) {
    const match = risk.message.match(/Multi-service repo detected:\s*([^.]+)\./);
    if (match && match[1]) {
      return match[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return [];
}

function autoFlyAppName(plan: ConvoyPlan): string {
  const base = plan.target.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'convoy-app';
  const hash = plan.id.slice(0, 6);
  return `convoy-${base}-${hash}`.slice(0, 30);
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
  const unsubscribe = attachRenderer(bus, startedAt, opts.open === true);

  // Preflight — confirm each real-* stage can actually run. If a hard
  // prereq is missing and the user didn't opt out, fail with a clear remedy.
  const preflight = await preflightApply(plan, opts);
  renderPreflight(preflight);
  if (preflight.hardFailures.length > 0) {
    for (const f of preflight.hardFailures) {
      console.error(pc.red(`✗ ${f}`));
    }
    process.exit(2);
  }

  const orchestratorOpts: OrchestratorOpts = {
    dryRun: !preflight.realRehearsal,
    autoApprove: opts.autoApprove === true,
    planId: plan.id,
    plan,
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

  if (preflight.realRehearsal) {
    const real = buildRealRehearsalOpts(plan, opts);
    if (real) {
      orchestratorOpts.realRehearsal = real;
    }
  }

  if (preflight.realAuthor) {
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
      mergeOnApproval: opts.autoMerge !== false,
      mergeMethod: method,
    };
    orchestratorOpts.realAuthor = realAuthor;
  }

  const platform = plan.platform.chosen;
  if (preflight.realFly && platform === 'fly') {
    const flyAppName = opts.flyApp ?? autoFlyAppName(plan);
    if (!opts.flyApp) {
      process.stdout.write(
        `${pc.dim('Fly app name auto-generated:')} ${pc.bold(flyAppName)}\n`,
      );
    }
    // Shadow old body with new block (kept under original if-chain so the rest compiles)
    {
    const strategy = (opts.flyStrategy === 'canary' || opts.flyStrategy === 'rolling' || opts.flyStrategy === 'bluegreen' || opts.flyStrategy === 'immediate')
      ? opts.flyStrategy
      : 'canary';
    const secretsPath = opts.flySecretsFile ?? `${plan.target.localPath}/.env.convoy-secrets`;
    const secrets = existsSync(secretsPath) ? parseEnvFile(secretsPath) : {};

    const realFly: RealFlyOpt = {
      appName: flyAppName,
      cwd: plan.target.localPath,
      strategy,
      createIfMissing: opts.flyCreateApp !== false,
      convoyAuthoredFiles: plan.author.convoyAuthoredFiles.map((f) => f.path),
      thresholdErrorRatePct: 1.0,
      thresholdP99Ms: 1000,
      bakeWindowSeconds: opts.flyBakeWindow ?? 60,
    };
    if (opts.flyOrg) realFly.org = opts.flyOrg;
    if (Object.keys(secrets).length > 0) realFly.secrets = secrets;
    orchestratorOpts.realFly = realFly;
    process.stdout.write(
      `${pc.dim('Real Fly deploy:')} ${pc.bold(flyAppName)} ${pc.dim(`(strategy: ${strategy}, bake: ${realFly.bakeWindowSeconds}s, secrets: ${Object.keys(secrets).length})`)}\n`,
    );
    }
  }

  if (platform === 'vercel' && opts.realFly) {
    const preflightVercel = preflight.checks.find((c) => c.name === 'real vercel');
    if (preflightVercel?.ok) {
      const cwd = plan.target.workspace
        ? `${plan.target.localPath}/${plan.target.workspace}`
        : plan.target.localPath;
      const realVercel: RealVercelOpt = {
        cwd,
        convoyAuthoredFiles: plan.author.convoyAuthoredFiles.map((f) => f.path),
        thresholdErrorRatePct: 1.0,
        thresholdP99Ms: 3000,
        bakeWindowSeconds: opts.flyBakeWindow ?? 60,
        healthPath: '/',
      };
      orchestratorOpts.realVercel = realVercel;
      process.stdout.write(
        `${pc.dim('Real Vercel deploy:')} ${pc.bold(cwd)} ${pc.dim(`(bake: ${realVercel.bakeWindowSeconds}s)`)}\n`,
      );
    }
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

  const serviceCwd = plan.target.workspace
    ? `${plan.target.localPath}/${plan.target.workspace}`
    : plan.target.localPath;

  // Default to env-scrubbed rehearsal. --trust-repo opts into ambient env
  // inheritance (e.g. operator's own checkout where their shell env is
  // expected). For cloned third-party repos the default prevents credential
  // exfiltration via hostile install/start scripts.
  const inheritAmbientEnv = opts.trustRepo === true;

  const result: RealRehearsalOpt = {
    repoPath: plan.target.localPath,
    serviceCwd,
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
    inheritAmbientEnv,
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

    const statusLabel = run.status === 'rolled_back' ? pc.yellow('rolled_back') : `(${run.status})`;
    process.stdout.write(
      `${pc.bold(pc.cyan(SYMBOL.run))} ${pc.bold(`Run ${run.id.slice(0, 8)}`)} ${pc.dim(statusLabel)}\n`,
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
    if (run.status === 'rolled_back' && run.outcomeReason) {
      process.stdout.write(
        `  ${pc.yellow('Outcome:')}    rolled back${run.outcomeRestoredVersion !== null ? ` to v${run.outcomeRestoredVersion}` : ''}\n`,
      );
      process.stdout.write(`  ${pc.dim('Reason:')}     ${run.outcomeReason}\n`);
    } else if (run.outcomeReason) {
      process.stdout.write(`  ${pc.dim('Reason:')}     ${run.outcomeReason}\n`);
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
  .command('ship <target>')
  .description('Plan + apply end-to-end. Real by default. Accepts a local path or a GitHub URL / owner/repo.')
  .option('--platform <platform>', 'explicit platform choice: fly | railway | vercel | cloudrun')
  .option('--workspace <subdir>', 'target a specific subdirectory (e.g. backend, apps/web)')
  .option('-y, --auto-approve', 'auto-approve every gate. Default: pause at every gate; decide from the web UI')
  .option('--open', 'open the run in the web UI (http://localhost:3737) when it starts')
  .option('--trust-repo', 'allow real rehearsal to inherit cloud credentials from the parent env (default: scrubbed — only PATH/HOME/NODE_ENV + explicit --env)')
  .option('--no-ai', 'skip the Opus narrative pass')
  .option('--demo', 'scripted pipeline — no PR, no subprocess, no Fly deploy')
  .option('--no-real-author', 'stub the author stage instead of opening a real PR')
  .option('--no-real-rehearsal', 'stub the rehearse stage instead of running a local probe')
  .option('--no-real-fly', 'stub the deploy stages instead of deploying to Fly')
  .option('--no-auto-merge', 'on approval, wait for you to merge the PR on GitHub instead of merging automatically')
  .option('--merge-method <method>', 'PR merge method: merge | squash | rebase (default: squash)')
  .option('--fly-app <name>', 'Fly.io app name (auto-generated from target if omitted)')
  .option('--fly-org <org>', 'Fly.io organization (default: personal)')
  .option('--no-fly-create-app', 'do NOT create the Fly app if it does not exist')
  .option('--fly-strategy <s>', 'deploy strategy: canary | rolling | bluegreen | immediate')
  .option('--fly-secrets-file <path>', 'env-style file of secrets to stage via `fly secrets set`')
  .option('--fly-bake-window <seconds>', 'observe-stage bake window in seconds', (v) => Number(v))
  .option('--env-file <path>', 'env file for --real-rehearsal subprocess')
  .option(
    '--probe-path <path>',
    'probe path for real rehearsal load (repeatable)',
    (value: string, acc: string[]) => [...acc, value],
    [] as string[],
  )
  .option('--probe-requests <n>', 'number of requests in the real rehearsal probe', (v) => Number(v))
  .option('--probe-concurrency <n>', 'concurrency', (v) => Number(v))
  .option('--env <kv>', 'env var to pass to the subprocess, KEY=VALUE (repeatable)', (value: string, acc: Record<string, string>) => {
    const idx = value.indexOf('=');
    if (idx > 0) acc[value.slice(0, idx)] = value.slice(idx + 1);
    return acc;
  }, {} as Record<string, string>)
  .action(async (target: string, options: ShipOpts) => {
    await runShip(target, options);
  });

program
  .command('plan <path>')
  .description('Produce an inspectable plan of what `convoy apply` would do. Reads the target path or GitHub URL; does not write or deploy anything.')
  .option('--platform <platform>', 'explicit platform choice: fly | railway | vercel | cloudrun')
  .option('--repo-url <url>', 'annotate the plan with a remote repo URL (does not fetch)')
  .option('--workspace <subdir>', 'target a specific subdirectory (e.g. backend, apps/web) for monorepos')
  .option('--save', 'persist the plan to .convoy/plans/<id>.json', false)
  .option('--open', 'open the saved plan in the web UI (requires --save)')
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
  .description('Execute a saved plan. Real by default — opens a real PR, rehearses locally, deploys to Fly. Use --demo for a scripted pipeline.')
  .option('-y, --auto-approve', 'auto-approve every gate. Default: pause at every gate; decide from the web UI')
  .option('--open', 'open the run in the web UI (http://localhost:3737) when it starts')
  .option('--trust-repo', 'allow real rehearsal to inherit cloud credentials from the parent env (default: scrubbed — only PATH/HOME/NODE_ENV + explicit --env)')
  .option('--demo', 'scripted pipeline (no PR, no subprocess, no Fly deploy)')
  .option('--no-real-author', 'stub the author stage instead of opening a real PR')
  .option('--no-real-rehearsal', 'stub the rehearse stage instead of running a local probe')
  .option('--no-real-fly', 'stub the deploy stages instead of deploying to Fly')
  .option('--no-auto-merge', 'on approval, wait for you to merge the PR on GitHub instead of merging automatically')
  .option('--merge-method <method>', 'PR merge method: merge | squash | rebase (default: squash)')
  .option('--fly-app <name>', 'Fly.io app name (auto-generated from target if omitted)')
  .option('--fly-org <org>', 'Fly.io organization (default: personal)')
  .option('--no-fly-create-app', 'do NOT create the Fly app if it does not exist (default: create)')
  .option('--fly-strategy <s>', 'deploy strategy: canary | rolling | bluegreen | immediate (default: canary)')
  .option('--fly-secrets-file <path>', 'env-style file of secrets to stage via `fly secrets set` (default: <target>/.env.convoy-secrets)')
  .option('--fly-bake-window <seconds>', 'observe-stage bake window in seconds (default: 60)', (v) => Number(v))
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
