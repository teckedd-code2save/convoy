/**
 * Deploy-access detection. Given a platform + its committed target + this
 * machine's identity, can Convoy actually reach and authenticate to the
 * target *right now*? This is pure detection — it never logs anyone in, never
 * touches a key. The resolve layer (resolve-access.ts) is what fixes failures
 * in place; the apply gate is what enforces them.
 *
 * It reuses the same probes the deep preflight already trusts:
 *   - cloud (fly/vercel/railway/cloudrun) → probePlatformConnection (CLI auth)
 *   - vps → sshAvailable + probeSshAuth + probeRemote
 *
 * Every required, failing check is mapped into a PreflightBlocker carrying the
 * exact one-line fix the operator (or the resolve walkthrough) runs — so the
 * web viewer, the renderer, and the exit-2 path all behave identically to the
 * existing preflight.
 */
import type { Platform } from './types.js';
import type { ConnectionCheck } from '../adapters/types.js';
import type { BlockerFix, PreflightBlocker } from './blockers.js';
import type { DeployTarget } from '../onboard/preferences.js';
import type { DeployIdentity } from './identity-store.js';
import { probePlatformConnection } from '../adapters/connections.js';
import { sshAvailable, probeSshAuth, probeRemote } from '../adapters/vps/runner.js';

/**
 * Probe seams — defaulted to the real implementations, injectable in tests so
 * the verification logic (check → blocker mapping) can be exercised offline.
 */
export interface VerifyDeps {
  probePlatformConnection: typeof probePlatformConnection;
  sshAvailable: typeof sshAvailable;
  probeSshAuth: typeof probeSshAuth;
  probeRemote: typeof probeRemote;
}

const defaultDeps: VerifyDeps = { probePlatformConnection, sshAvailable, probeSshAuth, probeRemote };

export interface AccessVerifyResult {
  ok: boolean;
  platform: Platform;
  checks: ConnectionCheck[];
  blockers: PreflightBlocker[];
  account?: string;
  detail: string;
}

export interface VerifyOptions {
  /**
   * Whether to probe the remote box / platform over the network. Gated on
   * operator consent (the `connect` walkthrough, or a real-* deploy flag) so
   * Convoy never autonomously reaches out during a plain plan. When false,
   * only local checks run (cli present, host configured, key file resolvable).
   */
  probeRemote?: boolean;
  /** Expected secret keys, for the secrets-presence portion (cloud only). */
  expectedSecrets?: string[];
}

const CLOUD_LOGIN: Record<string, string> = {
  fly: 'fly auth login',
  vercel: 'vercel login',
  railway: 'railway login',
  cloudrun: 'gcloud auth login',
};

function blockerFromCheck(platform: Platform, check: ConnectionCheck): PreflightBlocker {
  const fixes: BlockerFix[] = [];
  if (check.command) {
    fixes.push({
      kind: check.area === 'auth' ? 'interactive' : 'shell',
      label: check.remedy ?? `Run ${check.command}`,
      command: check.command,
      autoFixable: false,
    });
  } else if (check.remedy) {
    fixes.push({ kind: 'manual', label: check.remedy, autoFixable: false });
  }
  return {
    id: `access.${platform}.${check.area}`,
    title: check.summary,
    detail: check.remedy ?? check.summary,
    severity: 'hard',
    fixes,
  };
}

async function verifyCloud(
  platform: Platform,
  repoPath: string,
  target: DeployTarget | null,
  opts: VerifyOptions,
  deps: VerifyDeps,
): Promise<AccessVerifyResult> {
  // The platform CLI is the auth store; not-logged-in is the headline blocker.
  if (!opts.probeRemote) {
    return {
      ok: true,
      platform,
      checks: [],
      blockers: [],
      detail: 'access not probed (no consent) — will verify at connect/deploy time',
    };
  }
  const probeOpts = {
    ...(target?.appName ? { appName: target.appName } : {}),
    ...(opts.expectedSecrets ? { expectedSecrets: opts.expectedSecrets } : {}),
  };
  const conn = await deps.probePlatformConnection(platform, repoPath, probeOpts);
  const failing = conn.checks.filter((c) => c.required && !c.ok);
  const blockers = failing.map((c) => blockerFromCheck(platform, c));
  const ok = blockers.length === 0;
  const login = CLOUD_LOGIN[platform];
  return {
    ok,
    platform,
    checks: conn.checks,
    blockers,
    ...(conn.account ? { account: conn.account } : {}),
    detail: ok
      ? `authenticated${conn.account ? ` as ${conn.account}` : ''}`
      : `not ready — ${failing.map((c) => c.summary).join('; ')}${login ? ` (try: ${login})` : ''}`,
  };
}

function hostFromTarget(target: DeployTarget | null): string | undefined {
  if (!target) return undefined;
  if (target.host) return target.host;
  if (target.user) return undefined; // user without host is unusable
  return undefined;
}

async function verifyVps(
  repoPath: string,
  target: DeployTarget | null,
  identity: DeployIdentity | null,
  opts: VerifyOptions,
  deps: VerifyDeps,
): Promise<AccessVerifyResult> {
  const checks: ConnectionCheck[] = [];
  const blockers: PreflightBlocker[] = [];

  const hasSsh = await deps.sshAvailable();
  checks.push({
    area: 'cli',
    ok: hasSsh,
    required: true,
    summary: hasSsh ? 'ssh client available' : 'ssh client not found',
    ...(hasSsh ? {} : { remedy: 'Install OpenSSH (apt install openssh-client / shipped on macOS)' }),
  });
  if (!hasSsh) {
    blockers.push({
      id: 'access.vps.cli',
      title: 'ssh client not found',
      detail: 'Convoy needs the ssh client to reach the box.',
      severity: 'hard',
      fixes: [{ kind: 'shell', label: 'Install OpenSSH client', command: 'apt install openssh-client', autoFixable: false }],
    });
    return { ok: false, platform: 'vps', checks, blockers, detail: 'ssh client missing' };
  }

  const host = hostFromTarget(target);
  const hostConfigured = Boolean(host);
  checks.push({
    area: 'project_binding',
    ok: hostConfigured,
    required: true,
    summary: hostConfigured ? `target host ${host}` : 'no VPS host configured',
    ...(hostConfigured ? {} : { remedy: 'Run `convoy connect vps --vps-host=user@host` (or set CONVOY_VPS_HOST)' }),
  });
  if (!hostConfigured) {
    blockers.push({
      id: 'access.vps.no-host',
      title: 'No VPS host configured',
      detail: 'Convoy does not yet know which box to deploy to.',
      severity: 'hard',
      fixes: [{ kind: 'interactive', label: 'Capture + verify the VPS target', command: 'convoy connect vps', autoFixable: false }],
    });
    return { ok: false, platform: 'vps', checks, blockers, detail: 'no host configured' };
  }

  if (!opts.probeRemote) {
    return {
      ok: true,
      platform: 'vps',
      checks,
      blockers: [],
      detail: `host ${host} configured — remote auth not probed (no consent)`,
    };
  }

  const identityFile = identity?.ref.kind === 'ssh-key-path' ? identity.ref.path : undefined;
  const auth = await deps.probeSshAuth(host!, {
    ...(identityFile ? { identityFile } : {}),
    ...(target?.port ? { port: target.port } : {}),
  });
  const authOk = auth.status === 'connected';
  checks.push({
    area: 'auth',
    ok: authOk,
    required: true,
    summary: authOk ? `SSH connected${auth.user ? ` as ${auth.user}` : ''}` : auth.detail,
    ...(authOk ? {} : { remedy: auth.detail }),
  });
  if (!authOk) {
    const fix: BlockerFix = auth.status === 'auth-failed'
      ? { kind: 'interactive', label: 'Trust your public key on the box', command: `ssh-copy-id ${host}`, autoFixable: false }
      : { kind: 'manual', label: 'Check the host IP, port and firewall', autoFixable: false };
    blockers.push({
      id: `access.vps.${auth.status === 'auth-failed' ? 'auth' : 'unreachable'}`,
      title: auth.status === 'auth-failed' ? 'SSH key not trusted on the box yet' : `Cannot reach ${host}`,
      detail: auth.detail,
      severity: 'hard',
      fixes: [fix],
    });
    return { ok: false, platform: 'vps', checks, blockers, ...(auth.user ? { account: auth.user } : {}), detail: auth.detail };
  }

  // Connected — confirm the box can actually run a container deploy.
  const deployRoot = target?.deployRoot ?? `/srv/${target?.appName ?? 'convoy-app'}`;
  const remote = await deps.probeRemote({ host: host!, deployRoot, ...(target?.port ? { port: target.port } : {}), ...(identityFile ? { identityFile } : {}) });
  checks.push({
    area: 'rollback',
    ok: remote.hasDocker,
    required: true,
    summary: remote.hasDocker ? 'docker present on the box' : 'docker not installed on the box',
    ...(remote.hasDocker ? {} : { remedy: `Provision it: convoy vps bootstrap ${host}` }),
  });
  if (!remote.hasDocker) {
    blockers.push({
      id: 'access.vps.docker',
      title: `Docker is not installed on ${host}`,
      detail: 'Convoy deploys containers; the box needs Docker.',
      severity: 'hard',
      fixes: [{ kind: 'shell', label: 'Bootstrap Docker + Caddy on the box', command: `convoy vps bootstrap ${host} --yes`, autoFixable: false }],
    });
  }
  const ok = blockers.length === 0;
  return {
    ok,
    platform: 'vps',
    checks,
    blockers,
    ...(auth.user ? { account: auth.user } : {}),
    detail: ok ? `verified ${host}${auth.user ? ` as ${auth.user}` : ''}` : 'docker missing on the box',
  };
}

/**
 * Detect whether Convoy can reach + authenticate to the chosen platform's
 * target. Does not mutate anything. The caller decides what to do with a
 * non-ok result: walk the operator through fixes (interactive) or exit-2 (CI).
 */
export async function verifyDeployAccess(
  platform: Platform,
  repoPath: string,
  target: DeployTarget | null,
  identity: DeployIdentity | null,
  opts: VerifyOptions = {},
  deps: VerifyDeps = defaultDeps,
): Promise<AccessVerifyResult> {
  if (platform === 'vps') return verifyVps(repoPath, target, identity, opts, deps);
  return verifyCloud(platform, repoPath, target, opts, deps);
}
