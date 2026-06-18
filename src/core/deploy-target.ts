/**
 * Helpers over the committed deploy-target model (the `deploy.targets` block
 * in `.convoy/preferences.json`). The TYPES live in onboard/preferences.ts
 * next to DeployPreferences (so preferences.ts has no import cycle); this file
 * is just the read/merge/persist sugar that `convoy connect` and the apply
 * access gate share.
 *
 * Everything here is non-secret coordinates + a verification stamp. No keys,
 * tokens, or passwords ever pass through these functions.
 */
import type { Platform } from './types.js';
import {
  loadPreferences,
  mergePreferences,
  savePreferences,
  type DeployTarget,
  type DeployPreferences,
  type SecretSourceRef,
} from '../onboard/preferences.js';

/**
 * Map a free-form `--secret-source` string (or MCP enum) to a SecretSourceRef
 * pointer. Unknown values fall back to the provided default rather than
 * throwing — secret source is advisory, never a hard gate.
 */
export function parseSecretSource(raw: string | undefined, fallback: SecretSourceRef): SecretSourceRef {
  if (!raw) return fallback;
  if (raw === 'platform-native' || raw === 'env-file' || raw === 'interactive') return { kind: raw };
  if (raw === 'doppler' || raw === 'infisical' || raw === 'vault' || raw === 'aws-sm' || raw === 'azure-devops') {
    return { kind: 'manager', manager: raw };
  }
  return fallback;
}

export function getTarget(repoPath: string, platform: Platform): DeployTarget | null {
  const prefs = loadPreferences(repoPath);
  return prefs?.deploy?.targets?.[platform] ?? null;
}

/**
 * True when the target exists and its last verification succeeded. The apply
 * gate uses this to decide "proceed silently" vs "walk the operator through
 * access". `stale`/`failed`/`unverified` all return false.
 */
export function isTargetVerified(target: DeployTarget | null | undefined): boolean {
  return target?.verification.status === 'verified';
}

/**
 * Insert or replace the target for its platform, preserving every other
 * preference. Creates the preferences file (with defaults) if none exists yet,
 * so `convoy connect` works on a repo that never ran onboard.
 */
export function upsertTarget(repoPath: string, target: DeployTarget): DeployPreferences {
  const existing = loadPreferences(repoPath);
  const targets = { ...(existing?.deploy?.targets ?? {}), [target.platform]: target };
  const next = mergePreferences(existing, { deploy: { targets } });
  savePreferences(repoPath, next);
  return next;
}
