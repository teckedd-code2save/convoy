/**
 * First-class secrets-manager integration (issue #36).
 *
 * Supports:
 *   - Infisical: universal-auth (client-id + client-secret) → /v3/secrets/raw
 *   - Doppler: doppler CLI (doppler secrets download --no-file)
 *   - Vault: vault CLI (vault kv get -format=json)
 *
 * All functions follow the same contract:
 *   - They return { ok: boolean, secrets?: Record<string,string>, error?: string }
 *   - They never print secret values to stdout/logs — only counts and key names
 *   - They time out within 10s so preflight health probes are fast
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function runCmd(cmd: string, timeoutMs = 10_000): Promise<{ out: string; err: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: timeoutMs });
    return { out: stdout, err: stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { out: e.stdout ?? '', err: e.stderr ?? String(err), code: e.code ?? 1 };
  }
}

export interface SecretsResult {
  ok: boolean;
  secrets?: Record<string, string>;
  count?: number;
  error?: string;
}

export interface ManagerHealth {
  reachable: boolean;
  manager: string;
  url?: string;
  error?: string;
}

// ─── Infisical ────────────────────────────────────────────────────────────────

interface InfisicalConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  siteUrl: string;
}

function infisicalConfig(): InfisicalConfig | null {
  const clientId = process.env['INFISICAL_CLIENT_ID'];
  const clientSecret = process.env['INFISICAL_CLIENT_SECRET'];
  const projectId = process.env['INFISICAL_PROJECT_ID'] ?? process.env['INFISICAL_WORKSPACE_ID'];
  const environment = process.env['INFISICAL_ENVIRONMENT'] ?? 'dev';
  const siteUrl = (process.env['INFISICAL_SITE_URL'] ?? 'https://app.infisical.com').replace(/\/$/, '');
  if (!clientId || !clientSecret || !projectId) return null;
  return { clientId, clientSecret, projectId, environment, siteUrl };
}

async function infisicalToken(cfg: InfisicalConfig): Promise<string> {
  const res = await fetch(`${cfg.siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Infisical login HTTP ${res.status}`);
  const data = await res.json() as { accessToken?: string };
  if (!data.accessToken) throw new Error('Infisical login returned no accessToken');
  return data.accessToken;
}

export async function infisicalPull(keys?: string[]): Promise<SecretsResult> {
  const cfg = infisicalConfig();
  if (!cfg) {
    return { ok: false, error: 'Infisical credentials not configured (need INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID)' };
  }
  try {
    const token = await infisicalToken(cfg);
    const url = `${cfg.siteUrl}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(cfg.projectId)}&environment=${encodeURIComponent(cfg.environment)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Infisical secrets HTTP ${res.status}`);
    const data = await res.json() as { secrets?: Array<{ secretKey: string; secretValue: string }> };
    const all: Record<string, string> = {};
    for (const s of data.secrets ?? []) {
      all[s.secretKey] = s.secretValue;
    }
    // Filter to requested keys if provided
    const filtered = keys && keys.length > 0
      ? Object.fromEntries(Object.entries(all).filter(([k]) => keys.includes(k)))
      : all;
    return { ok: true, secrets: filtered, count: Object.keys(filtered).length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function infisicalHealth(): Promise<ManagerHealth> {
  const cfg = infisicalConfig();
  const url = cfg?.siteUrl ?? process.env['INFISICAL_SITE_URL'] ?? 'https://app.infisical.com';
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5_000) });
    return { reachable: res.ok, manager: 'infisical', url };
  } catch (err) {
    return { reachable: false, manager: 'infisical', url, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Doppler ─────────────────────────────────────────────────────────────────

export async function dopplerPull(keys?: string[]): Promise<SecretsResult> {
  const { out, code, err } = await runCmd('doppler secrets download --no-file --format json 2>&1');
  if (code !== 0) {
    return { ok: false, error: err || out || 'doppler CLI failed' };
  }
  try {
    const raw = JSON.parse(out) as Record<string, string>;
    // Doppler includes metadata keys like DOPPLER_CONFIG, DOPPLER_PROJECT etc.
    const filtered = keys && keys.length > 0
      ? Object.fromEntries(Object.entries(raw).filter(([k]) => keys.includes(k)))
      : Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('DOPPLER_')));
    return { ok: true, secrets: filtered, count: Object.keys(filtered).length };
  } catch {
    return { ok: false, error: 'Failed to parse doppler output as JSON' };
  }
}

export async function dopplerHealth(): Promise<ManagerHealth> {
  const { code } = await runCmd('doppler me --json', 5_000);
  return { reachable: code === 0, manager: 'doppler' };
}

// ─── Vault ───────────────────────────────────────────────────────────────────

export async function vaultPull(mountPath = 'secret', secretPath = 'convoy/app', keys?: string[]): Promise<SecretsResult> {
  const path = process.env['VAULT_SECRET_PATH'] ?? `${mountPath}/${secretPath}`;
  const { out, code, err } = await runCmd(`vault kv get -format=json ${path}`, 10_000);
  if (code !== 0) {
    return { ok: false, error: err || out || 'vault CLI failed' };
  }
  try {
    const raw = JSON.parse(out) as { data?: { data?: Record<string, string> } };
    const all = raw.data?.data ?? {};
    const filtered = keys && keys.length > 0
      ? Object.fromEntries(Object.entries(all).filter(([k]) => keys.includes(k)))
      : all;
    return { ok: true, secrets: filtered, count: Object.keys(filtered).length };
  } catch {
    return { ok: false, error: 'Failed to parse vault output as JSON' };
  }
}

export async function vaultHealth(): Promise<ManagerHealth> {
  const addr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200';
  try {
    const res = await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(5_000) });
    return { reachable: res.ok || res.status === 429, manager: 'vault', url: addr };
  } catch (err) {
    return { reachable: false, manager: 'vault', url: addr, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export type SecretsManagerKind = 'infisical' | 'doppler' | 'vault' | 'aws-sm' | 'unknown' | 'platform-native' | 'env-file';

export async function pullFromManager(manager: SecretsManagerKind, keys?: string[]): Promise<SecretsResult> {
  switch (manager) {
    case 'infisical': return infisicalPull(keys);
    case 'doppler': return dopplerPull(keys);
    case 'vault': return vaultPull(undefined, undefined, keys);
    default: return { ok: false, error: `Secrets manager "${manager}" is not yet supported for pull. Supported: infisical, doppler, vault.` };
  }
}

export async function healthCheckManager(manager: SecretsManagerKind): Promise<ManagerHealth> {
  switch (manager) {
    case 'infisical': return infisicalHealth();
    case 'doppler': return dopplerHealth();
    case 'vault': return vaultHealth();
    default: return { reachable: true, manager };
  }
}
