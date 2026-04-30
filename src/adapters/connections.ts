import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Platform } from '../core/types.js';
import type { ConnectionCheck, ConnectionStatus } from './types.js';
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

function normalizeExpectedSecrets(expectedSecrets: string[] | undefined): string[] {
  return [...new Set((expectedSecrets ?? []).filter((key) => key.length > 0))].sort();
}

function summarizeMissingSecrets(platform: Platform, missing: string[]): Pick<ConnectionCheck, 'summary' | 'remedy'> {
  if (missing.length === 0) {
    return {
      summary: `${platform} already has every expected secret Convoy looked for.`,
    };
  }
  const list = missing.join(', ');
  switch (platform) {
    case 'vercel':
      return {
        summary: `Missing on Vercel: ${list}.`,
        remedy: 'Set them in Vercel or stage them through Convoy before the preview deploy runs.',
      };
    case 'railway':
      return {
        summary: `Missing on Railway: ${list}.`,
        remedy: 'Set them on the linked Railway service/environment or stage them through Convoy before deploy.',
      };
    case 'cloudrun':
      return {
        summary: `Missing on Cloud Run: ${list}.`,
        remedy: 'Set them on the bound Cloud Run service or stage them through Convoy before deploy.',
      };
    case 'fly':
      return {
        summary: `Missing on Fly: ${list}.`,
        remedy: 'Set them with `flyctl secrets set ... --stage` or stage them through Convoy before deploy.',
      };
  }
}

function buildSecretsCheck(platform: Platform, expectedSecrets: string[], envKeys: string[]): ConnectionCheck {
  const missing = expectedSecrets.filter((key) => !envKeys.includes(key));
  const summary = summarizeMissingSecrets(platform, missing);
  return {
    area: 'secrets',
    ok: missing.length === 0,
    required: false,
    summary:
      expectedSecrets.length === 0
        ? `No expected secrets declared for this ${platform} lane.`
        : `${envKeys.length}/${expectedSecrets.length} expected secret${expectedSecrets.length === 1 ? '' : 's'} visible on ${platform}. ${summary.summary}`,
    ...(summary.remedy ? { remedy: summary.remedy } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  };
}

function recommendedRemedyFromChecks(checks: ConnectionCheck[]): string | undefined {
  return checks.find((check) => check.required && !check.ok)?.remedy
    ?? checks.find((check) => check.area === 'secrets' && !check.ok)?.remedy;
}

async function probeFlyConnection(
  _cwd: string,
  opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const expectedSecrets = normalizeExpectedSecrets(opts.expectedSecrets);
  const cliAvailable = await deps.flyctlAvailable();
  if (!cliAvailable) {
    const checks: ConnectionCheck[] = [
      {
        area: 'cli',
        ok: false,
        required: true,
        summary: 'flyctl is not installed.',
        remedy: 'Install flyctl with `brew install flyctl` or the official install script.',
        command: 'brew install flyctl',
      },
      {
        area: 'auth',
        ok: false,
        required: true,
        summary: 'Fly authentication cannot be checked until flyctl is installed.',
      },
      {
        area: 'project_binding',
        ok: false,
        required: Boolean(opts.appName),
        summary: opts.appName
          ? `Fly app \`${opts.appName}\` cannot be checked until flyctl is installed.`
          : 'No Fly app binding was supplied for this lane yet.',
      },
      buildSecretsCheck('fly', expectedSecrets, []),
      {
        area: 'rollback',
        ok: false,
        required: false,
        summary: 'Rollback is unavailable until flyctl can inspect the target app.',
      },
    ];
    return {
      platform: 'fly',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      expectedSecrets,
      missingExpectedSecrets: expectedSecrets,
      secretsReady: expectedSecrets.length === 0,
      checks,
      recommendedRemedy: recommendedRemedyFromChecks(checks),
    };
  }
  const auth = await deps.flyAuthStatus();
  const envKeys = opts.appName ? await listFlySecrets(opts.appName, deps) : [];
  const projectLinked = opts.appName ? await deps.flyAppExists(opts.appName) : false;
  const checks: ConnectionCheck[] = [
    {
      area: 'cli',
      ok: true,
      required: true,
      summary: 'flyctl is installed.',
    },
    {
      area: 'auth',
      ok: auth.ok,
      required: true,
      summary: auth.ok
        ? `Authenticated to Fly as ${auth.user ?? 'unknown user'}.`
        : 'Fly CLI is not authenticated.',
      ...(auth.ok ? {} : { remedy: 'Run `fly auth login`.', command: 'fly auth login' }),
    },
    {
      area: 'project_binding',
      ok: opts.appName ? projectLinked : false,
      required: Boolean(opts.appName),
      summary: opts.appName
        ? (projectLinked
          ? `Fly app \`${opts.appName}\` is reachable.`
          : `Fly app \`${opts.appName}\` does not exist or is not visible to the current account.`)
        : 'No Fly app name was supplied for this lane yet.',
      ...(opts.appName && !projectLinked
        ? { remedy: `Create or select the Fly app (${opts.appName}).` }
        : {}),
    },
    buildSecretsCheck('fly', expectedSecrets, envKeys),
    {
      area: 'rollback',
      ok: projectLinked,
      required: false,
      summary: projectLinked
        ? 'Rollback can target the existing Fly app releases.'
        : 'Rollback is unavailable until Convoy knows which Fly app this lane deploys to.',
    },
  ];
  const missingExpectedSecrets = expectedSecrets.filter((key) => !envKeys.includes(key));
  return {
    platform: 'fly',
    cliAvailable,
    authenticated: auth.ok,
    projectLinked,
    rollbackReady: projectLinked,
    account: auth.user,
    projectBinding: opts.appName,
    envKeys,
    expectedSecrets,
    missingExpectedSecrets,
    secretsReady: missingExpectedSecrets.length === 0,
    checks,
    recommendedRemedy: recommendedRemedyFromChecks(checks),
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
  opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const expectedSecrets = normalizeExpectedSecrets(opts.expectedSecrets);
  const cliAvailable = await deps.vercelAvailable();
  if (!cliAvailable) {
    const checks: ConnectionCheck[] = [
      {
        area: 'cli',
        ok: false,
        required: true,
        summary: 'Vercel CLI is not installed.',
        remedy: 'Install the Vercel CLI with `npm i -g vercel`.',
        command: 'npm i -g vercel',
      },
      {
        area: 'auth',
        ok: false,
        required: true,
        summary: 'Vercel authentication cannot be checked until the CLI is installed.',
      },
      {
        area: 'project_binding',
        ok: false,
        required: true,
        summary: 'Workspace linking cannot be checked until the Vercel CLI is installed.',
      },
      buildSecretsCheck('vercel', expectedSecrets, []),
      {
        area: 'rollback',
        ok: false,
        required: false,
        summary: 'Preview/prod rollback metadata is unavailable until the workspace is linked.',
      },
    ];
    return {
      platform: 'vercel',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      expectedSecrets,
      missingExpectedSecrets: expectedSecrets,
      secretsReady: expectedSecrets.length === 0,
      checks,
      recommendedRemedy: recommendedRemedyFromChecks(checks),
    };
  }
  const auth = await deps.vercelAuthStatus();
  const project = await deps.vercelProjectInfo(cwd);
  const envKeys = auth.ok ? await listVercelEnvKeys(cwd, deps) : [];
  const projectBinding = project ? `${project.name}${project.accountId ? ` (${project.accountId})` : ''}` : undefined;
  const checks: ConnectionCheck[] = [
    {
      area: 'cli',
      ok: true,
      required: true,
      summary: 'Vercel CLI is installed.',
    },
    {
      area: 'auth',
      ok: auth.ok,
      required: true,
      summary: auth.ok
        ? `Authenticated to Vercel as ${auth.user ?? 'unknown user'}.`
        : 'Vercel CLI is not authenticated.',
      ...(auth.ok ? {} : { remedy: 'Run `vercel login`.', command: 'vercel login' }),
    },
    {
      area: 'project_binding',
      ok: project !== null,
      required: true,
      summary: project
        ? `Workspace is linked to ${projectBinding}.`
        : 'This workspace is not linked to a Vercel project.',
      ...(project
        ? {}
        : { remedy: 'Link the workspace with `vercel link` before deploying.', command: 'vercel link' }),
    },
    buildSecretsCheck('vercel', expectedSecrets, envKeys),
    {
      area: 'rollback',
      ok: project !== null,
      required: false,
      summary: project
        ? 'Rollback can inspect prior READY Vercel deployments for this linked project.'
        : 'Rollback metadata is unavailable until the workspace is linked.',
    },
  ];
  const missingExpectedSecrets = expectedSecrets.filter((key) => !envKeys.includes(key));
  return {
    platform: 'vercel',
    cliAvailable,
    authenticated: auth.ok,
    projectLinked: project !== null,
    rollbackReady: project !== null,
    account: auth.user,
    projectBinding,
    envKeys,
    expectedSecrets,
    missingExpectedSecrets,
    secretsReady: missingExpectedSecrets.length === 0,
    checks,
    recommendedRemedy: recommendedRemedyFromChecks(checks),
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
  opts: ProbeOptions,
  deps: ProbeDependencies,
): Promise<ConnectionStatus> {
  const expectedSecrets = normalizeExpectedSecrets(opts.expectedSecrets);
  const version = await deps.runCommand('railway', ['--version'], { cwd, timeoutMs: 5000 });
  if (!version.ok) {
    const checks: ConnectionCheck[] = [
      {
        area: 'cli',
        ok: false,
        required: true,
        summary: 'Railway CLI is not installed.',
        remedy: 'Install Railway CLI with `npm i -g @railway/cli`.',
        command: 'npm i -g @railway/cli',
      },
      {
        area: 'auth',
        ok: false,
        required: true,
        summary: 'Railway authentication cannot be checked until the CLI is installed.',
      },
      {
        area: 'project_binding',
        ok: false,
        required: true,
        summary: 'Project/service binding cannot be checked until the Railway CLI is installed.',
      },
      buildSecretsCheck('railway', expectedSecrets, []),
      {
        area: 'rollback',
        ok: false,
        required: false,
        summary: 'Rollback stays manual until the target Railway service is linked.',
      },
    ];
    return {
      platform: 'railway',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      expectedSecrets,
      missingExpectedSecrets: expectedSecrets,
      secretsReady: expectedSecrets.length === 0,
      checks,
      recommendedRemedy: recommendedRemedyFromChecks(checks),
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
  const checks: ConnectionCheck[] = [
    {
      area: 'cli',
      ok: true,
      required: true,
      summary: 'Railway CLI is installed.',
    },
    {
      area: 'auth',
      ok: whoami.ok,
      required: true,
      summary: whoami.ok
        ? `Authenticated to Railway as ${whoami.stdout.trim() || 'unknown user'}.`
        : 'Railway CLI is not authenticated.',
      ...(whoami.ok ? {} : { remedy: 'Run `railway login`.', command: 'railway login' }),
    },
    {
      area: 'project_binding',
      ok: projectLinked,
      required: true,
      summary: projectLinked
        ? `Linked to ${binding}.`
        : 'This workspace is not linked to a Railway project and service yet.',
      ...(projectLinked
        ? {}
        : {
            remedy: 'Link the workspace with `railway link` so Convoy can target the right Railway project/service.',
            command: 'railway link',
          }),
    },
    buildSecretsCheck('railway', expectedSecrets, envKeys),
    {
      area: 'rollback',
      ok: projectLinked,
      required: false,
      summary: projectLinked
        ? 'Railway rollback still remains manual in this revision.'
        : 'Rollback context is unavailable until the Railway project/service is linked.',
    },
  ];
  const missingExpectedSecrets = expectedSecrets.filter((key) => !envKeys.includes(key));
  return {
    platform: 'railway',
    cliAvailable: true,
    authenticated: whoami.ok,
    projectLinked,
    rollbackReady: projectLinked,
    account: whoami.stdout.trim() || undefined,
    projectBinding: binding || undefined,
    envKeys,
    expectedSecrets,
    missingExpectedSecrets,
    secretsReady: missingExpectedSecrets.length === 0,
    checks,
    recommendedRemedy: recommendedRemedyFromChecks(checks) ?? 'Railway rollback remains manual in this revision.',
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
  const expectedSecrets = normalizeExpectedSecrets(opts.expectedSecrets);
  const version = await deps.runCommand('gcloud', ['version', '--format=json'], { cwd, timeoutMs: 5000 });
  if (!version.ok) {
    const checks: ConnectionCheck[] = [
      {
        area: 'cli',
        ok: false,
        required: true,
        summary: 'Google Cloud SDK (`gcloud`) is not installed.',
        remedy: 'Install the Google Cloud SDK (`gcloud`).',
      },
      {
        area: 'auth',
        ok: false,
        required: true,
        summary: 'gcloud authentication cannot be checked until the SDK is installed.',
      },
      {
        area: 'project_binding',
        ok: false,
        required: true,
        summary: 'Project/service binding cannot be checked until gcloud is installed.',
      },
      buildSecretsCheck('cloudrun', expectedSecrets, []),
      {
        area: 'rollback',
        ok: false,
        required: false,
        summary: 'Rollback metadata is unavailable until gcloud can inspect the target project/service.',
      },
    ];
    return {
      platform: 'cloudrun',
      cliAvailable: false,
      authenticated: false,
      projectLinked: false,
      rollbackReady: false,
      envKeys: [],
      expectedSecrets,
      missingExpectedSecrets: expectedSecrets,
      secretsReady: expectedSecrets.length === 0,
      checks,
      recommendedRemedy: recommendedRemedyFromChecks(checks),
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
  const authOk = auth.ok && auth.stdout.trim().length > 0;
  const checks: ConnectionCheck[] = [
    {
      area: 'cli',
      ok: true,
      required: true,
      summary: 'gcloud is installed.',
    },
    {
      area: 'auth',
      ok: authOk,
      required: true,
      summary: authOk
        ? `Authenticated to Google Cloud as ${auth.stdout.trim()}.`
        : 'gcloud has no active authenticated account.',
      ...(authOk ? {} : { remedy: 'Run `gcloud auth login`.', command: 'gcloud auth login' }),
    },
    {
      area: 'project_binding',
      ok: projectLinked,
      required: true,
      summary: !hasProject
        ? 'gcloud has no active project configured for this lane.'
        : !serviceName
          ? 'Convoy could not infer which Cloud Run service this lane should target.'
          : serviceDescribe?.ok === false
            ? `Targeting ${projectBinding}, but the existing service could not be inspected. Convoy can still deploy if the binding is correct.`
            : `Targeting ${projectBinding}.`
        ,
      ...(!hasProject
        ? {
            remedy: 'Set the target GCP project with `gcloud config set project <id>`.',
            command: 'gcloud config set project <id>',
          }
        : !serviceName
          ? {
              remedy:
                'Add a Cloud Run service binding (for example via cloudbuild.yaml) or pass an explicit service name before staging secrets.',
            }
          : {}),
    },
    buildSecretsCheck('cloudrun', expectedSecrets, envKeys),
    {
      area: 'rollback',
      ok: projectLinked,
      required: false,
      summary: projectLinked
        ? 'Rollback can target the configured Cloud Run project/service once the real runner lands.'
        : 'Rollback metadata is unavailable until the Cloud Run project/service binding is known.',
    },
  ];
  const missingExpectedSecrets = expectedSecrets.filter((key) => !envKeys.includes(key));
  return {
    platform: 'cloudrun',
    cliAvailable: true,
    authenticated: authOk,
    projectLinked,
    rollbackReady: projectLinked,
    account: auth.stdout.trim() || undefined,
    projectBinding,
    envKeys,
    expectedSecrets,
    missingExpectedSecrets,
    secretsReady: missingExpectedSecrets.length === 0,
    checks,
    recommendedRemedy: recommendedRemedyFromChecks(checks),
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
