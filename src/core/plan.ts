import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { LaneRole, Platform } from './types.js';

export type PlanDeployability =
  | 'deployable-web-service'
  | 'deployable-static-site'
  | 'not-cloud-deployable'
  | 'ambiguous';

export interface ConvoyPlan {
  version: 2;
  id: string;
  createdAt: string;
  repo: PlanRepo;
  lanes: DeploymentLane[];
  dependencies: PlanLaneDependency[];
  connectionRequirements: PlatformConnectionRequirement[];
  target: PlanTarget;
  summary: string;
  deployability: PlanDeployabilitySection;
  platform: PlanPlatformDecision;
  author: PlanAuthorSection;
  rehearsal: PlanRehearsalSection;
  promotion: PlanPromotionSection;
  rollback: PlanRollbackSection;
  approvals: PlanApproval[];
  risks: PlanRisk[];
  estimate: PlanEstimate;
  evidence: string[];
  shipNarrative: PlanShipStep[];
}

export interface PlanRepo {
  repoUrl: string | null;
  localPath: string;
  branch: string | null;
  sha: string | null;
  mode: 'first-deploy' | 'recurring';
  name: string;
  readmeTitle: string | null;
  readmeExcerpt: string | null;
}

export interface PlanShipStep {
  step: number;
  kind: 'action' | 'approval';
  text: string;
  details?: string[];
}

export interface PlanTarget {
  repoUrl: string | null;
  localPath: string;
  workspace: string | null;
  name: string;
  branch: string | null;
  sha: string | null;
  mode: 'first-deploy' | 'recurring';
  ecosystem: string;
  framework: string | null;
  topology: string;
  readmeTitle: string | null;
  readmeExcerpt: string | null;
}

export interface PlanDeployabilitySection {
  verdict: PlanDeployability;
  reason: string;
}

export interface PlanPlatformDecision {
  chosen: Platform;
  reason: string;
  source: 'override' | 'existing-config' | 'scored' | 'refused';
  candidates: PlanPlatformCandidate[];
}

export interface PlanPlatformCandidate {
  platform: Platform;
  score: number;
  reason: string;
}

export interface PlanLaneDependency {
  from: string;
  to: string;
  reason: string;
}

export interface PlatformConnectionRequirement {
  laneId: string;
  platform: Platform;
  servicePath: string;
  requiresAuth: boolean;
  requiresProjectBinding: boolean;
  expectedSecrets: string[];
}

export interface PlanAuthorSection {
  convoyAuthoredFiles: PlanAuthoredFile[];
}

export interface PlanAuthoredFile {
  path: string;
  lines: number;
  summary: string;
  contentPreview: string;
}

export interface PlanRehearsalSection {
  enabled: boolean;
  targetDescriptor: string;
  buildCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
  /**
   * Health route the scanner detected (or null if unknown). Runtime
   * rehearsal uses this as the authoritative probe path so the plan and
   * the runner agree on what "healthy" means. Plans written before this
   * field existed will be null, and the CLI falls back to `/health`.
   */
  healthPath: string | null;
  /**
   * Metrics route, if one was detected. The rehearsal runner scrapes this
   * for baseline + final snapshots. Null means "no metrics available" —
   * the runner synthesizes metrics from synthetic load in that case.
   */
  metricsPath: string | null;
  validations: string[];
  estimatedDurationSeconds: number;
  estimatedCost: string;
}

export interface PlanPromotionSection {
  canary: { trafficPercent: number; bakeWindowSeconds: number };
  steps: { trafficPercent: number; bakeWindowSeconds: number }[];
  haltOn: string[];
}

export interface PlanRollbackSection {
  strategy: string;
  target: string;
  estimatedSeconds: number;
}

export interface PlanApproval {
  kind: 'open_pr' | 'merge_pr' | 'promote' | 'rollback' | 'apply_migration';
  description: string;
  required: true;
}

export interface PlanRisk {
  level: 'info' | 'warn' | 'block';
  message: string;
}

export interface PlanEstimate {
  runTimeMinutesMin: number;
  runTimeMinutesMax: number;
  opusSpendUsdMin: number;
  opusSpendUsdMax: number;
}

export interface LaneScanSummary {
  ecosystem: string;
  framework: string | null;
  topology: string;
  dataLayer: string[];
  startCommand: string | null;
  buildCommand: string | null;
  testCommand: string | null;
  healthPath: string | null;
  port: number | null;
  evidence: string[];
  risks: PlanRisk[];
}

export interface LaneSecretsSection {
  expectedKeys: string[];
  sources: string[];
}

export interface DeploymentLane {
  id: string;
  role: LaneRole;
  servicePath: string;
  displayName: string;
  scan: LaneScanSummary;
  platformDecision: PlanPlatformDecision;
  author: PlanAuthorSection;
  rehearsal: PlanRehearsalSection;
  promotion: PlanPromotionSection;
  rollback: PlanRollbackSection;
  approvals: PlanApproval[];
  secrets: LaneSecretsSection;
  statusNarrative: string[];
}

export class PlanStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  save(plan: ConvoyPlan): string {
    const path = join(this.#dir, `${plan.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return path;
  }

  load(id: string): ConvoyPlan | null {
    try {
      const raw = readFileSync(join(this.#dir, `${id}.json`), 'utf8');
      return normalizePlan(JSON.parse(raw) as ConvoyPlan | LegacyConvoyPlan);
    } catch {
      return null;
    }
  }

  listRecent(limit = 10): string[] {
    try {
      return readdirSync(this.#dir)
        .filter((name) => name.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, limit)
        .map((name) => name.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}

interface LegacyConvoyPlan extends Omit<ConvoyPlan, 'version' | 'repo' | 'lanes' | 'dependencies' | 'connectionRequirements'> {
  version?: number;
}

export function normalizePlan(input: ConvoyPlan | LegacyConvoyPlan): ConvoyPlan {
  if ((input as ConvoyPlan).version === 2 && Array.isArray((input as ConvoyPlan).lanes)) {
    return input as ConvoyPlan;
  }
  const legacy = input as LegacyConvoyPlan;
  const defaultLane: DeploymentLane = {
    id: `backend-${legacy.target.workspace ?? 'root'}`,
    role: 'backend',
    servicePath: legacy.target.workspace ?? '.',
    displayName: legacy.target.name,
    scan: {
      ecosystem: legacy.target.ecosystem,
      framework: legacy.target.framework,
      topology: legacy.target.topology,
      dataLayer: [],
      startCommand: legacy.rehearsal.startCommand,
      buildCommand: legacy.rehearsal.buildCommand,
      testCommand: null,
      healthPath: legacy.rehearsal.healthPath,
      port: legacy.rehearsal.expectedPort,
      evidence: legacy.evidence,
      risks: legacy.risks,
    },
    platformDecision: legacy.platform,
    author: legacy.author,
    rehearsal: legacy.rehearsal,
    promotion: legacy.promotion,
    rollback: legacy.rollback,
    approvals: legacy.approvals,
    secrets: { expectedKeys: [], sources: [] },
    statusNarrative: legacy.shipNarrative.map((step) => step.text),
  };
  return {
    version: 2,
    id: legacy.id,
    createdAt: legacy.createdAt,
    repo: {
      repoUrl: legacy.target.repoUrl,
      localPath: legacy.target.localPath,
      branch: legacy.target.branch,
      sha: legacy.target.sha,
      mode: legacy.target.mode,
      name: legacy.target.name,
      readmeTitle: legacy.target.readmeTitle,
      readmeExcerpt: legacy.target.readmeExcerpt,
    },
    lanes: [defaultLane],
    dependencies: [],
    connectionRequirements: [
      {
        laneId: defaultLane.id,
        platform: legacy.platform.chosen,
        servicePath: defaultLane.servicePath,
        requiresAuth: true,
        requiresProjectBinding: legacy.platform.chosen === 'vercel',
        expectedSecrets: [],
      },
    ],
    target: legacy.target,
    summary: legacy.summary,
    deployability: legacy.deployability,
    platform: legacy.platform,
    author: legacy.author,
    rehearsal: legacy.rehearsal,
    promotion: legacy.promotion,
    rollback: legacy.rollback,
    approvals: legacy.approvals,
    risks: legacy.risks,
    estimate: legacy.estimate,
    evidence: legacy.evidence,
    shipNarrative: legacy.shipNarrative,
  };
}

export function primaryLane(plan: ConvoyPlan): DeploymentLane {
  return plan.lanes[0]!;
}

export function aggregateAuthoredFiles(plan: ConvoyPlan): PlanAuthoredFile[] {
  return dedupeFiles(plan.lanes.flatMap((lane) => lane.author.convoyAuthoredFiles));
}

function dedupeFiles(files: PlanAuthoredFile[]): PlanAuthoredFile[] {
  const byPath = new Map<string, PlanAuthoredFile>();
  for (const file of files) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

export function renderPlan(plan: ConvoyPlan): string {
  plan = normalizePlan(plan);
  const L: string[] = [];
  const primary = primaryLane(plan);

  L.push(`Convoy Plan ${plan.id.slice(0, 8)}`);
  L.push(''.padEnd(78, '─'));
  L.push(`Target    ${plan.repo.name}  (${primary.scan.ecosystem}${primary.scan.framework ? `, ${primary.scan.framework}` : ''})`);
  L.push(`Location  ${plan.repo.repoUrl ?? plan.repo.localPath}`);
  if (plan.repo.readmeTitle) L.push(`Described "${plan.repo.readmeTitle}"`);
  if (plan.repo.branch || plan.repo.sha) {
    L.push(`Revision  ${plan.repo.branch ?? 'HEAD'}${plan.repo.sha ? ` @ ${plan.repo.sha.slice(0, 7)}` : ''}`);
  }
  L.push(`Created   ${plan.createdAt}`);
  if (plan.lanes.length > 1) {
    L.push(`Lanes     ${plan.lanes.map((lane) => `${lane.role}:${lane.servicePath}`).join(' · ')}`);
  }
  L.push('');

  if (plan.deployability.verdict === 'not-cloud-deployable') {
    L.push(plan.summary);
    L.push('');
    L.push(`Reason: ${plan.deployability.reason}`);
    if (plan.evidence.length > 0) {
      L.push('');
      L.push('Evidence');
      for (const ev of plan.evidence.slice(0, 6)) L.push(`  · ${ev}`);
    }
    return L.join('\n');
  }

  if (plan.summary) {
    L.push(plan.summary);
    L.push('');
  }

  if (plan.dependencies.length > 0) {
    L.push('Lane order');
    for (const dep of plan.dependencies) {
      L.push(`  ${dep.from} → ${dep.to}  ${dep.reason}`);
    }
    L.push('');
  }

  L.push('What Convoy will author');
  const authoredFiles = aggregateAuthoredFiles(plan);
  if (authoredFiles.length === 0) {
    L.push('  (nothing — the repo already has a complete deployment surface)');
  } else {
    for (const file of authoredFiles) {
      L.push(`  + ${file.path.padEnd(36)} ${String(file.lines).padStart(4)} lines  ${file.summary}`);
    }
  }
  L.push('');

  if (plan.lanes.length > 1) {
    L.push('Lanes');
    for (const lane of plan.lanes) {
      L.push(
        `  - ${lane.displayName} [${lane.role}] ${lane.servicePath} → ${lane.platformDecision.chosen}` +
          `${lane.scan.framework ? ` (${lane.scan.framework})` : ''}`,
      );
    }
    L.push('');
  }

  L.push('How I\'ll ship this');
  for (const s of plan.shipNarrative) {
    const marker = s.kind === 'approval' ? '[approval]' : '          ';
    const head = s.kind === 'approval' ? `${marker} ${s.text}` : s.text;
    L.push(`  ${String(s.step).padStart(2)}. ${head}`);
    if (s.details) {
      for (const d of s.details) L.push(`        · ${d}`);
    }
  }
  L.push('');

  L.push('Why this platform');
  const rankings = primary.platformDecision.candidates
    .map((c) => {
      const marker = c.platform === primary.platformDecision.chosen ? '●' : '·';
      return `${marker} ${c.platform} ${c.score}`;
    })
    .join('   ');
  L.push(`  ${primary.platformDecision.chosen} chosen (${primary.platformDecision.source})`);
  L.push(`  ${rankings}`);
  L.push(`  ${wrap(primary.platformDecision.reason, 72, '  ').trim()}`);

  const advisory = computePlatformAdvisory(plan);
  if (advisory) {
    L.push('');
    L.push(`  Advisory: ${wrap(advisory, 72, '            ').trim()}`);
  }
  L.push('');

  if (plan.risks.length > 0) {
    L.push('Risks');
    for (const risk of plan.risks) {
      const tag = risk.level === 'block' ? 'BLOCK' : risk.level === 'warn' ? 'WARN ' : 'INFO ';
      L.push(`  [${tag}] ${risk.message}`);
    }
    L.push('');
  }

  if (plan.evidence.length > 0) {
    L.push('Evidence');
    for (const ev of plan.evidence.slice(0, 6)) L.push(`  · ${ev}`);
    if (plan.evidence.length > 6) L.push(`  · ... and ${plan.evidence.length - 6} more`);
    L.push('');
  }

  L.push(`Estimated run: ${plan.estimate.runTimeMinutesMin}–${plan.estimate.runTimeMinutesMax} min · Opus spend $${plan.estimate.opusSpendUsdMin.toFixed(2)}–$${plan.estimate.opusSpendUsdMax.toFixed(2)}`);

  return L.join('\n');
}

export function computePlatformAdvisory(plan: ConvoyPlan): string | null {
  plan = normalizePlan(plan);
  if (plan.deployability.verdict === 'not-cloud-deployable') return null;
  const lane = primaryLane(plan);
  const candidates = lane.platformDecision.candidates;
  if (candidates.length === 0) return null;
  const topScored = [...candidates].sort((a, b) => b.score - a.score)[0];
  if (!topScored || topScored.platform === lane.platformDecision.chosen) return null;
  const chosenScore = candidates.find((c) => c.platform === lane.platformDecision.chosen)?.score ?? 0;
  if (topScored.score - chosenScore < 10) return null;
  const flag = `--platform=${topScored.platform}`;
  if (lane.platformDecision.source === 'existing-config') {
    return `${topScored.platform} scored higher (${topScored.score} vs ${chosenScore}) on the heuristic. Convoy is honoring your existing config for ${lane.platformDecision.chosen}. Rerun with ${flag} to switch platforms instead.`;
  }
  if (lane.platformDecision.source === 'override') {
    return `${topScored.platform} scored higher (${topScored.score} vs ${chosenScore}). You chose ${lane.platformDecision.chosen} explicitly — this is just a note, not a correction.`;
  }
  return null;
}

function wrap(text: string, width: number, indent: string): string {
  if (text.length <= width) return text;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.map((l, i) => (i === 0 ? l : `${indent}${l}`)).join('\n');
}
