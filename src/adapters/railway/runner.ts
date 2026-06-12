import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export interface RailwayAuthStatus { ok: boolean; user?: string; error?: string; }
export interface RailwayDeployResult { ok: boolean; url?: string; deploymentId?: string; error?: string; logs: string[]; }
export interface RailwayRollbackResult { ok: boolean; error?: string; }

export async function railwayAvailable(): Promise<boolean> {
  try { await exec('railway', ['--version']); return true; } catch { return false; }
}

export async function railwayAuthStatus(): Promise<RailwayAuthStatus> {
  try {
    const { stdout } = await exec('railway', ['whoami']);
    const user = stdout.trim();
    return { ok: Boolean(user), user };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function railwayDeploy(opts: {
  projectId?: string;
  cwd: string;
  onLog?: (line: string) => void;
}): Promise<RailwayDeployResult> {
  const logs: string[] = [];
  try {
    const args = ['up', '--detach'];
    if (opts.projectId) args.push('--project', opts.projectId);
    const { stdout, stderr } = await exec('railway', args, { cwd: opts.cwd });
    const combined = (stdout + stderr);
    for (const line of combined.split('\n')) {
      if (line.trim()) { logs.push(line); opts.onLog?.(line); }
    }
    // Poll for completion
    const url = await pollRailwayStatus(opts.cwd, opts.projectId);
    return { ok: true, url: url ?? undefined, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(msg);
    return { ok: false, error: msg, logs };
  }
}

async function pollRailwayStatus(cwd: string, projectId?: string): Promise<string | null> {
  const args = ['status', '--json'];
  if (projectId) args.push('--project', projectId);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { stdout } = await exec('railway', args, { cwd });
      const data = JSON.parse(stdout) as Record<string, unknown>;
      const status = data?.['deploymentStatus'] ?? data?.['status'];
      if (status === 'SUCCESS' || status === 'COMPLETE') {
        return (data?.['url'] ?? data?.['deploymentUrl'] ?? null) as string | null;
      }
      if (status === 'FAILED' || status === 'CRASHED') {
        throw new Error(`Railway deploy failed with status: ${String(status)}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('failed with status')) throw err;
      // parse error — keep polling
    }
  }
  throw new Error('Railway deploy timed out after 120 seconds');
}

export async function railwaySetSecrets(secrets: Record<string, string>, cwd: string, projectId?: string): Promise<void> {
  for (const [key, value] of Object.entries(secrets)) {
    await railwaySetVariable(key, value, cwd, projectId);
  }
}

/**
 * Set a single variable on the linked Railway service. Modern Railway CLI
 * syntax is `railway variables --set KEY=value`; requires the cwd to be
 * linked (`railway link`) or a project id.
 */
export async function railwaySetVariable(key: string, value: string, cwd: string, projectId?: string): Promise<void> {
  const args = ['variables', '--set', `${key}=${value}`];
  if (projectId) args.push('--project', projectId);
  await exec('railway', args, { cwd });
}

export async function railwayRollback(cwd: string, projectId?: string): Promise<RailwayRollbackResult> {
  try {
    // Get prior deployment ID and redeploy it
    const listArgs = ['deployments', '--json'];
    if (projectId) listArgs.push('--project', projectId);
    const { stdout } = await exec('railway', listArgs, { cwd });
    const deployments = JSON.parse(stdout) as unknown[];
    const prior = Array.isArray(deployments) ? (deployments[1] as Record<string, unknown> | undefined) : null;  // index 0 is current
    if (!prior?.['id']) return { ok: false, error: 'No prior deployment to roll back to' };
    const redeployArgs = ['redeploy', String(prior['id'])];
    if (projectId) redeployArgs.push('--project', projectId);
    await exec('railway', redeployArgs, { cwd });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
