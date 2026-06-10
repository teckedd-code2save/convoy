import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export interface CloudRunAuthStatus { ok: boolean; account?: string; project?: string; error?: string; }
export interface CloudRunDeployResult { ok: boolean; url?: string; revision?: string; error?: string; logs: string[]; }
export interface CloudRunRollbackResult { ok: boolean; error?: string; }

export async function gcloudAvailable(): Promise<boolean> {
  try { await exec('gcloud', ['--version']); return true; } catch { return false; }
}

export async function cloudRunAuthStatus(): Promise<CloudRunAuthStatus> {
  try {
    const [acctResult, projResult] = await Promise.all([
      exec('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']),
      exec('gcloud', ['config', 'get-value', 'project']),
    ]);
    const account = acctResult.stdout.trim();
    const project = projResult.stdout.trim();
    return { ok: Boolean(account), account, project: project || undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cloudRunDeploy(opts: {
  service: string;
  image: string;
  region: string;
  project?: string;
  envVars?: Record<string, string>;
  onLog?: (line: string) => void;
}): Promise<CloudRunDeployResult> {
  const logs: string[] = [];
  try {
    const args = [
      'run', 'deploy', opts.service,
      '--image', opts.image,
      '--region', opts.region,
      '--platform', 'managed',
      '--allow-unauthenticated',
      '--format', 'json',
    ];
    if (opts.project) args.push('--project', opts.project);
    if (opts.envVars && Object.keys(opts.envVars).length > 0) {
      const envStr = Object.entries(opts.envVars).map(([k, v]) => `${k}=${v}`).join(',');
      args.push('--set-env-vars', envStr);
    }
    const { stdout, stderr } = await exec('gcloud', args);
    for (const line of (stdout + stderr).split('\n')) {
      if (line.trim()) { logs.push(line); opts.onLog?.(line); }
    }
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const status = data?.['status'] as Record<string, unknown> | undefined;
    const metadata = data?.['metadata'] as Record<string, unknown> | undefined;
    const annotations = metadata?.['annotations'] as Record<string, unknown> | undefined;
    const url = status?.['url'] ?? annotations?.['run.googleapis.com/last-ready-revision-name'] ?? null;
    const revision = status?.['latestCreatedRevisionName'] ?? null;
    return { ok: true, url: url != null ? String(url) : undefined, revision: revision != null ? String(revision) : undefined, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(msg);
    return { ok: false, error: msg, logs };
  }
}

export async function cloudRunGetCurrentRevision(service: string, region: string, project?: string): Promise<string | null> {
  try {
    const args = ['run', 'services', 'describe', service, '--region', region, '--format=value(status.latestReadyRevisionName)'];
    if (project) args.push('--project', project);
    const { stdout } = await exec('gcloud', args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function cloudRunRollback(opts: {
  service: string;
  region: string;
  previousRevision: string;
  project?: string;
}): Promise<CloudRunRollbackResult> {
  try {
    const args = [
      'run', 'services', 'update-traffic', opts.service,
      '--region', opts.region,
      `--to-revisions=${opts.previousRevision}=100`,
    ];
    if (opts.project) args.push('--project', opts.project);
    await exec('gcloud', args);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cloudRunSetEnvVars(opts: {
  service: string;
  region: string;
  envVars: Record<string, string>;
  project?: string;
}): Promise<void> {
  if (Object.keys(opts.envVars).length === 0) return;
  const envStr = Object.entries(opts.envVars).map(([k, v]) => `${k}=${v}`).join(',');
  const args = ['run', 'services', 'update', opts.service, '--region', opts.region, '--set-env-vars', envStr];
  if (opts.project) args.push('--project', opts.project);
  await exec('gcloud', args);
}
