#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import { dirname, resolve } from 'node:path';

import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { stdin, stdout } from 'node:process';

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
import { scanRepository } from './planner/scanner.js';
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

async function probeWebViewer(timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(WEB_BASE, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * If the web viewer isn't reachable at WEB_BASE, try to spawn it from the
 * `web/` dir next to the CLI. The URL the CLI prints becomes a broken
 * promise otherwise — the operator clicks and gets ECONNREFUSED instead
 * of the run timeline.
 *
 * Opt out with CONVOY_NO_AUTOSPAWN=1 or by pointing CONVOY_WEB_URL
 * somewhere else (then we only probe, never spawn).
 *
 * The spawned server is detached+unref'd so it outlives the CLI process
 * and survives across back-to-back `convoy apply` calls.
 */
async function ensureWebViewerRunning(webDir: string): Promise<{
  up: boolean;
  spawned: boolean;
  note?: string;
}> {
  if (await probeWebViewer()) {
    return { up: true, spawned: false };
  }
  if (process.env['CONVOY_NO_AUTOSPAWN'] === '1') {
    return { up: false, spawned: false, note: 'CONVOY_NO_AUTOSPAWN=1 set — start web viewer manually' };
  }
  if (process.env['CONVOY_WEB_URL']) {
    return { up: false, spawned: false, note: 'CONVOY_WEB_URL points to a remote viewer that is not responding' };
  }
  if (!existsSync(webDir)) {
    return { up: false, spawned: false, note: `web viewer source not found at ${webDir}` };
  }

  const logDir = resolve(process.cwd(), '.convoy');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // directory may exist; swallow
  }
  const logPath = resolve(logDir, 'web-server.log');

  try {
    const { spawn } = await import('node:child_process');
    const logFd = openSync(logPath, 'a');
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: webDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    return {
      up: false,
      spawned: false,
      note: `failed to spawn web viewer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleepMs(300);
    if (await probeWebViewer(500)) {
      return { up: true, spawned: true };
    }
  }
  return {
    up: false,
    spawned: true,
    note: `spawned web viewer but it did not respond within 8s (logs: ${logPath})`,
  };
}

/**
 * Friendly one-time check for ANTHROPIC_API_KEY. If the operator is running
 * from a Convoy checkout that already has `.env.example` but no `.env`,
 * they almost certainly forgot step 3 of the README. Print the exact cp
 * incantation rather than making them figure out why narratives are bland.
 *
 * Fires once per process via a module-level flag so plan+apply doesn't
 * double-print for the ship flow.
 */
let convoyEnvChecked = false;
function checkConvoyEnv(): void {
  if (convoyEnvChecked) return;
  convoyEnvChecked = true;
  if (process.env['ANTHROPIC_API_KEY']) return;

  const hasEnv = existsSync(resolve(process.cwd(), '.env'));
  const hasEnvLocal = existsSync(resolve(process.cwd(), '.env.local'));
  const hasEnvExample = existsSync(resolve(process.cwd(), '.env.example'));

  if (hasEnv || hasEnvLocal) {
    // File present but key missing — likely a typo or the wrong key name.
    process.stdout.write(
      `${pc.yellow('!')} ${pc.dim(`ANTHROPIC_API_KEY not set. Narrative + medic agent will fall back to deterministic output.`)}\n`,
    );
    process.stdout.write(
      `  ${pc.dim(`Check ${hasEnv ? '.env' : '.env.local'} — the variable name must be exactly ANTHROPIC_API_KEY.`)}\n`,
    );
    return;
  }

  if (hasEnvExample) {
    process.stdout.write(
      `${pc.yellow('!')} ${pc.dim(`No .env file found. Medic agent + Opus narratives will be deterministic fallbacks.`)}\n`,
    );
    process.stdout.write(
      `  ${pc.dim(`Fix: ${pc.bold('cp .env.example .env')} then add your key: ${pc.bold('echo ANTHROPIC_API_KEY=sk-ant-... >> .env')}`)}\n`,
    );
    return;
  }

  // No .env and no .env.example — running from outside a Convoy checkout,
  // or a fresh clone missed the README. Minimal nudge.
  process.stdout.write(
    `${pc.yellow('!')} ${pc.dim(`ANTHROPIC_API_KEY not set — running with deterministic fallbacks.`)}\n`,
  );
  process.stdout.write(
    `  ${pc.dim(`Set it to enable Opus narratives + the medic agent loop: ${pc.bold('export ANTHROPIC_API_KEY=sk-ant-...')}`)}\n`,
  );
}

/**
 * Surface uncommitted changes in the target repo as preflight evidence.
 * Returns the dirty file list (porcelain `XY <path>` lines parsed down to the
 * path) so the failure message can list what needs committing without
 * re-running git.
 *
 * Errors swallow to `dirty: false` deliberately — preflight should never hard
 * fail because git itself isn't available; a missing `.git` directory is
 * already caught by the detectRepo check upstream.
 */
async function detectUncommittedChanges(repoPath: string): Promise<{ dirty: boolean; files: string[] }> {
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise((resolveResult) => {
      const proc = spawn('git', ['status', '--porcelain'], { cwd: repoPath });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      proc.on('close', (code: number) => {
        if (code !== 0) {
          resolveResult({ dirty: false, files: [] });
          return;
        }
        const files = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          // Porcelain v1: first 2 chars are status, then space, then path.
          // Renames look like `R  old -> new`; we keep the new path.
          .map((line) => {
            const path = line.slice(3).trim();
            const arrow = path.indexOf(' -> ');
            return arrow >= 0 ? path.slice(arrow + 4) : path;
          });
        resolveResult({ dirty: files.length > 0, files });
      });
      proc.on('error', () => {
        resolveResult({ dirty: false, files: [] });
      });
    });
  } catch {
    return { dirty: false, files: [] };
  }
}

/**
 * Resolve the `web/` directory relative to the CLI binary itself (works
 * whether the user ran the CLI from the repo root or from a subdirectory).
 */
function convoyWebDir(): string {
  // src/cli.ts → repo root is one dir up
  const fromCwd = resolve(process.cwd(), 'web');
  if (existsSync(fromCwd)) return fromCwd;
  // When linked or run from elsewhere, fall back to the module URL
  const moduleUrl = new URL('../web', import.meta.url);
  return moduleUrl.pathname;
}

const SYMBOL = {
  run: '◆',
  stage: '▸',
  ok: '✓',
  fail: '✗',
  bullet: '·',
  decision: '→',
  pause: '⏸',
  rule: '│',
  cornerTL: '╭',
  cornerTR: '╮',
  cornerBL: '╰',
  cornerBR: '╯',
  hRule: '─',
} as const;

/**
 * Visual prefix for every Convoy log line — a dim cyan vertical rule that
 * makes Convoy output unmistakable inside a Claude Code transcript or any
 * terminal where it shares space with other tools. Replaces the prior bare
 * 2-space indent without widening the layout.
 */
const CONVOY_RULE = `${pc.dim(pc.cyan(SYMBOL.rule))} `;

/**
 * Top-of-run banner. Drawn once when the orchestrator emits run.created.
 * Renders a 3-line unicode box with the run id + repository so screenshots
 * and demo recordings have a clear "this is Convoy starting" anchor.
 */
function convoyBanner(title: string, subtitle: string): string {
  const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');
  const titleLen = stripAnsi(title).length;
  const subtitleLen = stripAnsi(subtitle).length;
  const inner = Math.max(titleLen, subtitleLen) + 4;
  const horiz = SYMBOL.hRule.repeat(inner);
  const padTitle = ' '.repeat(inner - titleLen - 4);
  const padSubtitle = ' '.repeat(inner - subtitleLen - 4);
  return [
    `${pc.cyan(SYMBOL.cornerTL)}${pc.cyan(horiz)}${pc.cyan(SYMBOL.cornerTR)}`,
    `${pc.cyan(SYMBOL.rule)}  ${title}${padTitle}  ${pc.cyan(SYMBOL.rule)}`,
    `${pc.cyan(SYMBOL.rule)}  ${subtitle}${padSubtitle}  ${pc.cyan(SYMBOL.rule)}`,
    `${pc.cyan(SYMBOL.cornerBL)}${pc.cyan(horiz)}${pc.cyan(SYMBOL.cornerBR)}`,
  ].join('\n');
}

/**
 * Bottom-of-run rule. Drawn once when the run reaches a terminal status,
 * closing the visual block opened by the banner.
 */
function convoyClosingRule(): string {
  return pc.dim(pc.cyan(`${SYMBOL.cornerBL}${SYMBOL.hRule.repeat(48)}`));
}

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
      process.stdout.write(`${CONVOY_RULE}\n${CONVOY_RULE}${pc.cyan(SYMBOL.stage)} ${pc.bold(event.stage)}\n`);
      return;
    case 'finished':
      process.stdout.write(`${CONVOY_RULE}${pc.green(SYMBOL.ok)} ${pc.dim(compact(event.payload))}\n`);
      return;
    case 'failed':
      process.stdout.write(`${CONVOY_RULE}${pc.red(SYMBOL.fail)} ${compact(event.payload)}\n`);
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
          `${CONVOY_RULE}${pc.magenta('◇')} ${pc.magenta('medic')} ${pc.dim(tool)} ${hint ? pc.dim(hint) : ''}\n`,
        );
        return;
      }
      process.stdout.write(`${CONVOY_RULE}${pc.dim(SYMBOL.bullet)} ${pc.dim(compact(event.payload))}\n`);
      return;
    }
    case 'decision':
      process.stdout.write(`${CONVOY_RULE}${pc.cyan(SYMBOL.decision)} ${compact(event.payload, 2)}\n`);
      return;
    case 'diagnosis':
      process.stdout.write(`${CONVOY_RULE}${pc.yellow('!')} ${compact(event.payload)}\n`);
      return;
    case 'log':
      process.stdout.write(`${CONVOY_RULE}${pc.dim('|')} ${pc.dim(compact(event.payload))}\n`);
      return;
    case 'skipped':
      // Render skipped on its own line block matching `started → finished`,
      // since the user is replacing both. Reads as: "I remembered this was
      // already done; I'm not redoing it."
      process.stdout.write(
        `${CONVOY_RULE}\n${CONVOY_RULE}${pc.dim('⤳')} ${pc.dim(`${event.stage} ${pc.italic('skipped — already finished in prior attempt')}`)}\n`,
      );
      return;
  }
}

function attachRenderer(bus: ConvoyBus, startedAt: Date, openInUI = false): () => void {
  return bus.subscribe((e: ConvoyBusEvent) => {
    switch (e.type) {
      case 'run.created': {
        const url = webUrl(`/runs/${e.run.id}`);
        const title = `${pc.bold(pc.cyan('▲ CONVOY'))}  ${pc.dim('·')}  run ${pc.bold(e.run.id.slice(0, 8))}`;
        const subtitle = `${pc.dim('target:')} ${e.run.repoUrl}`;
        process.stdout.write(`\n${convoyBanner(title, subtitle)}\n`);
        process.stdout.write(`${CONVOY_RULE}${pc.cyan('▶')} ${pc.dim('Watch live:')} ${pc.cyan(url)}\n`);
        if (openInUI) void openInBrowser(url);
        return;
      }
      case 'run.updated': {
        if (e.run.status === 'succeeded') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(`${CONVOY_RULE}\n`);
          process.stdout.write(
            `${CONVOY_RULE}${pc.bold(pc.green(SYMBOL.run))} ${pc.bold(pc.green(`Convoy succeeded in ${formatDuration(ms)}`))}\n`,
          );
          if (e.run.liveUrl) {
            process.stdout.write(`${CONVOY_RULE}${pc.dim('Live URL:')} ${pc.cyan(e.run.liveUrl)}\n`);
          }
          process.stdout.write(`${convoyClosingRule()}\n`);
        } else if (e.run.status === 'awaiting_fix') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(`${CONVOY_RULE}\n`);
          process.stdout.write(
            `${CONVOY_RULE}${pc.bold(pc.yellow(SYMBOL.pause))} ${pc.bold(pc.yellow(`Paused after ${formatDuration(ms)} — awaiting developer fix`))}\n`,
          );
          process.stdout.write(
            `${CONVOY_RULE}${pc.dim('Medic diagnosed a code-level failure. Fix your code, then re-run with')} ${pc.bold('convoy resume')}${pc.dim('.')}\n`,
          );
          process.stdout.write(`${convoyClosingRule()}\n`);
        } else if (e.run.status === 'failed') {
          const ms = Date.now() - startedAt.getTime();
          process.stdout.write(`${CONVOY_RULE}\n`);
          process.stdout.write(
            `${CONVOY_RULE}${pc.bold(pc.red(SYMBOL.run))} ${pc.bold(pc.red(`Convoy failed after ${formatDuration(ms)}`))}\n`,
          );
          process.stdout.write(`${convoyClosingRule()}\n`);
        }
        return;
      }
      case 'event.appended':
        renderRunEvent(e.event);
        return;
      case 'approval.requested':
        process.stdout.write(
          `${CONVOY_RULE}${pc.yellow(SYMBOL.pause)} ${pc.yellow(`awaiting ${e.approval.kind} approval`)}\n`,
        );
        return;
      case 'approval.decided': {
        const mark = e.approval.status === 'approved' ? pc.green(SYMBOL.ok) : pc.red(SYMBOL.fail);
        process.stdout.write(`${CONVOY_RULE}${mark} ${pc.dim(`${e.approval.kind} ${e.approval.status}`)}\n`);
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
  checkConvoyEnv();
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

    const viewer = await ensureWebViewerRunning(convoyWebDir());
    if (viewer.spawned && viewer.up) {
      process.stdout.write(`${pc.dim('Started web viewer at')} ${pc.cyan(WEB_BASE)}\n`);
    } else if (!viewer.up && viewer.note) {
      process.stdout.write(`${pc.yellow('!')} ${pc.dim(viewer.note)}\n`);
    }
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
  checkConvoyEnv();
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

      const viewer = await ensureWebViewerRunning(convoyWebDir());
      if (viewer.spawned && viewer.up) {
        process.stdout.write(`${pc.dim('Started web viewer at')} ${pc.cyan(WEB_BASE)}\n`);
      } else if (!viewer.up && viewer.note) {
        process.stdout.write(`${pc.yellow('!')} ${pc.dim(viewer.note)}\n`);
      }
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
  // Comma-split var names the operator self-declares are already present on
  // the deploy target (e.g. set via platform console). Convoy trusts the
  // declaration without probing the platform — no `fly secrets list` etc.
  alreadySet?: string[];
  recurring?: boolean;
  platform?: string;
  /**
   * When set, runApply tells the orchestrator to continue this run row
   * instead of creating a new one. Set programmatically by `convoy resume`,
   * not exposed as a public flag — operators driving fresh applies should
   * never pass this.
   */
  continueRunId?: string;
  /**
   * Resume-only opt-out. When true, `convoy resume` falls back to the
   * pre-continuation behavior (create a brand-new run row, replay every
   * stage). Useful when the target's git state has diverged enough from
   * the prior attempt that prior stage outputs are no longer trustworthy.
   */
  fresh?: boolean;
  /**
   * Default commit subject for the operator-fix commit Convoy carries onto
   * its plan-keyed branch when the working tree is dirty at apply time. Set
   * by `runResume` from the prior run's outcomeReason so a fix-and-resume
   * after a medic-diagnosed breach surfaces the medic's verdict as the
   * commit subject. Falls back to "fix: changes from operator" otherwise.
   */
  carryCommitMessage?: string;
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
  /**
   * Captured at preflight when --real-author is on and the target's working
   * tree has uncommitted changes. The author stage carries these onto the
   * convoy/<plan> branch as a separate commit BEFORE writing its plumbing,
   * so the operator's fix and Convoy's deploy plumbing land in the same PR
   * — and main stays clean until that PR is merged. The list also feeds
   * the open_pr approval card so the operator sees what's about to be
   * committed before they click approve.
   */
  carryUncommittedChanges?: { files: string[] };
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

interface DataLayerExpectation {
  match: RegExp;
  label: string;
  envVars: string[];
  flyRemedy?: string;
}

const DATA_LAYER_EXPECTATIONS: DataLayerExpectation[] = [
  {
    match: /postgres|postgis/i,
    label: 'postgres',
    envVars: ['DATABASE_URL', 'POSTGRES_URL', 'PG_URL'],
    flyRemedy: 'fly postgres create --name <db-app> && fly postgres attach <db-app> --app <this-app>',
  },
  {
    match: /redis/i,
    label: 'redis',
    envVars: ['REDIS_URL', 'UPSTASH_REDIS_URL'],
    flyRemedy: 'fly redis create (Upstash addon) — attaches REDIS_URL automatically',
  },
  {
    match: /mysql|mariadb/i,
    label: 'mysql',
    envVars: ['DATABASE_URL', 'MYSQL_URL'],
  },
  {
    match: /mongo/i,
    label: 'mongo',
    envVars: ['MONGODB_URI', 'MONGO_URL'],
  },
];

/**
 * Extract env-var keys from a .env-style document (KEY=value or KEY= lines).
 * Ignores comments and blank lines. Case-sensitive — env convention is
 * UPPER_SNAKE but we don't enforce that here.
 */
function extractEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}

/**
 * Compute the full set of env var keys the app needs for deployment, reading
 * from two sources:
 *
 *  1. `.env.schema` — authored by Convoy during planning, carries the
 *     scanner-derived data-layer contract (DATABASE_URL / REDIS_URL / etc.).
 *  2. `.env.example` / `.env.local.example` — the target's own declared
 *     contract. Checked in the service workspace first, then repo root.
 *
 * Returns both the key set and a human-readable source breakdown so the
 * preflight row can show where each expectation came from.
 *
 * Pure local analysis — no platform queries.
 */
export function computeExpectedKeys(plan: ConvoyPlan): {
  keys: Set<string>;
  sources: string[];
} {
  const expected = new Set<string>();
  const sources: string[] = [];

  const schemaFile = plan.author.convoyAuthoredFiles.find((f) => f.path === '.env.schema');
  if (schemaFile) {
    const keys = extractEnvKeys(schemaFile.contentPreview);
    keys.forEach((k) => expected.add(k));
    if (keys.length > 0) sources.push(`.env.schema (${keys.length})`);
  }

  const targetCwd = plan.target.workspace
    ? resolve(plan.target.localPath, plan.target.workspace)
    : plan.target.localPath;
  const exampleCandidates = ['.env.example', '.env.local.example'];
  for (const cand of exampleCandidates) {
    const paths = [resolve(targetCwd, cand), resolve(plan.target.localPath, cand)];
    for (const p of paths) {
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, 'utf8');
          const keys = extractEnvKeys(content);
          keys.forEach((k) => expected.add(k));
          if (keys.length > 0) sources.push(`${cand} (${keys.length})`);
          break;
        } catch {
          // unreadable, skip
        }
      }
    }
  }

  return { keys: expected, sources };
}

/**
 * Compute the set of keys the operator has staged for this deploy, reading
 * from (in precedence order):
 *
 *  1. `.env.convoy-secrets` file in repo root (values included)
 *  2. `opts.env` (--env KEY=VALUE pairs, values included)
 *  3. `.env.convoy-already-set` file — names only, declares platform-set
 *  4. `opts.alreadySet` (--already-set=K1,K2 flag) — names only
 *
 * (3) and (4) are pure declarations. Convoy never reads their values from
 * the platform; the operator is vouching that they're set somewhere Convoy
 * doesn't need to know about. Written by `convoy stage-secrets` when the
 * operator marks a var with '!'.
 */
export function computeStagedKeys(
  plan: ConvoyPlan,
  opts: ApplyOpts,
): {
  staged: Set<string>;
  secretsPath: string;
  alreadySetFilePath: string;
  fromFile: string[];
  fromCli: string[];
  alreadySet: string[];
} {
  const secretsPath =
    opts.flySecretsFile ?? `${plan.target.localPath}/.env.convoy-secrets`;
  const alreadySetFilePath = `${plan.target.localPath}/.env.convoy-already-set`;

  const fileSecrets = existsSync(secretsPath) ? parseEnvFile(secretsPath) : {};
  const cliSecrets = opts.env ?? {};
  const fileAlready = existsSync(alreadySetFilePath)
    ? parseEnvFile(alreadySetFilePath)
    : {};

  const fromFile = Object.keys(fileSecrets);
  const fromCli = Object.keys(cliSecrets);
  const alreadySet = [
    ...Object.keys(fileAlready),
    ...(opts.alreadySet ?? []),
  ];

  const staged = new Set<string>();
  fromFile.forEach((k) => staged.add(k));
  fromCli.forEach((k) => staged.add(k));
  alreadySet.forEach((k) => staged.add(k));

  return { staged, secretsPath, alreadySetFilePath, fromFile, fromCli, alreadySet };
}

/**
 * Generalized env-staging check. Reconciles expected vars against staged
 * vars. No platform probes — see memory/feedback_no_autonomous_probing.md.
 */
function appendEnvStagingChecks(
  plan: ConvoyPlan,
  opts: ApplyOpts,
  report: PreflightReport,
): void {
  const { keys: expected, sources } = computeExpectedKeys(plan);
  if (expected.size === 0) return;

  const { staged, secretsPath } = computeStagedKeys(plan, opts);

  const missing = [...expected].filter((k) => !staged.has(k));
  const have = expected.size - missing.length;
  const sourcesStr = sources.length > 0 ? ` (sources: ${sources.join(', ')})` : '';

  if (missing.length === 0) {
    report.checks.push({
      name: 'env staging',
      ok: true,
      detail: `${have}/${expected.size} expected vars staged or declared already-set${sourcesStr}`,
    });
    return;
  }

  // Decorate the remedy with data-layer-specific advice when the missing
  // keys happen to map to a known database wiring (postgres/redis/etc.).
  const dataHints: string[] = [];
  const seen = new Set<string>();
  for (const key of missing) {
    const dl = DATA_LAYER_EXPECTATIONS.find((e) => e.envVars.includes(key));
    if (dl && !seen.has(dl.label) && plan.platform.chosen === 'fly' && dl.flyRemedy) {
      seen.add(dl.label);
      dataHints.push(`${dl.label} (${key}): ${dl.flyRemedy}`);
    }
  }

  const interactiveHint = `convoy stage-secrets ${plan.id.slice(0, 8)}`;
  const selfDeclareHint = `--already-set=${missing.join(',')}`;
  const fileHint = `append to ${secretsPath}`;
  const remedyParts = [
    `${pc.bold(interactiveHint)} (interactive)`,
    fileHint,
    `or self-declare already set: ${selfDeclareHint}`,
  ];
  const remedy =
    dataHints.length > 0
      ? `${dataHints.join(' · ')} · OR ${remedyParts.join(' · ')}`
      : remedyParts.join(' · ');

  report.checks.push({
    name: 'env staging',
    ok: false,
    detail: `${have}/${expected.size} vars staged${sourcesStr} — missing: ${missing.join(', ')}`,
    remedy,
  });
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

  // --- env staging (generalized) ---
  // Reconciles expected vars (from .env.schema + target .env.example) against
  // staged (local secrets file + --env + operator's self-declared
  // --already-set). No platform probing — operator is the source of truth
  // for what's already on the target. realFly in this codebase gates any
  // real platform deploy (fly or vercel).
  if (report.realFly && !opts.demo) {
    appendEnvStagingChecks(plan, opts, report);
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

          // Dirty tree handling: previously we hard-failed here and told the
          // operator to commit + push to main. That was wrong for git-deploy
          // platforms (Vercel, Netlify, Cloud Run) — pushing the fix to main
          // would trigger a prod deploy *outside Convoy's safety gates*,
          // defeating the whole point of running through rehearsal first.
          //
          // The right move is to carry the dirty changes onto Convoy's own
          // branch as a separate commit, alongside the deploy plumbing. The
          // operator sees the combined diff in the open_pr approval card and
          // approves both at once. Main stays untouched until merge — and the
          // merge IS the safe deploy, because rehearsal already proved the
          // combined branch.
          //
          // This isn't "Convoy rewrites your code" — the developer (or Claude)
          // wrote the changes, they're already on disk, and Convoy just
          // transcribes them into its branch with the operator's explicit
          // approval-gate consent.
          const dirty = await detectUncommittedChanges(plan.target.localPath);
          if (dirty.dirty) {
            report.carryUncommittedChanges = { files: dirty.files };
            const previewFiles = dirty.files.slice(0, 4).join(', ');
            const moreSuffix = dirty.files.length > 4 ? `, … (+${dirty.files.length - 4} more)` : '';
            report.checks.push({
              name: 'real author',
              ok: true,
              detail:
                `${dirty.files.length} uncommitted file${dirty.files.length === 1 ? '' : 's'} ` +
                `(${previewFiles}${moreSuffix}) — will be carried onto convoy/${plan.id.slice(0, 8)} ` +
                `as a separate commit, surfaced in the open_pr approval card. Main stays untouched until merge.`,
            });
          }
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
  checkConvoyEnv();
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

  // --platform override at apply time — re-scores the plan against the
  // live scan. Validated here so a bad platform name fails fast before
  // preflight burns network + API calls.
  let platformOverride: Platform | undefined;
  if (opts.platform !== undefined) {
    if (!isPlatform(opts.platform)) {
      console.error(
        pc.red(`Unknown platform "${opts.platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}`),
      );
      process.exit(2);
    }
    platformOverride = opts.platform;
    if (platformOverride !== plan.platform.chosen) {
      process.stdout.write(
        `${pc.yellow('!')} ${pc.dim(`overriding plan's platform`)} ${pc.bold(plan.platform.chosen)} ${pc.dim('→')} ${pc.bold(platformOverride)} ${pc.dim('(re-scored at apply time)')}\n`,
      );
      plan.platform = {
        ...plan.platform,
        chosen: platformOverride,
        source: 'override',
        reason: `operator overrode at apply time via --platform=${platformOverride}`,
      };
    }
  }

  // --recurring is the operator's self-declaration that this target is
  // already live. No platform probing; just carries the claim into the
  // plan + preflight so messaging can adapt.
  const recurring = opts.recurring === true || plan.target.mode === 'recurring';
  if (recurring) {
    plan.target = { ...plan.target, mode: 'recurring' };
  }

  const modeLabel = recurring ? pc.yellow('update') : pc.cyan('first-deploy');
  process.stdout.write(
    `${pc.dim('Applying plan')} ${pc.bold(plan.id.slice(0, 8))} ${pc.dim('—')} ${plan.target.name} ${pc.dim('→')} ${pc.cyan(plan.platform.chosen)} ${pc.dim('·')} ${modeLabel}\n`,
  );
  if (plan.target.readmeTitle) {
    process.stdout.write(`${pc.dim(`  "${plan.target.readmeTitle}"`)}\n`);
  }
  process.stdout.write(`${pc.dim(`  ${plan.author.convoyAuthoredFiles.length} file(s) to author · rehearse before production`)}\n`);
  if (recurring) {
    process.stdout.write(
      `  ${pc.dim('Recurring mode — the app is already live. Convoy will respect existing config and only stage what you declare below.')}\n`,
    );
  }

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
    ...(platformOverride !== undefined && { platformOverride }),
    ...(opts.continueRunId !== undefined && { continueRunId: opts.continueRunId }),
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
    if (preflight.carryUncommittedChanges) {
      const reasonForMessage = (opts.carryCommitMessage ?? '').trim();
      // Trim long medic narratives to a usable commit subject. Conventional
      // commit subject limit is ~72 chars; we leave headroom for the
      // "fix: " prefix and let git/gh truncate displays as needed.
      const subject = reasonForMessage.length > 0
        ? `fix: ${reasonForMessage.replace(/\s+/g, ' ').slice(0, 64)}`
        : 'fix: changes from operator';
      realAuthor.carryUncommittedChanges = {
        files: preflight.carryUncommittedChanges.files,
        messageDefault: subject,
      };
    }
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

  // Make sure the web viewer is up before the orchestrator creates the run.
  // The renderer will print "Watch live: http://localhost:3737/runs/<id>"
  // as soon as run.created fires; if the server isn't ready the operator
  // clicks a dead URL while the pipeline is already paused on an approval.
  const viewer = await ensureWebViewerRunning(convoyWebDir());
  if (viewer.spawned && viewer.up) {
    process.stdout.write(
      `${pc.dim('Started web viewer at')} ${pc.cyan(WEB_BASE)} ${pc.dim(`(logs: .convoy/web-server.log)`)}\n`,
    );
  } else if (!viewer.up && viewer.note) {
    process.stdout.write(
      `${pc.yellow('!')} ${pc.dim(`web viewer not reachable: ${viewer.note}`)}\n`,
    );
    process.stdout.write(
      `  ${pc.dim(`approvals will block the pipeline. Start the viewer manually: cd web && npm run dev`)}\n`,
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
  // Prefer what the plan says — that's what the operator reviewed. Fall back
  // to `/health` and `/metrics` for legacy plans that didn't persist these
  // fields, so older saved plans keep working.
  const healthPath = rehearsal.healthPath ?? '/health';
  const metricsPath = rehearsal.metricsPath ?? '/metrics';
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

/**
 * Interactive walkthrough for staging a plan's expected env vars. Computes
 * expected keys from .env.schema + .env.example, subtracts what's already
 * staged (secrets file + already-set file), and prompts the operator for
 * each remaining var.
 *
 * Per var: value / '!' for already-set / empty for skip. Values are appended
 * to .env.convoy-secrets. Already-set declarations go to
 * .env.convoy-already-set so subsequent `convoy apply` runs pick them up
 * without needing --already-set.
 *
 * No platform queries. The operator is the source of truth for what's on
 * the platform.
 */
async function runStageSecrets(planId: string): Promise<void> {
  const plans = new PlanStore(PLANS_DIR);
  const plan = resolvePlan(plans, planId);
  if (!plan) {
    console.error(pc.red(`Plan not found: ${planId}`));
    console.error(pc.dim(`Looked in ${PLANS_DIR}. Run \`convoy plans\` to list saved plans.`));
    process.exit(2);
  }

  const { keys: expected, sources } = computeExpectedKeys(plan);
  if (expected.size === 0) {
    process.stdout.write(
      `${pc.dim('No expected env vars — this plan has neither .env.schema nor a discoverable .env.example.')}\n`,
    );
    return;
  }

  // For stage-secrets we care about what's NOT yet declared anywhere local.
  // Use computeStagedKeys without the --already-set CLI flag (we're deciding
  // that here interactively) and without --env (also a runtime flag).
  const emptyOpts: ApplyOpts = {
    realAuthor: false,
    realRehearsal: false,
    realFly: false,
    autoMerge: false,
  };
  const { staged, secretsPath, alreadySetFilePath, fromFile, alreadySet } =
    computeStagedKeys(plan, emptyOpts);

  const missing = [...expected].filter((k) => !staged.has(k));

  process.stdout.write(
    `${pc.bold(plan.target.name)} ${pc.dim('·')} ${pc.cyan(plan.platform.chosen)}\n`,
  );
  process.stdout.write(
    `${pc.dim(`Expected vars: ${expected.size}`)}${sources.length > 0 ? pc.dim(` (sources: ${sources.join(', ')})`) : ''}\n`,
  );
  process.stdout.write(
    `${pc.dim(`Already staged: ${fromFile.length} in ${secretsPath}, ${alreadySet.length} marked already-set`)}\n\n`,
  );

  if (missing.length === 0) {
    process.stdout.write(`${pc.green('✓')} Nothing to do — all ${expected.size} expected vars are staged.\n`);
    return;
  }

  process.stdout.write(
    `${pc.yellow(`${missing.length} var${missing.length === 1 ? '' : 's'} need attention`)}${pc.dim(':')}\n`,
  );
  process.stdout.write(
    `${pc.dim(`For each: enter a value, type '!' if already set on the platform, or press Enter to skip.`)}\n\n`,
  );

  if (!stdin.isTTY) {
    process.stdout.write(
      `${pc.red('stage-secrets requires an interactive terminal (stdin is not a TTY).')}\n`,
    );
    process.stdout.write(
      `${pc.dim('Stage directly:')} ${pc.bold(`echo 'KEY=value' >> ${secretsPath}`)}\n`,
    );
    process.stdout.write(
      `${pc.dim('Or declare already-set:')} ${pc.bold(`echo 'KEY=' >> ${alreadySetFilePath}`)}\n`,
    );
    process.exit(2);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const valuesToStage: Record<string, string> = {};
  const toMarkAlreadySet: string[] = [];

  try {
    for (const key of missing) {
      const answer = await rl.question(`  ${pc.cyan(key)} ${pc.dim('>')} `);
      const trimmed = answer.trim();
      if (trimmed === '!') {
        toMarkAlreadySet.push(key);
      } else if (trimmed.length > 0) {
        valuesToStage[key] = trimmed;
      }
      // empty → skip silently
    }
  } finally {
    rl.close();
  }

  process.stdout.write('\n');

  if (Object.keys(valuesToStage).length > 0) {
    const prior = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : '';
    const separator = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
    const appended = Object.entries(valuesToStage)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    appendFileSync(secretsPath, `${separator}${appended}\n`, 'utf8');
    process.stdout.write(
      `${pc.green('✓')} Wrote ${Object.keys(valuesToStage).length} value${Object.keys(valuesToStage).length === 1 ? '' : 's'} to ${secretsPath}\n`,
    );
  }

  if (toMarkAlreadySet.length > 0) {
    const prior = existsSync(alreadySetFilePath) ? readFileSync(alreadySetFilePath, 'utf8') : '';
    const separator = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
    const appended = toMarkAlreadySet.map((k) => `${k}=`).join('\n');
    appendFileSync(alreadySetFilePath, `${separator}${appended}\n`, 'utf8');
    process.stdout.write(
      `${pc.green('✓')} Marked ${toMarkAlreadySet.length} var${toMarkAlreadySet.length === 1 ? '' : 's'} as already-set on the platform: ${toMarkAlreadySet.join(', ')}\n`,
    );
    process.stdout.write(
      `  ${pc.dim(`Recorded in ${alreadySetFilePath} — future apply runs will honor these without --already-set.`)}\n`,
    );
  }

  const stillSkipped = missing.length - Object.keys(valuesToStage).length - toMarkAlreadySet.length;
  if (stillSkipped > 0) {
    process.stdout.write(
      `${pc.yellow(`! ${stillSkipped} var${stillSkipped === 1 ? '' : 's'} skipped`)} ${pc.dim(`— preflight will still warn about them.`)}\n`,
    );
  }

  process.stdout.write(
    `\n${pc.dim('Next:')} ${pc.bold(`npm run convoy -- apply ${plan.id.slice(0, 8)}`)}\n`,
  );
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

    // The timeline URL is the main reason to run `status` on a paused run —
    // it's where the operator approves gates and reads the medic diagnosis.
    // Spawn the viewer if it's down so the URL we print actually resolves.
    const viewer = await ensureWebViewerRunning(convoyWebDir());
    const timelineUrl = webUrl(`/runs/${run.id}`);
    if (viewer.up) {
      process.stdout.write(`  ${pc.dim('Timeline:')}   ${pc.cyan(timelineUrl)}${viewer.spawned ? pc.dim(' (web viewer started)') : ''}\n`);
    } else {
      process.stdout.write(`  ${pc.dim('Timeline:')}   ${pc.cyan(timelineUrl)} ${pc.yellow('(viewer not reachable')}${viewer.note ? pc.yellow(`: ${viewer.note}`) : ''}${pc.yellow(')')}\n`);
    }

    // Last-write-wins per stage so a resumed-and-now-finished stage doesn't
    // keep its prior `failed` marker. Stages either ran (started) or didn't,
    // and ended in finished / failed / skipped — we render the latest verdict.
    const events = store.listEvents(run.id);
    type StageState = 'idle' | 'started' | 'finished' | 'failed' | 'skipped';
    const perStage = new Map<StageName, StageState>();
    for (const event of events) {
      if (event.kind === 'started') perStage.set(event.stage, 'started');
      else if (event.kind === 'finished') perStage.set(event.stage, 'finished');
      else if (event.kind === 'failed') perStage.set(event.stage, 'failed');
      else if (event.kind === 'skipped') perStage.set(event.stage, 'skipped');
    }

    const order: StageName[] = ['scan', 'pick', 'rehearse', 'author', 'canary', 'promote', 'observe'];
    process.stdout.write(`\n  ${pc.dim('Stages')}\n`);
    for (const name of order) {
      const state = perStage.get(name) ?? 'idle';
      const marker =
        state === 'failed'
          ? pc.red(SYMBOL.fail)
          : state === 'finished'
            ? pc.green(SYMBOL.ok)
            : state === 'skipped'
              ? pc.dim('⤳')
              : state === 'started'
                ? pc.yellow(SYMBOL.bullet)
                : pc.dim(SYMBOL.bullet);
      const suffix = state === 'skipped' ? pc.dim(' (skipped — already finished)') : '';
      process.stdout.write(`  ${marker} ${name}${suffix}\n`);
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

/**
 * `convoy resume [runId]` — continues a paused or failed run after the
 * developer has fixed the underlying code. By default the run row is
 * preserved: stages whose last event is `finished` are skipped, and the
 * pipeline replays from the first stage that didn't complete. Pass
 * `--fresh` to fall back to the pre-continuation behavior (new run row,
 * every stage replayed from scratch) — useful when the target's state has
 * diverged enough that prior stage outputs are no longer trustworthy.
 *
 * Defaults to the most recent run when no id is given, matching `convoy status`.
 * Refuses to resume runs that succeeded or are still in flight.
 */
async function runResume(runId: string | undefined, opts: ApplyOpts): Promise<void> {
  const store = new RunStateStore(STATE_PATH);
  let planId: string | null = null;
  let runIdFull = '';
  let resumedFromShort = '';
  let priorReason: string | null = null;
  let finishedStages: StageName[] = [];
  let failedStage: StageName | null = null;
  let firstReplayStage: StageName | null = null;
  try {
    const run: Run | null = runId
      ? store.getRun(runId)
      : (store.listRecentRuns(1)[0] ?? null);

    if (!run) {
      console.error(pc.yellow(runId ? `Run not found: ${runId}` : 'No runs found.'));
      console.error(pc.dim('Run `convoy plans` then `convoy apply <planId>` to start a fresh run.'));
      process.exitCode = 1;
      return;
    }

    if (run.status === 'running' || run.status === 'pending') {
      console.error(
        pc.yellow(`Run ${run.id.slice(0, 8)} is still ${run.status} — wait for it to finish or pause before resuming.`),
      );
      process.exitCode = 1;
      return;
    }
    if (run.status === 'succeeded') {
      console.error(
        pc.yellow(`Run ${run.id.slice(0, 8)} already succeeded — nothing to resume.`),
      );
      console.error(pc.dim(`Apply the plan again with: convoy apply ${run.planId ?? '<planId>'}`));
      process.exitCode = 1;
      return;
    }
    if (!run.planId) {
      console.error(
        pc.red(`Run ${run.id.slice(0, 8)} has no plan_id — cannot resume.`),
      );
      console.error(pc.dim('This run was started before plan tracking; create a fresh plan with `convoy plan <path> --save`.'));
      process.exitCode = 2;
      return;
    }

    planId = run.planId;
    runIdFull = run.id;
    resumedFromShort = run.id.slice(0, 8);
    priorReason = run.outcomeReason;

    // Walk the run's events to compute "what's already done" for the banner.
    // The orchestrator does the same thing internally for skip decisions; we
    // just preview it here so the operator sees what's about to be skipped.
    const STAGE_ORDER: StageName[] = ['scan', 'pick', 'rehearse', 'author', 'canary', 'promote', 'observe'];
    const lastTerminalByStage = new Map<StageName, 'finished' | 'failed'>();
    for (const event of store.listEvents(run.id)) {
      if (event.kind === 'finished' || event.kind === 'failed') {
        lastTerminalByStage.set(event.stage, event.kind);
      }
    }
    finishedStages = STAGE_ORDER.filter((s) => lastTerminalByStage.get(s) === 'finished');
    failedStage = STAGE_ORDER.find((s) => lastTerminalByStage.get(s) === 'failed') ?? null;
    firstReplayStage = STAGE_ORDER.find((s) => lastTerminalByStage.get(s) !== 'finished') ?? null;
  } finally {
    store.close();
  }

  const fresh = opts.fresh === true;
  process.stdout.write(
    `${pc.bold(pc.cyan(SYMBOL.run))} ${pc.dim(fresh ? 'Resuming (fresh run) from' : 'Continuing run')} ${pc.bold(resumedFromShort)} ${pc.dim('· plan')} ${pc.bold(planId.slice(0, 8))}\n`,
  );
  if (priorReason) {
    process.stdout.write(`  ${pc.dim('Prior failure:')} ${priorReason}\n`);
  }
  if (fresh) {
    process.stdout.write(
      `  ${pc.dim('--fresh: a new run row will be created, every stage replays from scratch.')}\n\n`,
    );
  } else if (finishedStages.length > 0) {
    process.stdout.write(
      `  ${pc.green('✓')} ${pc.dim('already finished:')} ${finishedStages.join(', ')}\n`,
    );
    if (failedStage) {
      process.stdout.write(
        `  ${pc.red('✗')} ${pc.dim('failed at:')} ${failedStage} ${pc.dim('— replaying from here')}\n`,
      );
    } else if (firstReplayStage) {
      process.stdout.write(
        `  ${pc.cyan('▸')} ${pc.dim('replaying from:')} ${firstReplayStage}\n`,
      );
    }
  }

  // Heads-up about the carry path so the operator knows their dirty tree
  // won't trip preflight. The authoritative detection runs inside runApply.
  process.stdout.write(
    `  ${pc.dim('Uncommitted changes in your target (if any) will be carried onto convoy/<plan> as a separate fix commit and shown in the open_pr approval card. Main stays clean until you approve the merge.')}\n\n`,
  );

  // Default: continue the same run row. --fresh opts out. Always thread the
  // prior outcomeReason as the commit-subject default — when the working tree
  // is dirty (the common case after a fix-and-resume), AuthorStage will
  // commit those changes onto convoy's branch with this as the subject. Empty
  // string when the prior run had no recorded reason; runApply falls back to
  // a generic message in that case.
  const carryMessage = priorReason ?? '';
  const resumeOpts: ApplyOpts = fresh
    ? { ...opts, carryCommitMessage: carryMessage }
    : { ...opts, continueRunId: runIdFull, carryCommitMessage: carryMessage };

  await runApply(planId, resumeOpts);
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
  .option(
    '--already-set <keys>',
    'comma-separated env var names the operator declares are already set on the deploy target (no platform queries). Example: --already-set=DATABASE_URL,CLERK_SECRET_KEY',
    (value: string) => value.split(',').map((k) => k.trim()).filter((k) => k.length > 0),
  )
  .option('--recurring', 'declare this as an update to an already-live service (adjusts preflight tone; no platform probing)')
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
  .option(
    '--already-set <keys>',
    'comma-separated env var names the operator declares are already set on the deploy target (no platform queries). Example: --already-set=DATABASE_URL,CLERK_SECRET_KEY',
    (value: string) => value.split(',').map((k) => k.trim()).filter((k) => k.length > 0),
  )
  .option('--recurring', 'declare this as an update to an already-live service (adjusts preflight tone; no platform probing)')
  .option('--platform <platform>', 'override the plan\'s chosen platform: fly | railway | vercel | cloudrun — re-scored at apply time')
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
  .command('resume [runId]')
  .description('Continue a paused or failed run after fixing the code. Defaults to the most recent run. Skips stages already finished; replays from the first incomplete stage.')
  .option('--fresh', 'create a new run row and replay every stage from scratch (default: continue the same run row, skip already-finished stages)')
  .option('-y, --auto-approve', 'auto-approve every gate. Default: pause at every gate; decide from the web UI')
  .option('--open', 'open the run in the web UI (http://localhost:3737) when it starts')
  .option('--trust-repo', 'allow real rehearsal to inherit cloud credentials from the parent env (default: scrubbed — only PATH/HOME/NODE_ENV + explicit --env)')
  .option(
    '--already-set <keys>',
    'comma-separated env var names the operator declares are already set on the deploy target (no platform queries). Example: --already-set=DATABASE_URL,CLERK_SECRET_KEY',
    (value: string) => value.split(',').map((k) => k.trim()).filter((k) => k.length > 0),
  )
  .option('--recurring', 'declare this as an update to an already-live service (adjusts preflight tone; no platform probing)')
  .option('--platform <platform>', 'override the plan\'s chosen platform: fly | railway | vercel | cloudrun — re-scored at apply time')
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
  .action(async (runId: string | undefined, options: ApplyOpts) => {
    await runResume(runId, options);
  });

program
  .command('plans')
  .description('List recent saved plans.')
  .action(() => {
    runListPlans();
  });

program
  .command('stage-secrets <planId>')
  .description(
    "Interactive walkthrough for staging the deploy's env vars. For each expected var, enter a value, type '!' if it's already set on the platform, or press Enter to skip. Writes to .env.convoy-secrets and .env.convoy-already-set locally — no platform queries.",
  )
  .action(async (planId: string) => {
    await runStageSecrets(planId);
  });

program
  .command('rollback <service>')
  .description('Roll back the most recent deployment for a service (not yet implemented).')
  .action((service: string) => {
    console.error(pc.yellow(`rollback ${service}: not yet implemented`));
    process.exit(2);
  });

await program.parseAsync();
