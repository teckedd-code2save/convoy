/**
 * `convoy connect [platform]` — establish and verify deploy access up front,
 * resolving every blocker in place, then persist the (non-secret) target so
 * shipping never stops for auth later.
 *
 * Split of what gets persisted (see plan):
 *   - committed, non-secret coordinates → .convoy/preferences.json (team-shared)
 *   - this developer's SSH identity      → ~/.convoy/identity.json (machine-local)
 *   - secret VALUES                       → never; staged per the project's convention
 */
import * as readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';

import type { Platform } from '../core/types.js';
import type { DeployTarget, AccessVerification } from '../onboard/preferences.js';
import { getTarget, upsertTarget, parseSecretSource } from '../core/deploy-target.js';
import { getIdentity, setIdentity, type IdentityRef } from '../core/identity-store.js';
import { discoverLocalSshKeys } from '../adapters/vps/runner.js';
import { bootstrapVps } from '../adapters/vps/bootstrap.js';
import { verifyDeployAccess } from '../core/verify-access.js';
import { resolveAccessInteractive, type AccessFixer } from '../core/resolve-access.js';
import { loadPreferences } from '../onboard/preferences.js';

export interface ConnectOpts {
  vpsHost?: string;
  vpsKey?: string;
  vpsPort?: number;
  deployRoot?: string;
  app?: string;
  image?: string;
  domain?: string;
  region?: string;
  secretSource?: string;
  /** JSON file with a partial DeployTarget — for CI / MCP (non-interactive). */
  answersFile?: string;
  /** Skip remote probing (capture coordinates only). */
  noProbe?: boolean;
  /** Verify without resolving/persisting. */
  checkOnly?: boolean;
}

const VALID_PLATFORMS: Platform[] = ['fly', 'vercel', 'railway', 'cloudrun', 'vps'];

/**
 * The committed view of a target: strip the sensitive coordinates (host/user/
 * port) so they never land in version control. Everything left — platform,
 * appName, imageRef, domain, region, secret-source pointer — is shareable.
 */
function committedView(target: DeployTarget, _detail: string | undefined): DeployTarget {
  const { host: _h, user: _u, port: _p, ...rest } = target;
  return rest;
}

/** Remove the host substring from a human detail line before it's persisted. */
function hostFreeDetail(detail: string, host: string | undefined): string {
  return host ? detail.split(host).join('<host>') : detail;
}

/** CLI-backed fixer: real prompts + foreground subprocesses (stdio inherited). */
function makeCliFixer(rl: readline.Interface | null): AccessFixer {
  return {
    async confirm(question: string, def: boolean): Promise<boolean> {
      if (!rl) return false; // non-interactive: never auto-run logins
      const ans = (await rl.question(`${question} (${def ? 'Y/n' : 'y/N'}) `)).trim().toLowerCase();
      if (!ans) return def;
      return ans.startsWith('y');
    },
    runCommand(command: string): Promise<boolean> {
      const [bin, ...args] = command.split(' ').filter(Boolean);
      if (!bin) return Promise.resolve(false);
      output.write(pc.dim(`\n→ running: ${command}\n`));
      return new Promise((resolveP) => {
        const child = spawn(bin, args, { stdio: 'inherit' });
        child.on('error', () => resolveP(false));
        child.on('exit', (code) => resolveP(code === 0));
      });
    },
    async bootstrap(host: string): Promise<boolean> {
      const report = await bootstrapVps(
        { host, deployRoot: '/opt/convoy' },
        { onStep: (label, status, detail) => output.write(`  ${status === 'failed' ? pc.red('✗') : pc.green('✓')} ${label}${detail ? pc.dim(` — ${detail}`) : ''}\n`) },
      );
      return report.ok;
    },
    note(message: string): void {
      output.write(`${message}\n`);
    },
  };
}

/**
 * Resolve the deploy destination + identity for a platform, capturing from
 * flags → CONVOY_VPS_HOST → saved target → prompt. Returns the draft target
 * (pre-verification) and the chosen machine identity.
 */
async function captureTarget(
  repoPath: string,
  platform: Platform,
  opts: ConnectOpts,
  rl: readline.Interface | null,
): Promise<{ target: DeployTarget; identityRef: IdentityRef }> {
  const saved = getTarget(repoPath, platform);
  const prefs = loadPreferences(repoPath);
  const ask = async (q: string, def?: string): Promise<string | undefined> => {
    if (!rl) return def;
    const ans = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return ans || def;
  };

  const unverified: AccessVerification = { verifiedAt: null, status: 'unverified' };

  if (platform === 'vps') {
    const host =
      opts.vpsHost ??
      process.env['CONVOY_VPS_HOST'] ??
      saved?.host ??
      prefs?.deployment.vpsHost ??
      (await ask('VPS destination (user@host)'));
    if (!host) throw new Error('No VPS host provided. Pass --vps-host=user@host or set CONVOY_VPS_HOST.');

    // Identity: explicit key → discovered key → ssh-agent.
    let identityRef: IdentityRef;
    const existingIdent = getIdentity(repoPath, 'vps');
    if (opts.vpsKey) identityRef = { kind: 'ssh-key-path', path: opts.vpsKey };
    else if (existingIdent) identityRef = existingIdent.ref;
    else {
      const keys = discoverLocalSshKeys();
      identityRef = keys.length > 0 ? { kind: 'ssh-key-path', path: keys[0]! } : { kind: 'ssh-agent' };
    }

    const target: DeployTarget = {
      platform: 'vps',
      host,
      ...(opts.vpsPort ? { port: opts.vpsPort } : saved?.port ? { port: saved.port } : {}),
      ...(opts.deployRoot ?? saved?.deployRoot ? { deployRoot: opts.deployRoot ?? saved?.deployRoot } : {}),
      ...(opts.image ?? saved?.imageRef ? { imageRef: opts.image ?? saved?.imageRef } : {}),
      ...(opts.domain ?? saved?.domain ? { domain: opts.domain ?? saved?.domain } : {}),
      ...(opts.app ?? saved?.appName ? { appName: opts.app ?? saved?.appName } : {}),
      secretSource: parseSecretSource(opts.secretSource, saved?.secretSource ?? { kind: 'env-file' }),
      verification: unverified,
    };
    return { target, identityRef };
  }

  // Cloud platforms: the CLI holds auth; we just record coordinates + that the
  // identity is the platform's own cache.
  const target: DeployTarget = {
    platform,
    ...(opts.app ?? saved?.appName ? { appName: opts.app ?? saved?.appName } : {}),
    ...(opts.region ?? saved?.region ? { region: opts.region ?? saved?.region } : {}),
    ...(opts.domain ?? saved?.domain ? { domain: opts.domain ?? saved?.domain } : {}),
    secretSource: parseSecretSource(opts.secretSource, saved?.secretSource ?? { kind: 'platform-native' }),
    verification: unverified,
  };
  return { target, identityRef: { kind: 'cli-cache' } };
}

function applyAnswersFile(opts: ConnectOpts): ConnectOpts {
  if (!opts.answersFile) return opts;
  if (!existsSync(opts.answersFile)) throw new Error(`--answers-file not found: ${opts.answersFile}`);
  const parsed = JSON.parse(readFileSync(opts.answersFile, 'utf8')) as Partial<ConnectOpts>;
  return { ...parsed, ...opts, answersFile: opts.answersFile };
}

/**
 * Returns true when access is verified (so callers/CI can branch on it).
 */
export async function runConnect(repoPath: string, platformArg: string | undefined, rawOpts: ConnectOpts): Promise<boolean> {
  const opts = applyAnswersFile(rawOpts);
  const prefs = loadPreferences(repoPath);
  const platform = (platformArg ?? prefs?.platform.mandate ?? '') as Platform;
  if (!VALID_PLATFORMS.includes(platform)) {
    output.write(pc.red(`Specify a platform: convoy connect <${VALID_PLATFORMS.join('|')}>\n`));
    process.exitCode = 2;
    return false;
  }

  const interactive = process.stdin.isTTY && !opts.answersFile;
  const rl = interactive ? readline.createInterface({ input, output }) : null;

  try {
    output.write(`\n${pc.bold(`■ convoy connect ${platform}`)}\n`);
    const { target, identityRef } = await captureTarget(repoPath, platform, opts, rl);

    // --check-only: verify and report, never resolve or persist.
    if (opts.checkOnly) {
      const ident = getIdentity(repoPath, platform);
      const res = await verifyDeployAccess(platform, repoPath, target, ident ?? { platform, ref: identityRef, updatedAt: '' }, { probeRemote: !opts.noProbe });
      output.write(`${res.ok ? pc.green('✓') : pc.yellow('!')} ${res.detail}\n`);
      process.exitCode = res.ok ? 0 : 2;
      return res.ok;
    }

    // Persist the identity choice + the sensitive coordinates (host/port)
    // machine-local — they NEVER go into committed config. A box IP + user is
    // reconnaissance, not a credential; keeping it out of git is the default
    // standard regardless of repo visibility. Teammates set CONVOY_VPS_HOST or
    // run `convoy connect` themselves.
    const ident = setIdentity(repoPath, platform, identityRef, { host: target.host, port: target.port });

    if (opts.noProbe) {
      upsertTarget(repoPath, committedView(target, undefined));
      output.write(pc.dim(`Captured ${platform} target (not probed). Host kept local. Verify later with: convoy connect ${platform}\n`));
      return false;
    }

    const fixer = makeCliFixer(rl);
    const { ok, result } = await resolveAccessInteractive(platform, repoPath, target, ident, fixer);

    const detail = hostFreeDetail(result.detail, target.host);
    const verification: AccessVerification = ok
      ? { verifiedAt: new Date().toISOString(), status: 'verified', ...(result.account ? { account: result.account } : {}), detail }
      : { verifiedAt: null, status: 'failed', detail };
    upsertTarget(repoPath, { ...committedView(target, undefined), verification });

    if (ok) {
      output.write(`\n${pc.green('✓ access verified')} — ${result.detail}\n`);
      output.write(pc.dim(`  Shareable target saved to .convoy/preferences.json (commit it).\n`));
      output.write(pc.dim(`  Host kept machine-local in ~/.convoy — teammates set CONVOY_VPS_HOST or run \`convoy connect ${platform}\`.\n`));
    } else {
      output.write(`\n${pc.yellow('! access not fully established')} — ${result.detail}\n`);
      for (const b of result.blockers) output.write(`  ${pc.yellow('•')} ${b.title} — ${b.detail}\n`);
      process.exitCode = 2;
    }
    return ok;
  } finally {
    rl?.close();
  }
}
