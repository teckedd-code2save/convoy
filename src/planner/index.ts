import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type {
  ConvoyPlan,
  DeploymentLane,
  PlanApproval,
  PlanDeployabilitySection,
  PlanEstimate,
  PlanLaneDependency,
  PlanPlatformDecision,
  PlatformConnectionRequirement,
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
import { pickPlatform, pickPlatformForLane } from './picker.js';
import { scanRepository, scanServiceGraph, repoName, type ScanResult, type ServiceNode } from './scanner.js';
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
  const graph = scanServiceGraph(localPath, opts.workspace ? { workspace: opts.workspace } : {});

  const deployability = toPlanDeployability(scan);
  const platform = resolvePlatform(scan, opts.platformOverride, deployability);
  const lanes = deployability.verdict === 'not-cloud-deployable'
    ? [] as DeploymentLane[]
    : graph.nodes.map((node) => buildLane(node, opts.platformOverride));
  const dependencies = buildDependencies(lanes);
  const connectionRequirements = buildConnectionRequirements(lanes);
  const author = {
    convoyAuthoredFiles: dedupeAuthoredFiles(lanes.flatMap((lane) => lane.author.convoyAuthoredFiles)),
  };

  const primaryLane = lanes[0];
  const rehearsal = primaryLane?.rehearsal ?? defaultRehearsal(scan, platform.chosen);
  const promotion = primaryLane?.promotion ?? defaultPromotion();
  const rollback = primaryLane?.rollback ?? defaultRollback(platform.chosen);
  const approvals = primaryLane?.approvals ?? defaultApprovals();
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
    version: 2,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    repo: {
      repoUrl: opts.repoUrl ?? null,
      localPath,
      branch: opts.branch ?? null,
      sha: opts.sha ?? null,
      mode: 'first-deploy',
      name: repoName(localPath) || basename(localPath),
      readmeTitle: scan.readmeTitle,
      readmeExcerpt: scan.readmeFirstPara,
    },
    lanes,
    dependencies,
    connectionRequirements,
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

function buildLane(node: ServiceNode, override?: Platform): DeploymentLane {
  const platformDecision = pickPlatformForLane(node, override);
  const author = draftAuthorSection(node.scan, platformDecision.chosen);
  const rehearsal = defaultRehearsal(node.scan, platformDecision.chosen);
  const promotion = defaultPromotion();
  const rollback = defaultRollback(platformDecision.chosen);
  const approvals = defaultApprovals();
  return {
    id: node.id,
    role: node.role,
    servicePath: node.path,
    displayName: node.name,
    scan: {
      ecosystem: node.ecosystem,
      framework: node.framework,
      topology: node.topology,
      dataLayer: node.dataLayer,
      startCommand: node.startCommand,
      buildCommand: node.buildCommand,
      testCommand: node.testCommand,
      healthPath: node.healthPath,
      port: node.port,
      evidence: node.evidence,
      risks: node.risks.map((risk) => ({ level: risk.level, message: risk.message })),
    },
    platformDecision,
    author,
    rehearsal,
    promotion,
    rollback,
    approvals,
    secrets: {
      expectedKeys: node.secretsHints.expectedKeys,
      sources: node.secretsHints.sources,
    },
    statusNarrative: [
      `I'll scan ${node.path} as a ${node.role} lane.`,
      `I'll fit ${node.path} to ${platformDecision.chosen} based on its own evidence, not the repo's first detected child.`,
    ],
  };
}

function buildDependencies(lanes: DeploymentLane[]): PlanLaneDependency[] {
  const out: PlanLaneDependency[] = [];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  for (const lane of lanes) {
    const deps = inferLaneDependencies(lane, byId);
    for (const dep of deps) {
      out.push({
        from: dep.id,
        to: lane.id,
        reason: dependencyReason(dep.role, lane.role),
      });
    }
  }
  return out;
}

function inferLaneDependencies(
  lane: DeploymentLane,
  byId: Map<string, DeploymentLane>,
): DeploymentLane[] {
  const deps: DeploymentLane[] = [];
  for (const other of byId.values()) {
    if (other.id === lane.id) continue;
    if (lane.role === 'frontend' && (other.role === 'backend' || other.role === 'worker' || other.role === 'infra')) {
      deps.push(other);
    } else if ((lane.role === 'backend' || lane.role === 'worker') && other.role === 'infra') {
      deps.push(other);
    }
  }
  return deps;
}

function dependencyReason(from: DeploymentLane['role'], to: DeploymentLane['role']): string {
  if (from === 'infra') return 'shared platform/account/env prerequisites must be ready first';
  if (to === 'frontend') return 'frontend rollout depends on upstream services being deployed first';
  return 'fixed lane DAG';
}

function buildConnectionRequirements(lanes: DeploymentLane[]): PlatformConnectionRequirement[] {
  return lanes.map((lane) => ({
    laneId: lane.id,
    platform: lane.platformDecision.chosen,
    servicePath: lane.servicePath,
    requiresAuth: true,
    requiresProjectBinding: lane.platformDecision.chosen === 'vercel',
    expectedSecrets: lane.secrets.expectedKeys,
  }));
}

function dedupeAuthoredFiles(files: ReturnType<typeof draftAuthorSection>['convoyAuthoredFiles']) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return [...byPath.values()];
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
    healthPath: scan.healthPath,
    // Scanner doesn't detect metrics routes today — most Node services only
    // expose /metrics when prom_client is explicitly mounted. Leave null so
    // the runner falls back to its default probe and synthesized snapshot.
    metricsPath: null,
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
      kind: 'open_pr',
      description:
        'After rehearsal, Convoy shows the evidence and the drafted files. Your approval is what opens the PR — no repo state is changed before this.',
      required: true,
    },
    {
      kind: 'merge_pr',
      description: 'Once the PR is open, you review the diff on GitHub. Your approval is what merges it.',
      required: true,
    },
    {
      kind: 'promote',
      description: 'After the PR merges, promotion to canary requires human approval.',
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
    step: 1,
    kind: 'action',
    text: `I'll rehearse on ${rehearsal.targetDescriptor} before touching your repo.`,
    details: rehearseDetails,
  });

  steps.push({
    step: 2,
    kind: 'approval',
    text: authoredCount > 0
      ? `If rehearsal is clean, I'll show you the evidence and the ${authoredCount} file${authoredCount === 1 ? '' : 's'} I drafted. Your approval is what opens the PR — nothing in your repo changes before that.`
      : `If rehearsal is clean, I'll check in — your repo already has everything I need, so there's no PR to open.`,
  });

  steps.push({
    step: 3,
    kind: 'approval',
    text: `Once the PR is open, review the diff on GitHub. Your approval is what merges it — I never merge on my own.`,
  });

  steps.push({
    step: 4,
    kind: 'approval',
    text: `After merge, I'll ask you to promote. No canary traffic without your yes.`,
  });

  const promoteSteps = promotion.steps.map((s) => `${s.trafficPercent}%`).join(' → ');
  const firstBake = promotion.steps[0]?.bakeWindowSeconds ?? 30;
  steps.push({
    step: 5,
    kind: 'action',
    text: `On approval, I'll start a canary at ${promotion.canary.trafficPercent}% of traffic for a ${promotion.canary.bakeWindowSeconds}s bake.`,
    details: [
      `I halt the promotion the moment any of these fire: ${promotion.haltOn.join('; ')}`,
    ],
  });

  steps.push({
    step: 6,
    kind: 'action',
    text: `If the canary holds, I'll step it up: ${promoteSteps} with a ${firstBake}s bake between each step — watching the same signals every time.`,
  });

  steps.push({
    step: 7,
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
