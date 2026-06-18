import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Platform } from '../core/types.js';

/**
 * Where this project's secrets live — a *pointer*, never the values. Convoy
 * detects the convention (orient sniffs .infisical.json/.doppler.yaml/etc.;
 * the connect walkthrough asks once when ambiguous) and stages new/changed
 * secrets through that channel. Deliberately platform/manager-agnostic — no
 * backend is assumed or hardcoded.
 */
export type SecretSourceRef =
  | { kind: 'platform-native' } // fly secrets / vercel env / cloudrun --set-secrets
  | { kind: 'manager'; manager: 'doppler' | 'infisical' | 'vault' | 'aws-sm' | 'azure-devops' }
  | { kind: 'env-file' } // the box's own .env / committed .env.example contract
  | { kind: 'interactive' }; // operator stages by hand via `convoy stage-secrets`

export interface AccessVerification {
  /** ISO timestamp of the last successful verification, or null if never. */
  verifiedAt: string | null;
  status: 'verified' | 'failed' | 'stale' | 'unverified';
  /** e.g. fly user, ssh remote user — non-secret, for operator confidence. */
  account?: string;
  /** Human one-liner from the probe. */
  detail?: string;
}

/**
 * A committed, non-secret deploy target. This is infra-as-code: it travels in
 * `.convoy/preferences.json` so a teammate who pulls inherits where this repo
 * deploys. It NEVER holds a private key, password, or token — only
 * coordinates and a pointer to where secrets live. The per-developer SSH
 * identity lives machine-side in `~/.convoy/identity.json`, never here.
 */
export interface DeployTarget {
  platform: Platform;
  /** SSH destination user@host (vps) — non-secret coordinate. */
  host?: string;
  /** Remote user when not encoded in host. */
  user?: string;
  port?: number;
  /** fly app / cloudrun service / railway service name. */
  appName?: string;
  /** GHCR image ref without tag, e.g. ghcr.io/org/app — non-secret. */
  imageRef?: string;
  domain?: string;
  deployRoot?: string;
  region?: string;
  secretSource: SecretSourceRef;
  verification: AccessVerification;
}

export interface DeployPreferences {
  version: 1;
  createdAt: string;
  updatedAt: string;
  deployment: {
    mode: 'first' | 'update';
    approvers: string[];        // [] = auto-approve
    canary: {
      strategy: 'skip' | 'canary' | 'bluegreen';
      trafficPercent: number;
      bakeWindowSeconds: number;
      autoRollback: boolean;
    };
    stagingApp: string | null;
    /** SSH destination for the VPS lane (user@host or bare IP/hostname). */
    vpsHost?: string | null;
  };
  platform: {
    mandate: string | null;
    budgetTier: 'hobby' | 'startup' | 'growth' | 'unconstrained';
  };
  release: {
    cadence: 'many-per-day' | 'daily' | 'weekly' | 'infrequent';
    gate: 'pr-merged' | 'pr-staging' | 'pr-staging-approver' | 'change-ticket';
    freezeDescription: string | null;
  };
  secrets: {
    manager: 'env-file' | 'doppler' | 'infisical' | 'vault' | 'aws-sm' | 'platform-native' | 'unknown';
    compliance: Array<'soc2' | 'hipaa' | 'pci' | 'gdpr'>;
    dataResidency: 'any' | 'us' | 'eu' | 'apac' | string;
  };
  observability: {
    errorTracking: string | null;
    metrics: string | null;
    notifications: {
      slack: { channel: string; webhookUrl: string } | null;
      prComments: boolean;
    };
  };
  _adaptive: {
    lastUpdated: string;
    services: Record<string, {
      trustLevel: 0 | 1 | 2 | 3 | 4;
      totalSuccessfulDeploys: number;
      rollbackRate: number;
      lastBreach: string | null;
      medianApprovalMs: Record<string, number>;
    }>;
  };
  /**
   * Committed, non-secret deploy targets keyed by platform. Populated by
   * `convoy connect` once access is verified, so a teammate who pulls inherits
   * where this repo deploys without re-running discovery. Optional so existing
   * preferences files load unchanged.
   */
  deploy?: {
    targets: Partial<Record<Platform, DeployTarget>>;
  };
}

export const DEFAULT_PREFERENCES: Omit<DeployPreferences, 'version' | 'createdAt' | 'updatedAt'> = {
  deployment: {
    mode: 'first',
    approvers: [],
    canary: { strategy: 'canary', trafficPercent: 5, bakeWindowSeconds: 120, autoRollback: true },
    stagingApp: null,
    vpsHost: null,
  },
  platform: { mandate: null, budgetTier: 'startup' },
  release: { cadence: 'daily', gate: 'pr-merged', freezeDescription: null },
  secrets: { manager: 'platform-native', compliance: [], dataResidency: 'any' },
  observability: { errorTracking: null, metrics: null, notifications: { slack: null, prComments: false } },
  _adaptive: { lastUpdated: new Date().toISOString(), services: {} },
};

export function prefsPath(repoPath: string): string {
  return resolve(repoPath, '.convoy', 'preferences.json');
}

export function loadPreferences(repoPath: string): DeployPreferences | null {
  const p = prefsPath(repoPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DeployPreferences;
  } catch {
    return null;
  }
}

export function savePreferences(repoPath: string, prefs: DeployPreferences): void {
  const p = prefsPath(repoPath);
  mkdirSync(resolve(repoPath, '.convoy'), { recursive: true });
  ensureConvoyGitignore(repoPath);
  writeFileSync(p, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
}

/**
 * `.convoy/preferences.json` is meant to be committed (team-shared deploy
 * config), but its siblings — the run state DB, saved plans, BYOK config,
 * web-server logs — must never be. We write a `.convoy/.gitignore` that keeps
 * those out of git while leaving preferences.json tracked. Idempotent: only
 * written when absent, so we never clobber an operator's edits.
 */
const CONVOY_GITIGNORE_ENTRIES = [
  '# Convoy: machine-local + sensitive artifacts (preferences.json is intentionally NOT ignored)',
  'state.db',
  'state.db-*',
  'plans/',
  'byok.json',
  'web-server.log',
  '*.convoy-secrets',
];

function ensureConvoyGitignore(repoPath: string): void {
  const giPath = resolve(repoPath, '.convoy', '.gitignore');
  if (existsSync(giPath)) return;
  writeFileSync(giPath, CONVOY_GITIGNORE_ENTRIES.join('\n') + '\n', 'utf8');
}

export function mergePreferences(existing: DeployPreferences | null, updates: Partial<Omit<DeployPreferences, 'version' | 'createdAt'>>): DeployPreferences {
  const now = new Date().toISOString();
  const base = existing ?? {
    version: 1 as const,
    createdAt: now,
    ...DEFAULT_PREFERENCES,
  };
  return {
    ...base,
    ...updates,
    version: 1 as const,
    updatedAt: now,
  };
}
