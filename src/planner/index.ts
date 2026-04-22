import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type {
  ConvoyPlan,
  PlanApproval,
  PlanDeployabilitySection,
  PlanEstimate,
  PlanPlatformDecision,
  PlanPromotionSection,
  PlanRehearsalSection,
  PlanRollbackSection,
  PlanRisk,
  PlanShipStep,
  PlanTarget,
} from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { draftAuthorSection } from './author.js';
import { enrichPlan, type EnrichmentOptions } from './enricher.js';
import { pickPlatform } from './picker.js';
import { scanRepository, repoName, type ScanResult } from './scanner.js';
import { resolveTarget, type ResolveOptions, type TargetResolution } from './target-resolver.js';

export interface BuildPlanOptions {
  repoUrl?: string;
  branch?: string;
  sha?: string;
  platformOverride?: Platform;
  workspace?: string;
  ai?: EnrichmentOptions;
}

export type BuildPlanResult = {
  plan: ConvoyPlan;
  enrichmentSource: 'ai' | 'cache' | 'skipped-no-key' | 'skipped-flag' | 'error' | 'deterministic';
};

export async function buildPlan(
  localPath: string,
  opts: BuildPlanOptions = {},
): Promise<BuildPlanResult> {
  const scan = scanRepository(localPath, opts.workspace ? { workspace: opts.workspace } : {});

  const deployability = toPlanDeployability(scan);
  const platform = resolvePlatform(scan, opts.platformOverride, deployability);
  const author =
    deployability.verdict === 'not-cloud-deployable'
      ? { convoyAuthoredFiles: [] }
      : draftAuthorSection(scan, platform.chosen);

  const rehearsal = defaultRehearsal(scan, platform.chosen);
  const promotion = defaultPromotion();
  const rollback = defaultRollback(platform.chosen);
  const approvals = defaultApprovals();
  const estimate = defaultEstimate();
  const risks = toPlanRisks(scan);
  const summary = buildSummary(scan, platform, deployability);
  const shipNarrative = defaultShipNarrative(scan, platform.chosen, rehearsal, promotion, rollback, author.convoyAuthoredFiles.length);

  const target: PlanTarget = {
    repoUrl: opts.repoUrl ?? null,
    localPath,
    workspace: opts.workspace ?? null,
    name: repoName(localPath) || basename(localPath),
    branch: opts.branch ?? null,
    sha: opts.sha ?? null,
    mode: 'first-deploy',
    ecosystem: scan.ecosystem,
    framework: scan.framework,
    topology: scan.topology,
    readmeTitle: scan.readmeTitle,
    readmeExcerpt: scan.readmeFirstPara,
  };

  const baseline: ConvoyPlan = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    target,
    summary,
    deployability,
    platform,
    author,
    rehearsal,
    promotion,
    rollback,
    approvals,
    risks,
    estimate,
    evidence: scan.evidence,
    shipNarrative,
  };

  if (deployability.verdict === 'not-cloud-deployable') {
    return { plan: baseline, enrichmentSource: 'deterministic' };
  }

  const enriched = await enrichPlan(scan, baseline, opts.ai ?? {});
  return { plan: enriched.plan, enrichmentSource: enriched.source };
}

function toPlanDeployability(scan: ScanResult): PlanDeployabilitySection {
  return {
    verdict: scan.deployability,
    reason: scan.deployabilityReason,
  };
}

function resolvePlatform(
  scan: ScanResult,
  override: Platform | undefined,
  deployability: PlanDeployabilitySection,
): PlanPlatformDecision {
  if (deployability.verdict === 'not-cloud-deployable') {
    return {
      chosen: 'fly',
      source: 'refused',
      reason:
        'Refused to pick a platform because this repo is not a cloud-deployable service. See the deployability verdict above.',
      candidates: [],
    };
  }
  return pickPlatform(scan, override);
}

function toPlanRisks(scan: ScanResult): PlanRisk[] {
  return scan.risks.map((r) => ({ level: r.level, message: r.message }));
}

function buildSummary(
  scan: ScanResult,
  platform: PlanPlatformDecision,
  deployability: PlanDeployabilitySection,
): string {
  if (deployability.verdict === 'not-cloud-deployable') {
    return `${scan.readmeTitle ?? repoName(scan.localPath)} appears to be a ${describeEcosystem(scan)} target, which Convoy does not ship to cloud infrastructure.`;
  }
  const ecosystem = describeEcosystem(scan);
  const frameworkPart = scan.framework ? ` running ${scan.framework}` : '';
  const dataPart =
    scan.dataLayer.length > 0 ? ` with ${scan.dataLayer.join(' + ')}` : '';
  const platformPart = `Convoy will ship it to ${platform.chosen}`;
  return `${scan.readmeTitle ?? repoName(scan.localPath)} is a ${ecosystem} project${frameworkPart}${dataPart}. ${platformPart}.`;
}

function describeEcosystem(scan: ScanResult): string {
  switch (scan.ecosystem) {
    case 'node':
      return 'Node.js';
    case 'python':
      return 'Python';
    case 'go':
      return 'Go';
    case 'rust':
      return 'Rust';
    case 'ruby':
      return 'Ruby';
    case 'php':
      return 'PHP';
    case 'dotnet':
      return '.NET';
    case 'java-jvm':
      return 'JVM (Java)';
    case 'elixir':
      return 'Elixir';
    case 'swift':
      return 'Swift / iOS';
    case 'kotlin-android':
      return 'Kotlin / Android';
    case 'dart-flutter':
      return 'Dart / Flutter';
    case 'static':
      return 'static HTML';
    case 'mixed':
      return 'mixed-language';
    default:
      return 'unknown-ecosystem';
  }
}

function defaultRehearsal(scan: ScanResult, platform: Platform): PlanRehearsalSection {
  const validations: string[] = [];

  const pm = scan.packageManager;
  if (pm) validations.push(`${pm} install on the twin (lockfile-frozen)`);

  if (scan.hasDockerfile) {
    validations.push(`your Dockerfile (base ${scan.dockerfileBase ?? 'unknown'}) builds clean`);
  } else if (platform === 'vercel') {
    validations.push(`Vercel build${scan.buildCommand ? ` (\`${scan.buildCommand}\`)` : ''} succeeds`);
  } else {
    validations.push(`Convoy-drafted Dockerfile builds clean${scan.buildCommand ? ` (\`${scan.buildCommand}\`)` : ''}`);
  }

  const usesPrisma =
    scan.dataLayer.some((d) => d.includes('prisma')) || scan.topLevelDirs.includes('prisma');
  if (usesPrisma) {
    validations.push('`prisma generate` runs during image build');
    validations.push('`prisma migrate deploy` dry-run against scratch data (measures lock duration)');
  }

  validations.push(
    scan.startCommand
      ? `service boots via \`${scan.startCommand}\` on port ${scan.port ?? 8080}`
      : `container boots on port ${scan.port ?? 8080} and accepts connections`,
  );

  if (scan.healthPath) validations.push(`GET ${scan.healthPath} returns 200 within envelope`);
  else validations.push('TCP health probe (no health route detected — worth adding one)');

  if (scan.testCommand) {
    validations.push(`smoke suite: \`${scan.testCommand}\``);
  } else {
    validations.push('no test command found — rehearsal skips the smoke suite');
  }

  validations.push('cold-start latency within envelope vs. the last healthy release');
  validations.push('60s synthetic load · p99 within baseline tolerance · no new error fingerprints');

  return {
    enabled: true,
    targetDescriptor:
      platform === 'fly'
        ? `fly ephemeral app \`${repoName(scan.localPath)}-rehearsal-<sha>\` in iad`
        : platform === 'railway'
          ? `railway preview of \`${repoName(scan.localPath)}\` with scratch add-ons`
          : platform === 'vercel'
            ? `vercel preview deployment for \`${repoName(scan.localPath)}\``
            : `cloud run revision \`${repoName(scan.localPath)}-rehearsal-<sha>\` in us-central1`,
    buildCommand: scan.buildCommand,
    startCommand: scan.startCommand,
    expectedPort: scan.port,
    validations,
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

function defaultShipNarrative(
  scan: ScanResult,
  platform: Platform,
  rehearsal: PlanRehearsalSection,
  promotion: PlanPromotionSection,
  rollback: PlanRollbackSection,
  authoredCount: number,
): PlanShipStep[] {
  const steps: PlanShipStep[] = [];
  const pm = scan.packageManager ?? 'npm';
  const buildCmd = rehearsal.buildCommand ? `\`${rehearsal.buildCommand}\`` : 'your build';
  const startCmd = rehearsal.startCommand ? `\`${rehearsal.startCommand}\`` : 'your start command';
  const hasPrisma =
    scan.dataLayer.some((d) => d.includes('prisma')) || scan.topLevelDirs.includes('prisma');
  const hasMigrations =
    hasPrisma || scan.topLevelDirs.includes('migrations') || scan.dataLayer.some((d) => d.includes('postgres') || d.includes('mysql'));

  steps.push({
    step: 1,
    kind: 'approval',
    text: authoredCount > 0
      ? `I'll open a pull request with ${authoredCount} file${authoredCount === 1 ? '' : 's'} I drafted. You review the diff and merge — I don't merge on my own.`
      : `I'll open a pull request (or skip — your repo already has everything I need). You merge.`,
  });

  const rehearseDetails: string[] = [`install with ${pm} on a scratch volume`];
  if (rehearsal.buildCommand) rehearseDetails.push(`run ${buildCmd}`);
  if (hasPrisma) rehearseDetails.push('`prisma generate` during image build');
  if (hasMigrations) rehearseDetails.push('run migrations against scratch schema and measure lock duration');
  rehearseDetails.push(
    scan.startCommand
      ? `boot via ${startCmd} and wait for ${scan.healthPath ?? '/health'} to return 200`
      : `boot and wait for ${scan.healthPath ?? '/health'} to return 200`,
  );
  if (scan.testCommand) rehearseDetails.push(`run your smoke suite: \`${scan.testCommand}\``);
  rehearseDetails.push('probe with 60s of synthetic load and compare p99 to the last healthy baseline');
  rehearseDetails.push('then tear the twin down');

  steps.push({
    step: 2,
    kind: 'action',
    text: `I'll rehearse on ${rehearsal.targetDescriptor} before anything real happens.`,
    details: rehearseDetails,
  });

  steps.push({
    step: 3,
    kind: 'approval',
    text: `If rehearsal is clean, I'll ask you to promote. No canary traffic without your yes.`,
  });

  const promoteSteps = promotion.steps.map((s) => `${s.trafficPercent}%`).join(' → ');
  const firstBake = promotion.steps[0]?.bakeWindowSeconds ?? 30;
  steps.push({
    step: 4,
    kind: 'action',
    text: `On approval, I'll start a canary at ${promotion.canary.trafficPercent}% of traffic for a ${promotion.canary.bakeWindowSeconds}s bake.`,
    details: [
      `I halt the promotion the moment any of these fire: ${promotion.haltOn.join('; ')}`,
    ],
  });

  steps.push({
    step: 5,
    kind: 'action',
    text: `If the canary holds, I'll step it up: ${promoteSteps} with a ${firstBake}s bake between each step — watching the same signals every time.`,
  });

  steps.push({
    step: 6,
    kind: 'action',
    text: `Once I'm at 100%, I'll keep watching for the observe window. If anything breaches, I roll back via \`${rollback.strategy}\` in about ${rollback.estimatedSeconds}s — no one has to page anyone.`,
  });

  return steps;
}

function defaultEstimate(): PlanEstimate {
  return {
    runTimeMinutesMin: 4,
    runTimeMinutesMax: 7,
    opusSpendUsdMin: 0.2,
    opusSpendUsdMax: 0.5,
  };
}

export { scanRepository, pickPlatform, draftAuthorSection, resolveTarget };
export type { ScanResult, TargetResolution, ResolveOptions };
