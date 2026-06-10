import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ByokConfig {
  provider: 'infisical' | 'direct';
  // direct
  apiKey?: string;
  // infisical universal auth
  siteUrl?: string;       // default: https://app.infisical.com
  clientId?: string;
  clientSecret?: string;
  projectId?: string;
  environment?: string;
  secretName?: string;    // default: ANTHROPIC_API_KEY
}

/**
 * Load .convoy/byok.json from a project directory if it exists.
 * This file is gitignored — teams drop it in their repo root to configure
 * BYOK without any env vars or CLI flags.
 */
export function loadByokConfig(projectDir: string): ByokConfig | null {
  const path = join(projectDir, '.convoy', 'byok.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ByokConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve the Anthropic API key from BYOK config, falling back to env vars.
 *
 * Priority:
 *   1. Passed config (from MCP byok param or explicit caller)
 *   2. process.env.ANTHROPIC_API_KEY
 *   3. process.env.CONVOY_ANTHROPIC_API_KEY  (operator override without
 *      clobbering the server's own key)
 *
 * For Infisical: universal-auth login → fetch secret. The access token is
 * ephemeral and scoped to this call — nothing is persisted.
 */
export async function resolveAnthropicKey(
  config?: ByokConfig | null,
): Promise<string | null> {
  if (!config) {
    return (
      process.env['ANTHROPIC_API_KEY'] ??
      process.env['CONVOY_ANTHROPIC_API_KEY'] ??
      null
    );
  }

  if (config.provider === 'direct') {
    return config.apiKey ?? null;
  }

  if (config.provider === 'infisical') {
    return fetchFromInfisical(config);
  }

  return process.env['ANTHROPIC_API_KEY'] ?? null;
}

async function fetchFromInfisical(cfg: ByokConfig): Promise<string | null> {
  const base = (cfg.siteUrl ?? 'https://app.infisical.com').replace(/\/$/, '');

  if (!cfg.clientId || !cfg.clientSecret || !cfg.projectId || !cfg.environment) {
    throw new Error(
      'Infisical BYOK: clientId, clientSecret, projectId, and environment are required',
    );
  }

  // Universal auth — short-lived access token, never stored.
  const loginRes = await fetch(`${base}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => '');
    throw new Error(`Infisical auth failed (${loginRes.status}): ${body.slice(0, 240)}`);
  }
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  const secretName = cfg.secretName ?? 'ANTHROPIC_API_KEY';
  const url = new URL(`${base}/api/v3/secrets/raw/${encodeURIComponent(secretName)}`);
  url.searchParams.set('workspaceId', cfg.projectId);
  url.searchParams.set('environment', cfg.environment);
  url.searchParams.set('type', 'shared');

  const secretRes = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!secretRes.ok) {
    throw new Error(`Infisical secret "${secretName}" fetch failed (${secretRes.status})`);
  }
  const { secret } = (await secretRes.json()) as { secret: { secretValue: string } };
  return secret.secretValue || null;
}
