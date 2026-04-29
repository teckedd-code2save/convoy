import { spawn } from 'node:child_process';

import type { Platform } from '../core/types.js';
import type { ConnectionStatus } from './types.js';
import { flyAppExists, flyAuthStatus, flyctlAvailable } from './fly/runner.js';
import { vercelAuthStatus, vercelAvailable, vercelProjectInfo } from './vercel/runner.js';

async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          resolve({ ok: false, stdout, stderr: stderr || `${cmd} timed out` });
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function probePlatformConnection(
  platform: Platform,
  cwd: string,
  opts: { appName?: string; expectedSecrets?: string[] } = {},
): Promise<ConnectionStatus> {
  switch (platform) {
    case 'fly':
      return probeFlyConnection(cwd, opts);
    case 'vercel':
      return probeVercelConnection(cwd, opts);
    case 'railway':
      return probeRailwayConnection(cwd, opts);
    case 'cloudrun':
      return probeCloudRunConnection(cwd, opts);
  }
}

async function probeFlyConnection(
  _cwd: string,
  opts: { appName?: string; expectedSecrets?: string[] },
): Promise<ConnectionStatus> {
  const cliAvailable = await flyctlAvailable();
  if (!cliAvailable) {
    return {
      platform: 'fly',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      recommendedRemedy: 'Install flyctl with `brew install flyctl` or the official install script.',
    };
  }
  const auth = await flyAuthStatus();
  const envKeys = opts.appName ? await listFlySecrets(opts.appName) : [];
  const projectLinked = opts.appName ? await flyAppExists(opts.appName) : false;
  return {
    platform: 'fly',
    cliAvailable,
    authenticated: auth.ok,
    projectLinked,
    rollbackReady: projectLinked,
    account: auth.user,
    projectBinding: opts.appName,
    envKeys,
    recommendedRemedy: !auth.ok
      ? 'Run `fly auth login`.'
      : !projectLinked
        ? `Create or select the Fly app (${opts.appName ?? 'missing app name'}).`
        : undefined,
  };
}

async function listFlySecrets(appName: string): Promise<string[]> {
  const result = await runCommand('flyctl', ['secrets', 'list', '--app', appName, '--json'], { timeoutMs: 8000 });
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return parsed
      .map((row) => String(row['Name'] ?? row['name'] ?? ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function probeVercelConnection(
  cwd: string,
  _opts: { appName?: string; expectedSecrets?: string[] },
): Promise<ConnectionStatus> {
  const cliAvailable = await vercelAvailable();
  if (!cliAvailable) {
    return {
      platform: 'vercel',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      recommendedRemedy: 'Install the Vercel CLI with `npm i -g vercel`.',
    };
  }
  const auth = await vercelAuthStatus();
  const project = await vercelProjectInfo(cwd);
  const envKeys = auth.ok ? await listVercelEnvKeys(cwd) : [];
  return {
    platform: 'vercel',
    cliAvailable,
    authenticated: auth.ok,
    projectLinked: project !== null,
    rollbackReady: project !== null,
    account: auth.user,
    projectBinding: project ? `${project.name}${project.accountId ? ` (${project.accountId})` : ''}` : undefined,
    envKeys,
    recommendedRemedy: !auth.ok
      ? 'Run `vercel login`.'
      : project === null
        ? 'Link the workspace with `vercel link` before deploying.'
        : undefined,
  };
}

async function listVercelEnvKeys(cwd: string): Promise<string[]> {
  const result = await runCommand('vercel', ['env', 'ls', 'production', '--json'], { cwd, timeoutMs: 8000 });
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return parsed
      .map((row) => String(row['key'] ?? row['name'] ?? ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function probeRailwayConnection(
  cwd: string,
  _opts: { appName?: string; expectedSecrets?: string[] },
): Promise<ConnectionStatus> {
  const version = await runCommand('railway', ['--version'], { cwd, timeoutMs: 5000 });
  if (!version.ok) {
    return {
      platform: 'railway',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      recommendedRemedy: 'Install Railway CLI with `npm i -g @railway/cli`.',
    };
  }
  const whoami = await runCommand('railway', ['whoami'], { cwd, timeoutMs: 5000 });
  const status = await runCommand('railway', ['status', '--json'], { cwd, timeoutMs: 8000 });
  const envKeys = await listRailwayEnvKeys(cwd);
  const projectLinked = status.ok && status.stdout.trim().length > 0;
  return {
    platform: 'railway',
    cliAvailable: true,
    authenticated: whoami.ok,
    projectLinked,
    rollbackReady: projectLinked,
    account: whoami.stdout.trim() || undefined,
    projectBinding: projectLinked ? 'railway project linked' : undefined,
    envKeys,
    recommendedRemedy: !whoami.ok
      ? 'Run `railway login`.'
      : !projectLinked
        ? 'Link the workspace with `railway link`.'
        : 'Railway rollback remains manual in this revision.',
  };
}

async function listRailwayEnvKeys(cwd: string): Promise<string[]> {
  const result = await runCommand('railway', ['variables', '--json'], { cwd, timeoutMs: 8000 });
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    return parsed
      .map((row) => String(row['name'] ?? row['key'] ?? ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function probeCloudRunConnection(
  cwd: string,
  _opts: { appName?: string; expectedSecrets?: string[] },
): Promise<ConnectionStatus> {
  const version = await runCommand('gcloud', ['version', '--format=json'], { cwd, timeoutMs: 5000 });
  if (!version.ok) {
    return {
      platform: 'cloudrun',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      recommendedRemedy: 'Install the Google Cloud SDK (`gcloud`).',
    };
  }
  const auth = await runCommand('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], {
    cwd,
    timeoutMs: 5000,
  });
  const project = await runCommand('gcloud', ['config', 'get-value', 'project'], { cwd, timeoutMs: 5000 });
  return {
    platform: 'cloudrun',
    cliAvailable: true,
    authenticated: auth.ok && auth.stdout.trim().length > 0,
    projectLinked: project.ok && project.stdout.trim().length > 0,
    rollbackReady: project.ok && project.stdout.trim().length > 0,
    account: auth.stdout.trim() || undefined,
    projectBinding: project.stdout.trim() || undefined,
    envKeys: [],
    recommendedRemedy: !auth.ok || auth.stdout.trim().length === 0
      ? 'Run `gcloud auth login`.'
      : !project.ok || project.stdout.trim().length === 0
        ? 'Set the target GCP project with `gcloud config set project <id>`.'
        : 'Cloud Run env inventory remains read-only/manual in this revision.',
  };
}
