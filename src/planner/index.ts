import { randomUUID } from 'node:crypto';

import type {
  ConvoyPlan,
  PlanApproval,
  PlanEstimate,
  PlanPromotionSection,
  PlanRehearsalSection,
  PlanRollbackSection,
  PlanTarget,
} from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { draftAuthorSection } from './author.js';
import { pickPlatform } from './picker.js';
import { scanRepository, type ScanResult } from './scanner.js';

export interface BuildPlanOptions {
  repoUrl?: string;
  branch?: string;
  sha?: string;
  platformOverride?: Platform;
}

export function buildPlan(localPath: string, opts: BuildPlanOptions = {}): ConvoyPlan {
  const scan = scanRepository(localPath);
  const platform = pickPlatform(scan, opts.platformOverride);
  const author = draftAuthorSection(scan, platform.chosen);

  const rehearsal = defaultRehearsal(scan, platform.chosen);
  const promotion = defaultPromotion();
  const rollback = defaultRollback(platform.chosen);
  const approvals = defaultApprovals();
  const estimate = defaultEstimate();

  const target: PlanTarget = {
    repoUrl: opts.repoUrl ?? null,
    localPath,
    branch: opts.branch ?? null,
    sha: opts.sha ?? null,
    mode: 'first-deploy',
  };

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    target,
    platform,
    author,
    rehearsal,
    promotion,
    rollback,
    approvals,
    estimate,
  };
}

function defaultRehearsal(_scan: ScanResult, platform: Platform): PlanRehearsalSection {
  return {
    enabled: true,
    targetDescriptor:
      platform === 'fly'
        ? 'fly ephemeral app in iad, lifecycle ~5 min'
        : platform === 'railway'
          ? 'railway preview environment'
          : platform === 'vercel'
            ? 'vercel preview deployment'
            : 'cloud run revision in us-central1 with suffix',
    validations: [
      'build succeeds',
      'health endpoint returns 200',
      'smoke tests',
      'cold-start under envelope',
      '60s synthetic load · p99 within baseline',
    ],
    estimatedDurationSeconds: 300,
    estimatedCost: 'under $0.05 per rehearsal',
  };
}

function defaultPromotion(): PlanPromotionSection {
  return {
    canary: { trafficPercent: 5, bakeWindowSeconds: 120 },
    steps: [
      { trafficPercent: 10, bakeWindowSeconds: 30 },
      { trafficPercent: 25, bakeWindowSeconds: 30 },
      { trafficPercent: 50, bakeWindowSeconds: 30 },
      { trafficPercent: 100, bakeWindowSeconds: 30 },
    ],
    haltOn: [
      'p99 latency delta > 30% vs. baseline',
      'error rate delta > 0.5 percentage points',
      'new error log fingerprints appear',
    ],
  };
}

function defaultRollback(platform: Platform): PlanRollbackSection {
  return {
    strategy:
      platform === 'fly'
        ? 'flyctl releases rollback'
        : platform === 'railway'
          ? 'railway redeploy previous'
          : platform === 'vercel'
            ? 'vercel alias previous deployment'
            : 'gcloud run services update-traffic prior revision',
    target: 'previous healthy release (auto-selected, verified before apply)',
    estimatedSeconds: 10,
  };
}

function defaultApprovals(): PlanApproval[] {
  return [
    {
      kind: 'merge_pr',
      description: 'Convoy opens a PR with the Convoy-authored files — requires merge approval.',
      required: true,
    },
    {
      kind: 'promote',
      description: 'After clean rehearsal, promotion to canary requires human approval.',
      required: true,
    },
    {
      kind: 'rollback',
      description: 'Rollbacks are always human-executed, never autonomous.',
      required: true,
    },
  ];
}

function defaultEstimate(): PlanEstimate {
  return {
    runTimeMinutesMin: 4,
    runTimeMinutesMax: 7,
    opusSpendUsdMin: 0.2,
    opusSpendUsdMax: 0.5,
  };
}

export { scanRepository, pickPlatform, draftAuthorSection };
export type { ScanResult };
