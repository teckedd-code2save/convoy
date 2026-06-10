import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
}

export const DEFAULT_PREFERENCES: Omit<DeployPreferences, 'version' | 'createdAt' | 'updatedAt'> = {
  deployment: {
    mode: 'first',
    approvers: [],
    canary: { strategy: 'canary', trafficPercent: 5, bakeWindowSeconds: 120, autoRollback: true },
    stagingApp: null,
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
  writeFileSync(p, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
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
