/**
 * Shared "push one secret to the plan's chosen platform" logic (issue #22).
 *
 * Used by both the CLI (`convoy stage-secrets`) and the web plan page's
 * per-row "push to platform" button (server action in web/app/actions.ts —
 * web already imports src/ directly, see adapters/connections.js usage).
 *
 * Contract: NEVER throws. The local .env.convoy-secrets write is the source
 * of truth and always happens in the caller regardless; a platform push is
 * opportunistic. On any failure (CLI missing, unauthenticated, unlinked)
 * the caller falls back gracefully — the value will be staged at deploy
 * time via the existing realFly/realVercel/... secrets paths.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Platform } from './types.js';

export interface SecretPushContext {
  platform: Platform;
  /** Directory the platform CLI runs in (project binding lives here). */
  cwd: string;
  /** Fly app name / Cloud Run service name (auto-derived when omitted). */
  appName: string;
  cloudrunRegion?: string;
  cloudrunProject?: string;
  railwayProject?: string;
  /** SSH destination for the VPS lane; push is skipped when absent. */
  vpsHost?: string | null;
  vpsKey?: string;
  vpsPort?: number;
  vpsDeployRoot?: string;
}

export interface SecretPushResult {
  ok: boolean;
  /** Human-readable failure reason ("flyctl not installed", stderr tail…). */
  reason?: string;
}

/**
 * Minimal structural view of a plan — satisfied by both the core ConvoyPlan
 * and the web viewer's PlanSummary, so one context builder serves both.
 */
export interface PushablePlan {
  id: string;
  platform: { chosen: string };
  target: { name: string; localPath: string; workspace?: string | null };
}

/** Same slug heuristic the CLI uses for auto fly app names. */
export function autoAppName(targetName: string, planId: string): string {
  const base = targetName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'convoy-app';
  const hash = planId.slice(0, 6);
  return `convoy-${base}-${hash}`.slice(0, 30);
}

const PLATFORMS: readonly Platform[] = ['fly', 'railway', 'vercel', 'cloudrun', 'vps'];

/**
 * Derive a push context from a saved plan. The VPS host comes from team
 * preferences (deployment.vpsHost) or CONVOY_VPS_HOST — same precedence the
 * deploy lane uses.
 */
export async function buildPushContextFromPlan(plan: PushablePlan): Promise<SecretPushContext> {
  const chosen = PLATFORMS.includes(plan.platform.chosen as Platform)
    ? (plan.platform.chosen as Platform)
    : 'fly';
  const cwd = plan.target.workspace
    ? resolve(plan.target.localPath, plan.target.workspace)
    : plan.target.localPath;
  const appName = autoAppName(plan.target.name, plan.id);

  let vpsHost: string | null = process.env['CONVOY_VPS_HOST'] ?? null;
  try {
    const { loadPreferences } = await import('../onboard/preferences.js');
    const prefs = loadPreferences(plan.target.localPath);
    vpsHost = prefs?.deployment.vpsHost ?? vpsHost;
  } catch {
    // preferences unreadable — env fallback already applied
  }

  return {
    platform: chosen,
    cwd: existsSync(cwd) ? cwd : plan.target.localPath,
    appName,
    cloudrunRegion: 'us-central1',
    vpsHost,
    vpsDeployRoot: `/srv/${appName}`,
  };
}

export async function pushSecretToPlatform(
  key: string,
  value: string,
  ctx: SecretPushContext,
): Promise<SecretPushResult> {
  try {
    switch (ctx.platform) {
      case 'fly':
        return await pushFly(key, value, ctx);
      case 'vercel':
        return await pushVercel(key, value, ctx);
      case 'railway':
        return await pushRailway(key, value, ctx);
      case 'cloudrun':
        return await pushCloudRun(key, value, ctx);
      case 'vps':
        return await pushVps(key, value, ctx);
      default:
        return { ok: false, reason: `no push path for platform "${ctx.platform}"` };
    }
  } catch (err) {
    return { ok: false, reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
}

async function pushFly(key: string, value: string, ctx: SecretPushContext): Promise<SecretPushResult> {
  const { flyctlAvailable, flyAuthStatus, flySetSecrets } = await import('../adapters/fly/runner.js');
  if (!(await flyctlAvailable())) return { ok: false, reason: 'flyctl not installed' };
  const auth = await flyAuthStatus();
  if (!auth.ok) return { ok: false, reason: `fly not authenticated (${auth.error ?? 'fly auth login'})` };
  try {
    await flySetSecrets(ctx.appName, { [key]: value });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
}

async function pushVercel(key: string, value: string, ctx: SecretPushContext): Promise<SecretPushResult> {
  const { vercelAvailable, vercelSetEnv } = await import('../adapters/vercel/runner.js');
  if (!(await vercelAvailable())) return { ok: false, reason: 'vercel CLI not installed' };
  try {
    // vercelSetEnv pipes the value via stdin (`vercel env add KEY production`
    // with --force) — no interactive TTY needed, value never hits argv.
    await vercelSetEnv(ctx.cwd, key, value, 'production');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
}

async function pushRailway(key: string, value: string, ctx: SecretPushContext): Promise<SecretPushResult> {
  const { railwayAvailable, railwaySetVariable } = await import('../adapters/railway/runner.js');
  if (!(await railwayAvailable())) return { ok: false, reason: 'railway CLI not installed' };
  try {
    await railwaySetVariable(key, value, ctx.cwd, ctx.railwayProject);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
}

async function pushCloudRun(key: string, value: string, ctx: SecretPushContext): Promise<SecretPushResult> {
  const { gcloudAvailable, cloudRunSetEnvVars } = await import('../adapters/cloudrun/runner.js');
  if (!(await gcloudAvailable())) return { ok: false, reason: 'gcloud not installed' };
  try {
    await cloudRunSetEnvVars({
      service: ctx.appName,
      region: ctx.cloudrunRegion ?? 'us-central1',
      envVars: { [key]: value },
      ...(ctx.cloudrunProject ? { project: ctx.cloudrunProject } : {}),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
}

async function pushVps(key: string, value: string, ctx: SecretPushContext): Promise<SecretPushResult> {
  if (!ctx.vpsHost || ctx.vpsHost.trim().length === 0) {
    return { ok: false, reason: 'no VPS host configured (set it via convoy onboard or CONVOY_VPS_HOST)' };
  }
  const { sshAvailable, sshExec } = await import('../adapters/vps/runner.js');
  if (!(await sshAvailable())) return { ok: false, reason: 'ssh not installed' };
  const deployRoot = ctx.vpsDeployRoot ?? `/srv/${ctx.appName}`;
  const target = {
    host: ctx.vpsHost,
    deployRoot,
    ...(ctx.vpsPort !== undefined ? { port: ctx.vpsPort } : {}),
    ...(ctx.vpsKey !== undefined ? { identityFile: ctx.vpsKey } : {}),
  };
  // Replace-or-append: drop any prior line for this key, then append the new
  // one. The value travels over stdin, never argv. Convoy owns everything
  // under deployRoot, so the env file is Convoy-authored by definition.
  const envFile = `${deployRoot}/.env.convoy`;
  const cmd = [
    `mkdir -p '${deployRoot}'`,
    `touch '${envFile}'`,
    `grep -v '^${key}=' '${envFile}' > '${envFile}.tmp' || true`,
    `cat >> '${envFile}.tmp'`,
    `mv '${envFile}.tmp' '${envFile}'`,
    `chmod 600 '${envFile}'`,
  ].join(' && ');
  const result = await sshExec(target, cmd, { input: `${key}=${value}\n`, timeoutMs: 20_000 });
  if (!result.ok) {
    return { ok: false, reason: trimReason(result.stderr || `ssh exited ${result.code}`) };
  }
  return { ok: true };
}

function trimReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 200);
}
