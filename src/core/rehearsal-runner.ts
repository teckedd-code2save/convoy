import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface RehearsalTarget {
  repoPath: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  port: number;
  healthPath: string;
  metricsPath?: string;
  env?: Record<string, string>;
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
    if (!existsSync(this.#target.repoPath)) {
      return this.#bail(started, `path does not exist: ${this.#target.repoPath}`);
    }

    try {
      if (this.#target.installCommand) {
        this.#onPhase('install.running', { cmd: this.#target.installCommand });
        await this.#execWait(this.#target.installCommand, 180_000, signal);
        this.#onPhase('install.done');
      }
      if (this.#target.buildCommand) {
        this.#onPhase('build.running', { cmd: this.#target.buildCommand });
        await this.#execWait(this.#target.buildCommand, 180_000, signal);
        this.#onPhase('build.done');
      }

      this.#onPhase('boot.starting', { cmd: this.#target.startCommand, port: this.#target.port });
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

  async #execWait(shellCmd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('sh', ['-c', shellCmd], {
        cwd: this.#target.repoPath,
        env: { ...process.env, ...(this.#target.env ?? {}) },
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
    const proc = spawn('sh', ['-c', cmd], {
      cwd: this.#target.repoPath,
      env: {
        ...process.env,
        ...(this.#target.env ?? {}),
        PORT: String(this.#target.port),
      },
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
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // keep retrying
      }
      await sleep(500);
    }
    throw new Error(`health never responded 200 at ${url} within ${timeoutMs}ms`);
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
    let ok = 0;
    let err = 0;
    const latencies: number[] = [];

    const worker = async (): Promise<void> => {
      while (ok + err < opts.requests) {
        if (signal?.aborted) return;
        const path = opts.paths[(ok + err) % opts.paths.length] ?? '/';
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
