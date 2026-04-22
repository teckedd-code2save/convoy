import { spawn } from 'node:child_process';

export interface VercelDeployment {
  id: string;
  url: string;
  target: 'production' | 'preview';
  state: string;
  createdAt?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface VercelDeployOpts {
  target?: 'production' | 'preview';
  cwd: string;
  onLog?: (line: string) => void;
  envVars?: Record<string, string>;
  projectName?: string;
  timeoutMs?: number;
}

export interface VercelDeployResult {
  ok: boolean;
  url?: string;
  deploymentId?: string;
  logs: string[];
  error?: string;
}

/**
 * Low-level vercel CLI invocation. Captures stdout/stderr, optionally forwards
 * each line to a callback. Returns the exit code.
 */
export function runVercel(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    onLog?: (line: string) => void;
    allowFailure?: boolean;
    input?: string;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('vercel', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const handleChunk = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (opts.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.length === 0) continue;
          opts.onLog(line);
        }
      }
    };
    child.stdout.on('data', (c: Buffer) => handleChunk('stdout', c));
    child.stderr.on('data', (c: Buffer) => handleChunk('stderr', c));

    const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('vercel CLI not found in PATH. Install it with: npm i -g vercel'));
      } else {
        reject(err);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const result = { stdout, stderr, code: code ?? -1 };
      if (code === 0 || opts.allowFailure) resolve(result);
      else reject(new Error(`vercel ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

export async function vercelAvailable(): Promise<boolean> {
  try {
    await runVercel(['--version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function vercelAuthStatus(): Promise<{ ok: boolean; user?: string; error?: string }> {
  try {
    const res = await runVercel(['whoami'], { timeoutMs: 5000, allowFailure: true });
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout).trim() || 'not authenticated' };
    }
    const user = res.stdout.trim().split('\n').pop()?.trim();
    return { ok: true, ...(user && { user }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Set env vars on a Vercel project for a given target (production/preview).
 * Vercel's CLI is interactive by default; we pipe the value via stdin and pass
 * --yes to avoid prompts. Secrets never appear in argv.
 */
export async function vercelSetEnv(
  cwd: string,
  key: string,
  value: string,
  target: 'production' | 'preview' | 'development' = 'production',
): Promise<void> {
  // --force replaces existing values.
  await runVercel(['env', 'add', key, target, '--force'], {
    cwd,
    input: `${value}\n`,
    timeoutMs: 30_000,
  });
}

export async function vercelDeploy(
  opts: VercelDeployOpts,
): Promise<VercelDeployResult> {
  const args = ['deploy', '--yes'];
  if (opts.target === 'production') args.push('--prod');
  // Auto-link when needed. For first-time deployment into an existing target,
  // you'd already have run `vercel link`.
  const logs: string[] = [];
  try {
    const res = await runVercel(args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
      onLog: (line) => {
        logs.push(line);
        if (logs.length > 1000) logs.shift();
        if (opts.onLog) opts.onLog(line);
      },
    });
    // Vercel CLI prints the deployment URL on the last stdout line.
    const deploymentUrl = extractDeploymentUrl(res.stdout) ?? extractDeploymentUrl(res.stderr);
    if (!deploymentUrl) {
      return {
        ok: false,
        logs,
        error: 'vercel deploy did not return a deployment URL',
      };
    }
    const result: VercelDeployResult = { ok: true, url: deploymentUrl, logs };
    const deploymentId = extractDeploymentId(res.stdout + res.stderr);
    if (deploymentId) result.deploymentId = deploymentId;
    return result;
  } catch (err) {
    return {
      ok: false,
      logs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractDeploymentUrl(output: string): string | null {
  // Deployment URLs look like: https://project-abc123.vercel.app or similar.
  const match = output.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i);
  return match?.[0] ?? null;
}

function extractDeploymentId(output: string): string | null {
  // Vercel CLI outputs "dpl_xxxxxxxx" for deployment IDs in verbose logs.
  const match = output.match(/dpl_[a-zA-Z0-9]+/);
  return match?.[0] ?? null;
}

export interface VercelProject {
  id: string;
  name: string;
  accountId?: string;
}

export async function vercelProjectInfo(cwd: string): Promise<VercelProject | null> {
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(cwd, '.vercel', 'project.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['projectId'] === 'string' && typeof parsed['orgId'] === 'string') {
      return {
        id: parsed['projectId'],
        name: typeof parsed['projectName'] === 'string' ? parsed['projectName'] : parsed['projectId'],
        accountId: parsed['orgId'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List recent deployments for the linked project. Used to find a previous
 * successful deployment for alias-based rollback.
 */
export async function vercelListDeployments(cwd: string, limit = 10): Promise<VercelDeployment[]> {
  const res = await runVercel(['ls', '--json', '--count', String(limit)], {
    cwd,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => ({
        id: String(d['uid'] ?? d['id'] ?? ''),
        url: typeof d['url'] === 'string' ? (d['url'].startsWith('http') ? d['url'] : `https://${d['url']}`) : '',
        target: d['target'] === 'production' ? 'production' as const : 'preview' as const,
        state: typeof d['state'] === 'string' ? d['state'] : 'unknown',
        ...(typeof d['created'] === 'string' && { createdAt: d['created'] }),
      }));
  } catch {
    return [];
  }
}

/**
 * "Rollback" on Vercel = point the production alias at a previous deployment.
 */
export async function vercelRollback(
  cwd: string,
  productionAlias: string,
  targetDeploymentUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await runVercel(['alias', 'set', targetDeploymentUrl, productionAlias, '--yes'], {
      cwd,
      timeoutMs: 2 * 60 * 1000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Health check against a deployment URL.
 */
export async function vercelHealthCheck(
  deploymentUrl: string,
  path = '/',
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> {
  const base = deploymentUrl.startsWith('http') ? deploymentUrl : `https://${deploymentUrl}`;
  const start = Date.now();
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
