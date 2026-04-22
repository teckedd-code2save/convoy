import { spawn } from 'node:child_process';

export interface FlyApp {
  name: string;
  hostname?: string;
  deployed?: boolean;
  status?: string;
  organization?: string;
}

export interface FlyRelease {
  version: number;
  status: string;
  image?: string;
  createdAt?: string;
  description?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DeployResult {
  ok: boolean;
  hostname?: string;
  releaseVersion?: number;
  logs: string[];
  error?: string;
}

export interface FlyDeployOpts {
  strategy?: 'canary' | 'rolling' | 'bluegreen' | 'immediate';
  remoteOnly?: boolean;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * Low-level flyctl invocation. Captures stdout/stderr, optionally forwards
 * each line to a callback (for streaming deploys). Returns the exit code.
 */
export function runFlyctl(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    onLog?: (line: string) => void;
    allowFailure?: boolean;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('fly', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const handleChunk = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (opts.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) opts.onLog(line);
        }
      }
    };
    child.stdout.on('data', (c: Buffer) => handleChunk('stdout', c));
    child.stderr.on('data', (c: Buffer) => handleChunk('stderr', c));

    const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('flyctl not found in PATH. Install it with: curl -L https://fly.io/install.sh | sh'));
      } else {
        reject(err);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const result = { stdout, stderr, code: code ?? -1 };
      if (code === 0 || opts.allowFailure) resolve(result);
      else reject(new Error(`flyctl ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
    });
  });
}

export async function flyctlAvailable(): Promise<boolean> {
  try {
    await runFlyctl(['version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function flyAuthStatus(): Promise<{ ok: boolean; user?: string; error?: string }> {
  try {
    const res = await runFlyctl(['auth', 'whoami'], { timeoutMs: 5000, allowFailure: true });
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout).trim() || 'not authenticated' };
    }
    const user = res.stdout.trim();
    return user ? { ok: true, user } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function flyListApps(): Promise<FlyApp[]> {
  const res = await runFlyctl(['apps', 'list', '--json'], { timeoutMs: 15000 });
  try {
    const parsed = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    return parsed.map((row) => ({
      name: String(row['Name'] ?? row['name'] ?? ''),
      hostname: typeof row['Hostname'] === 'string' ? row['Hostname'] : undefined,
      deployed: typeof row['Deployed'] === 'boolean' ? row['Deployed'] : undefined,
      status: typeof row['Status'] === 'string' ? row['Status'] : undefined,
      organization: typeof row['Organization'] === 'string'
        ? row['Organization']
        : (typeof (row['Organization'] as Record<string, unknown> | undefined)?.['Slug'] === 'string'
          ? String((row['Organization'] as Record<string, unknown>)['Slug'])
          : undefined),
    }));
  } catch {
    return [];
  }
}

export async function flyAppExists(name: string): Promise<boolean> {
  try {
    const res = await runFlyctl(['status', '--app', name, '--json'], {
      timeoutMs: 8000,
      allowFailure: true,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function flyCreateApp(name: string, org = 'personal'): Promise<void> {
  await runFlyctl(['apps', 'create', name, '--org', org], { timeoutMs: 30000 });
}

export async function flyDestroyApp(name: string): Promise<void> {
  await runFlyctl(['apps', 'destroy', name, '--yes'], { timeoutMs: 60000 });
}

export async function flySetSecrets(appName: string, secrets: Record<string, string>): Promise<void> {
  const entries = Object.entries(secrets);
  if (entries.length === 0) return;
  const args = ['secrets', 'set', '--app', appName];
  for (const [k, v] of entries) args.push(`${k}=${v}`);
  // Stage instead of trigger-deploy; we'll deploy separately.
  args.push('--stage');
  await runFlyctl(args, { timeoutMs: 30000 });
}

export async function flyDeploy(
  appName: string,
  cwd: string,
  opts: FlyDeployOpts = {},
): Promise<DeployResult> {
  const args = ['deploy', '--app', appName, '--yes'];
  if (opts.strategy) args.push('--strategy', opts.strategy);
  if (opts.remoteOnly !== false) args.push('--remote-only');
  const logs: string[] = [];
  try {
    const res = await runFlyctl(args, {
      cwd,
      timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
      onLog: (line) => {
        logs.push(line);
        if (logs.length > 1000) logs.shift();
        if (opts.onLog) opts.onLog(line);
      },
    });
    const hostname = extractHostname(res.stdout + res.stderr) ?? `${appName}.fly.dev`;
    return { ok: true, hostname, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, logs, error: message };
  }
}

function extractHostname(text: string): string | null {
  const match = text.match(/https?:\/\/([a-z0-9-]+\.fly\.dev)/i);
  return match?.[1] ?? null;
}

export async function flyListReleases(appName: string): Promise<FlyRelease[]> {
  const res = await runFlyctl(['releases', '--app', appName, '--json'], {
    timeoutMs: 15000,
    allowFailure: true,
  });
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    return parsed.map((row) => ({
      version: Number(row['Version'] ?? row['version'] ?? 0),
      status: String(row['Status'] ?? row['status'] ?? 'unknown'),
      image: typeof row['Image'] === 'string' ? row['Image'] : undefined,
      createdAt: typeof row['CreatedAt'] === 'string' ? row['CreatedAt'] : undefined,
      description: typeof row['Description'] === 'string' ? row['Description'] : undefined,
    }));
  } catch {
    return [];
  }
}

export async function flyRollback(
  appName: string,
  targetVersion?: number,
): Promise<{ ok: boolean; restoredVersion?: number; error?: string }> {
  const args = ['releases', 'rollback', '--app', appName, '--yes'];
  if (targetVersion !== undefined) args.push(String(targetVersion));
  try {
    const res = await runFlyctl(args, { timeoutMs: 5 * 60 * 1000 });
    const match = (res.stdout + res.stderr).match(/v(\d+)/i);
    const result: { ok: boolean; restoredVersion?: number; error?: string } = { ok: true };
    if (match && match[1]) result.restoredVersion = Number(match[1]);
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function flyHealthCheck(
  hostname: string,
  path = '/health',
  timeoutMs = 3000,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> {
  const url = hostname.startsWith('http') ? `${hostname}${path}` : `https://${hostname}${path}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
