import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface RehearsalTarget {
  /**
   * Where the app's lockfile / install manifest lives. For a pnpm/yarn/npm
   * monorepo this is the repo ROOT (so `pnpm install` / `npm ci` resolves
   * all workspaces). Defaults to serviceCwd when absent.
   */
  installCwd?: string;
  /**
   * Where build + start commands should run. For a monorepo workspace target
   * this is the subdir (e.g. `apps/web`), so the locally-hoisted bin dir
   * (node_modules/.bin) resolves binaries like `next`, `tsx`, `vite`, etc.
   */
  serviceCwd: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  port: number;
  healthPath: string;
  metricsPath?: string;
  env?: Record<string, string>;
  /**
   * When false (the default) rehearsal subprocesses do NOT inherit the
   * parent process env. Only a small safe allowlist (PATH, HOME, NODE_ENV,
   * LANG, TERM, USER, SHELL, TMPDIR) plus `env` are passed. Set true only
   * when the target repo is trusted — e.g. the operator's own checkout,
   * opted in via `convoy apply --trust-repo`. Defaults to false so cloned
   * third-party repos can't exfiltrate ANTHROPIC_API_KEY / GH_TOKEN / cloud
   * credentials via their install or start scripts.
   */
  inheritAmbientEnv?: boolean;
}

const SAFE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'NODE_ENV',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
] as const;

// Subdirectories where package managers drop locally-installed executables.
// Prepending these to PATH is what `npm run` / `pnpm` / `yarn` / `uv run`
// do implicitly, and it's why `"build": "next build"` works from package.json
// but fails when Convoy shells the same string directly.
const LOCAL_BIN_SUBDIRS = [
  'node_modules/.bin', // node: npm / pnpm / yarn / bun hoist bins here
  '.venv/bin',         // python: uv / modern venv default
  'venv/bin',          // python: classic `python -m venv venv`
  '.venv/Scripts',     // python on windows (harmless on posix; existsSync is false)
  'venv/Scripts',
] as const;

function resolveLocalBinDirs(cwds: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    if (!cwd) continue;
    for (const sub of LOCAL_BIN_SUBDIRS) {
      const path = `${cwd}/${sub}`;
      if (seen.has(path)) continue;
      seen.add(path);
      if (existsSync(path)) out.push(path);
    }
  }
  return out;
}

function composeEnv(
  target: Pick<RehearsalTarget, 'env' | 'inheritAmbientEnv'>,
  cwds: ReadonlyArray<string>,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = target.inheritAmbientEnv === true
    ? { ...process.env }
    : (() => {
        const scrubbed: NodeJS.ProcessEnv = {};
        for (const key of SAFE_ENV_ALLOWLIST) {
          const value = process.env[key];
          if (value !== undefined) scrubbed[key] = value;
        }
        return scrubbed;
      })();
  const merged: NodeJS.ProcessEnv = { ...base, ...(target.env ?? {}), ...extra };
  const binDirs = resolveLocalBinDirs(cwds);
  if (binDirs.length > 0) {
    const prefix = binDirs.join(':');
    const existing = merged['PATH'] ?? '';
    merged['PATH'] = existing ? `${prefix}:${existing}` : prefix;
  }
  return merged;
}

export interface RehearsalResult {
  ok: boolean;
  reason?: string;
  metricsBefore?: MetricsSnapshot;
  metricsAfter?: MetricsSnapshot;
  logs: string[];
  durationMs: number;
}

export interface MetricsSnapshot {
  count: number;
  errorRatePct: number;
  p50?: number;
  p95?: number;
  p99?: number;
  windowSeconds?: number;
}

export interface ProbeOptions {
  requests: number;
  concurrency: number;
  paths: string[];
  timeoutMs: number;
}

export interface Thresholds {
  maxErrorRatePct: number;
  maxP99Ms: number;
}

/**
 * Runs a real local rehearsal: installs, builds, starts the target as a
 * subprocess, waits for /health, probes /metrics, drives synthetic load,
 * re-reads metrics, and tears the subprocess down. Returns real logs.
 */
export class RehearsalRunner {
  readonly #target: RehearsalTarget;
  readonly #thresholds: Thresholds;
  readonly #onPhase: (phase: string, payload?: Record<string, unknown>) => void;
  readonly #logs: string[] = [];
  #proc: ChildProcess | null = null;

  constructor(
    target: RehearsalTarget,
    thresholds: Thresholds,
    onPhase: (phase: string, payload?: Record<string, unknown>) => void,
  ) {
    this.#target = target;
    this.#thresholds = thresholds;
    this.#onPhase = onPhase;
  }

  async run(probeOpts: ProbeOptions, signal?: AbortSignal): Promise<RehearsalResult> {
    const started = Date.now();
    const installCwd = this.#target.installCwd ?? this.#target.serviceCwd;
    const serviceCwd = this.#target.serviceCwd;
    if (!existsSync(serviceCwd)) {
      return this.#bail(started, `serviceCwd does not exist: ${serviceCwd}`);
    }
    if (!existsSync(installCwd)) {
      return this.#bail(started, `installCwd does not exist: ${installCwd}`);
    }

    try {
      if (this.#target.installCommand) {
        this.#onPhase('install.running', { cmd: this.#target.installCommand, cwd: installCwd });
        await this.#execWait(this.#target.installCommand, installCwd, 180_000, signal);
        this.#onPhase('install.done');
      }
      if (this.#target.buildCommand) {
        this.#onPhase('build.running', { cmd: this.#target.buildCommand, cwd: serviceCwd });
        await this.#execWait(this.#target.buildCommand, serviceCwd, 180_000, signal);
        this.#onPhase('build.done');
      }

      this.#onPhase('boot.starting', { cmd: this.#target.startCommand, cwd: serviceCwd, port: this.#target.port });
      await this.#startService(signal);
      await this.#waitForHealth(30_000, signal);
      this.#onPhase('boot.ready', { port: this.#target.port });

      let metricsBefore: MetricsSnapshot | undefined;
      if (this.#target.metricsPath) {
        metricsBefore = await this.#readMetrics();
        this.#onPhase('metrics.baseline', { ...metricsBefore } as Record<string, unknown>);
      }

      this.#onPhase('load.running', { requests: probeOpts.requests, concurrency: probeOpts.concurrency });
      const probeStats = await this.#probe(probeOpts, signal);
      this.#onPhase('load.done', probeStats as unknown as Record<string, unknown>);

      let metricsAfter: MetricsSnapshot | undefined;
      if (this.#target.metricsPath) {
        metricsAfter = await this.#readMetrics();
      }
      const effective: MetricsSnapshot = metricsAfter ?? probeStats;
      this.#onPhase('metrics.final', effective as unknown as Record<string, unknown>);

      const breach = this.#detectBreach(effective);
      if (breach) {
        this.#onPhase('threshold.breached', { reason: breach });
        const result: RehearsalResult = {
          ok: false,
          reason: breach,
          logs: [...this.#logs],
          durationMs: Date.now() - started,
        };
        if (metricsBefore) result.metricsBefore = metricsBefore;
        if (metricsAfter) result.metricsAfter = metricsAfter;
        return result;
      }

      const result: RehearsalResult = {
        ok: true,
        logs: [...this.#logs],
        durationMs: Date.now() - started,
      };
      if (metricsBefore) result.metricsBefore = metricsBefore;
      if (metricsAfter) result.metricsAfter = metricsAfter;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.#bail(started, message);
    } finally {
      await this.#tearDown();
    }
  }

  #bail(started: number, reason: string): RehearsalResult {
    return {
      ok: false,
      reason,
      logs: [...this.#logs],
      durationMs: Date.now() - started,
    };
  }

  async #execWait(shellCmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const installCwd = this.#target.installCwd ?? this.#target.serviceCwd;
      const proc = spawn('sh', ['-c', shellCmd], {
        cwd,
        env: composeEnv(this.#target, [cwd, installCwd, this.#target.serviceCwd]),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.on('data', (chunk: Buffer) => this.#appendLog(chunk.toString('utf8')));
      proc.stderr?.on('data', (chunk: Buffer) => this.#appendLog(chunk.toString('utf8')));
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`command timed out after ${timeoutMs}ms: ${shellCmd}`));
      }, timeoutMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        proc.kill('SIGTERM');
        reject(new Error('aborted'));
      }, { once: true });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`command exited with code ${code}: ${shellCmd}`));
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async #startService(signal?: AbortSignal): Promise<void> {
    const cmd = this.#target.startCommand;
    const installCwd = this.#target.installCwd ?? this.#target.serviceCwd;
    const proc = spawn('sh', ['-c', cmd], {
      cwd: this.#target.serviceCwd,
      env: composeEnv(
        this.#target,
        [this.#target.serviceCwd, installCwd],
        { PORT: String(this.#target.port) },
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => this.#appendLog(chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => this.#appendLog(chunk.toString('utf8')));
    signal?.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
    this.#proc = proc;
  }

  async #waitForHealth(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${this.#target.port}${this.#target.healthPath}`;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted');
      if (this.#proc && this.#proc.exitCode !== null) {
        throw new Error(`service exited prematurely with code ${this.#proc.exitCode}`);
      }
      // A child killed by signal (SIGSEGV, SIGKILL from OOM, SIGTERM) has
      // exitCode === null and signalCode !== null. Without this check, a
      // service that crashes during boot causes Convoy to wait the full
      // health-timeout for nothing, and the downstream medic sees "never
      // responded" instead of "service crashed".
      if (this.#proc && this.#proc.signalCode !== null) {
        throw new Error(`service killed prematurely by signal ${this.#proc.signalCode}`);
      }
      try {
        // Any HTTP response — even 404 — means the process is up and serving.
        // The absence of a /health route is not a health failure: the operator
        // hasn't necessarily wired one, and Convoy shouldn't gate rehearsal on
        // a Convoy-shaped contract the developer never agreed to. The synthetic
        // probe stage that follows hits real paths (--probe-path) and measures
        // real error rates, which is the actual signal we care about.
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return;
      } catch {
        // Connection refused / aborted / timeout — process not ready yet.
        // Keep retrying until deadline.
      }
      await sleep(500);
    }
    throw new Error(`service did not start listening at ${url} within ${timeoutMs}ms`);
  }

  async #readMetrics(): Promise<MetricsSnapshot | undefined> {
    if (!this.#target.metricsPath) return undefined;
    try {
      const url = `http://127.0.0.1:${this.#target.port}${this.#target.metricsPath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as Partial<MetricsSnapshot>;
      return {
        count: Number(json.count ?? 0),
        errorRatePct: Number(json.errorRatePct ?? 0),
        ...(json.p50 !== undefined && { p50: Number(json.p50) }),
        ...(json.p95 !== undefined && { p95: Number(json.p95) }),
        ...(json.p99 !== undefined && { p99: Number(json.p99) }),
        ...(json.windowSeconds !== undefined && { windowSeconds: Number(json.windowSeconds) }),
      };
    } catch {
      return undefined;
    }
  }

  async #probe(opts: ProbeOptions, signal?: AbortSignal): Promise<MetricsSnapshot> {
    const base = `http://127.0.0.1:${this.#target.port}`;
    // Reserve the slot BEFORE awaiting the fetch. The previous version gated
    // on `ok + err < requests` and incremented only after `await fetch`, so
    // N concurrent workers would all observe spare capacity, each start a
    // request, and the final count could overshoot `requests` by up to
    // concurrency-1. Since JS is single-threaded, `issued++` is atomic with
    // respect to the read on the preceding line — no lock needed.
    let issued = 0;
    let ok = 0;
    let err = 0;
    const latencies: number[] = [];

    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        if (issued >= opts.requests) return;
        const slot = issued++;
        const path = opts.paths[slot % opts.paths.length] ?? '/';
        const start = Date.now();
        try {
          const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(opts.timeoutMs) });
          const dur = Date.now() - start;
          latencies.push(dur);
          if (res.status >= 500) err += 1;
          else ok += 1;
        } catch {
          err += 1;
          latencies.push(Date.now() - start);
        }
      }
    };

    await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (q: number): number | undefined => {
      if (sorted.length === 0) return undefined;
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };
    const snapshot: MetricsSnapshot = {
      count: ok + err,
      errorRatePct: (err / Math.max(1, ok + err)) * 100,
    };
    const p50 = pct(0.5);
    const p95 = pct(0.95);
    const p99 = pct(0.99);
    if (p50 !== undefined) snapshot.p50 = p50;
    if (p95 !== undefined) snapshot.p95 = p95;
    if (p99 !== undefined) snapshot.p99 = p99;
    return snapshot;
  }

  #detectBreach(m: MetricsSnapshot): string | null {
    if (m.errorRatePct > this.#thresholds.maxErrorRatePct) {
      return `error rate ${m.errorRatePct.toFixed(2)}% exceeded threshold ${this.#thresholds.maxErrorRatePct}%`;
    }
    if (m.p99 !== undefined && m.p99 > this.#thresholds.maxP99Ms) {
      return `p99 ${m.p99}ms exceeded threshold ${this.#thresholds.maxP99Ms}ms`;
    }
    return null;
  }

  async #tearDown(): Promise<void> {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignored
        }
        resolve();
      }, 2500);
      proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #appendLog(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.#logs.push(line);
      if (this.#logs.length > 500) this.#logs.shift();
    }
  }
}
