import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Platform } from '../core/types.js';
import type { ConnectionStatus } from './types.js';
import { flyAppExists, flyAuthStatus, flyctlAvailable } from './fly/runner.js';
import { vercelAuthStatus, vercelAvailable, vercelProjectInfo } from './vercel/runner.js';

export interface ProbeOptions {
  appName?: string;
  expectedSecrets?: string[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface ProbeDependencies {
  runCommand: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; input?: string; timeoutMs?: number },
  ) => Promise<CommandResult>;
  flyctlAvailable: typeof flyctlAvailable;
  flyAuthStatus: typeof flyAuthStatus;
  flyAppExists: typeof flyAppExists;
  vercelAvailable: typeof vercelAvailable;
  vercelAuthStatus: typeof vercelAuthStatus;
  vercelProjectInfo: typeof vercelProjectInfo;
}

const defaultDependencies: ProbeDependencies = {
  runCommand,
  flyctlAvailable,
  flyAuthStatus,
  flyAppExists,
  vercelAvailable,
  vercelAuthStatus,
  vercelProjectInfo,
};

async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
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

export function createPlatformConnectionProbe(overrides: Partial<ProbeDependencies> = {}) {
  const deps: ProbeDependencies = { ...defaultDependencies, ...overrides };
  return async (platform: Platform, cwd: string, opts: ProbeOptions = {}): Promise<ConnectionStatus> => {
    switch (platform) {
      case 'fly':
        return probeFlyConnection(cwd, opts, deps);
      case 'vercel':
        return probeVercelConnection(cwd, opts, deps);
      case 'railway':
        return probeRailwayConnection(cwd, opts, deps);
      case 'cloudrun':
        return probeCloudRunConnection(cwd, opts, deps);
    }
  };
}

export const probePlatformConnection = createPlatformConnectionProbe();

async function probeFlyConnection(
  _cwd: string,
  opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const cliAvailable = await deps.flyctlAvailable();
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
  const auth = await deps.flyAuthStatus();
  const envKeys = opts.appName ? await listFlySecrets(opts.appName, deps) : [];
  const projectLinked = opts.appName ? await deps.flyAppExists(opts.appName) : false;
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

async function listFlySecrets(appName: string, deps: ProbeDependencies): Promise<string[]> {
  const result = await deps.runCommand('flyctl', ['secrets', 'list', '--app', appName, '--json'], { timeoutMs: 8000 });
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
  _opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const cliAvailable = await deps.vercelAvailable();
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
  const auth = await deps.vercelAuthStatus();
  const project = await deps.vercelProjectInfo(cwd);
  const envKeys = auth.ok ? await listVercelEnvKeys(cwd, deps) : [];
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

async function listVercelEnvKeys(cwd: string, deps: ProbeDependencies): Promise<string[]> {
  const result = await deps.runCommand('vercel', ['env', 'ls', 'production', '--json'], { cwd, timeoutMs: 8000 });
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
  _opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const version = await deps.runCommand('railway', ['--version'], { cwd, timeoutMs: 5000 });
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
  const whoami = await deps.runCommand('railway', ['whoami'], { cwd, timeoutMs: 5000 });
  const status = await deps.runCommand('railway', ['status', '--json'], { cwd, timeoutMs: 8000 });
  const parsedStatus = parseRailwayStatus(status.stdout);
  const envKeys = await listRailwayEnvKeys(cwd, deps, parsedStatus.serviceName, parsedStatus.environmentName);
  const projectLinked = Boolean(parsedStatus.projectName && parsedStatus.serviceName);
  const binding = [
    parsedStatus.projectName,
    parsedStatus.environmentName ? `/${parsedStatus.environmentName}` : null,
    parsedStatus.serviceName ? `/${parsedStatus.serviceName}` : null,
  ]
    .filter(Boolean)
    .join('');
  return {
    platform: 'railway',
    cliAvailable: true,
    authenticated: whoami.ok,
    projectLinked,
    rollbackReady: projectLinked,
    account: whoami.stdout.trim() || undefined,
    projectBinding: binding || undefined,
    envKeys,
    recommendedRemedy: !whoami.ok
      ? 'Run `railway login`.'
      : !projectLinked
        ? 'Link the workspace with `railway link` so Convoy can target a specific Railway service.'
        : 'Railway rollback remains manual in this revision.',
    raw: {
      project: parsedStatus.projectName,
      environment: parsedStatus.environmentName,
      service: parsedStatus.serviceName,
    },
  };
}

function parseRailwayStatus(raw: string): { projectName?: string; environmentName?: string; serviceName?: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const project = readNestedString(parsed, ['project', 'name']) ?? readNestedString(parsed, ['projectName']);
    const environment = readNestedString(parsed, ['environment', 'name']) ?? readNestedString(parsed, ['environmentName']);
    const service = readNestedString(parsed, ['service', 'name']) ?? readNestedString(parsed, ['serviceName']);
    return {
      ...(project ? { projectName: project } : {}),
      ...(environment ? { environmentName: environment } : {}),
      ...(service ? { serviceName: service } : {}),
    };
  } catch {
    return {};
  }
}

async function listRailwayEnvKeys(
  cwd: string,
  deps: ProbeDependencies,
  serviceName?: string,
  environmentName?: string,
): Promise<string[]> {
  const args = ['variables', 'list', '--json'];
  if (serviceName) args.push('--service', serviceName);
  if (environmentName) args.push('--environment', environmentName);
  const result = await deps.runCommand('railway', args, { cwd, timeoutMs: 8000 });
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          if (!row || typeof row !== 'object') return '';
          return String((row as Record<string, unknown>)['name'] ?? (row as Record<string, unknown>)['key'] ?? '');
        })
        .filter(Boolean)
        .sort();
    }
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed as Record<string, unknown>).sort();
    }
    return [];
  } catch {
    return [];
  }
}

async function probeCloudRunConnection(
  cwd: string,
  opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const version = await deps.runCommand('gcloud', ['version', '--format=json'], { cwd, timeoutMs: 5000 });
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
  const auth = await deps.runCommand('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], {
    cwd,
    timeoutMs: 5000,
  });
  const project = await deps.runCommand('gcloud', ['config', 'get-value', 'project'], { cwd, timeoutMs: 5000 });
  const serviceName = opts.appName ?? inferCloudRunServiceName(cwd);
  const region = inferCloudRunRegion(cwd);
  const serviceDescribe =
    auth.ok && project.ok && serviceName
      ? await deps.runCommand(
          'gcloud',
          ['run', 'services', 'describe', serviceName, ...(region ? ['--region', region] : []), '--format=json'],
          { cwd, timeoutMs: 10_000 },
        )
      : null;
  const envKeys = serviceDescribe?.ok ? parseCloudRunEnvKeys(serviceDescribe.stdout) : [];
  const projectId = project.stdout.trim();
  const hasProject = project.ok && projectId.length > 0 && !/^unset$/i.test(projectId);
  const projectLinked = hasProject && Boolean(serviceName);
  const projectBinding = projectLinked
    ? `${projectId}/${serviceName}${region ? ` (${region})` : ''}`
    : hasProject
      ? projectId
      : undefined;
  return {
    platform: 'cloudrun',
    cliAvailable: true,
    authenticated: auth.ok && auth.stdout.trim().length > 0,
    projectLinked,
    rollbackReady: projectLinked,
    account: auth.stdout.trim() || undefined,
    projectBinding,
    envKeys,
    recommendedRemedy: !auth.ok || auth.stdout.trim().length === 0
      ? 'Run `gcloud auth login`.'
      : !hasProject
        ? 'Set the target GCP project with `gcloud config set project <id>`.'
        : !serviceName
          ? 'Add a Cloud Run service binding (for example via cloudbuild.yaml) or pass an explicit service name before staging secrets.'
          : undefined,
    raw: {
      project: hasProject ? projectId : undefined,
      service: serviceName,
      region,
      serviceDescribeOk: serviceDescribe?.ok ?? false,
    },
  };
}

function inferCloudRunServiceName(cwd: string): string | undefined {
  for (const file of ['cloudbuild.yaml', 'cloudbuild.yml']) {
    const raw = tryReadFile(cwd, file);
    if (!raw) continue;
    const deployMatch = raw.match(/\n\s*-\s+deploy\s*\n\s*-\s+([a-z0-9-]+)/i);
    if (deployMatch?.[1]) return deployMatch[1];
    const namedMatch = raw.match(/gcloud\s+run\s+deploy\s+([a-z0-9-]+)/i);
    if (namedMatch?.[1]) return namedMatch[1];
  }
  return undefined;
}

function inferCloudRunRegion(cwd: string): string | undefined {
  for (const file of ['cloudbuild.yaml', 'cloudbuild.yml']) {
    const raw = tryReadFile(cwd, file);
    if (!raw) continue;
    const inlineMatch = raw.match(/--region(?:=|\s+)([a-z0-9-]+)/i);
    if (inlineMatch?.[1]) return inlineMatch[1];
    const listMatch = raw.match(/\n\s*-\s+--region=([a-z0-9-]+)/i);
    if (listMatch?.[1]) return listMatch[1];
  }
  return undefined;
}

function parseCloudRunEnvKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const containers = getCloudRunContainers(parsed);
    const keys = new Set<string>();
    for (const container of containers) {
      const env = container['env'];
      if (!Array.isArray(env)) continue;
      for (const item of env) {
        if (!item || typeof item !== 'object') continue;
        const name = (item as Record<string, unknown>)['name'];
        if (typeof name === 'string' && name.length > 0) keys.add(name);
      }
    }
    return [...keys].sort();
  } catch {
    return [];
  }
}

function getCloudRunContainers(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const spec = parsed['spec'];
  if (spec && typeof spec === 'object') {
    const template = (spec as Record<string, unknown>)['template'];
    if (template && typeof template === 'object') {
      const templateSpec = (template as Record<string, unknown>)['spec'];
      if (templateSpec && typeof templateSpec === 'object') {
        const containers = (templateSpec as Record<string, unknown>)['containers'];
        if (Array.isArray(containers)) {
          return containers.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
        }
      }
    }
  }
  const template = parsed['template'];
  if (template && typeof template === 'object') {
    const containers = (template as Record<string, unknown>)['containers'];
    if (Array.isArray(containers)) {
      return containers.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
    }
  }
  return [];
}

function readNestedString(obj: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = obj;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

function tryReadFile(base: string, relPath: string): string | null {
  const path = join(base, relPath);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
