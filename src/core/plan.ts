import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { Platform } from './types.js';

export type PlanDeployability =
  | 'deployable-web-service'
  | 'deployable-static-site'
  | 'not-cloud-deployable'
  | 'ambiguous';

export interface ConvoyPlan {
  id: string;
  createdAt: string;
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
}

export interface PlanTarget {
  repoUrl: string | null;
  localPath: string;
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

export interface PlanAuthorSection {
  convoyAuthoredFiles: PlanAuthoredFile[];
  readOnlyPaths: PlanReadOnlyEntry[];
  note: string;
}

export interface PlanAuthoredFile {
  path: string;
  lines: number;
  summary: string;
  contentPreview: string;
}

export interface PlanReadOnlyEntry {
  path: string;
  kind: 'source-dir' | 'test-dir' | 'config' | 'manifest' | 'other';
  note: string;
}

export interface PlanRehearsalSection {
  enabled: boolean;
  targetDescriptor: string;
  buildCommand: string | null;
  startCommand: string | null;
  expectedPort: number | null;
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
  kind: 'merge_pr' | 'promote' | 'rollback' | 'apply_migration';
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
      return JSON.parse(raw) as ConvoyPlan;
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

export function renderPlan(plan: ConvoyPlan): string {
  const L: string[] = [];

  L.push(`Convoy Plan ${plan.id.slice(0, 8)}`);
  L.push(''.padEnd(78, '─'));
  L.push(`Target      ${plan.target.name}  (${plan.target.ecosystem}${plan.target.framework ? `, ${plan.target.framework}` : ''})`);
  L.push(`Location    ${plan.target.repoUrl ?? plan.target.localPath}`);
  if (plan.target.readmeTitle) L.push(`Described   "${plan.target.readmeTitle}"`);
  if (plan.target.branch || plan.target.sha) {
    L.push(`Revision    ${plan.target.branch ?? 'HEAD'}${plan.target.sha ? ` @ ${plan.target.sha.slice(0, 7)}` : ''}`);
  }
  L.push(`Mode        ${plan.target.mode}`);
  L.push(`Created     ${plan.createdAt}`);
  L.push('');

  if (plan.summary) {
    L.push('Summary');
    L.push(`  ${plan.summary}`);
    L.push('');
  }

  L.push('Deployability');
  L.push(`  Verdict     ${plan.deployability.verdict}`);
  L.push(`  Why         ${wrap(plan.deployability.reason, 72, '              ').trim()}`);
  L.push('');

  if (plan.deployability.verdict !== 'not-cloud-deployable') {
    L.push('Platform decision');
    const rankings = plan.platform.candidates.map((c) => `${c.platform} ${c.score}`).join(' · ');
    L.push(`  Candidates  ${rankings}`);
    L.push(`  Chosen      ${plan.platform.chosen}  (${plan.platform.source})`);
    L.push(`  Reason      ${wrap(plan.platform.reason, 72, '              ').trim()}`);
    L.push('');

    L.push('Files to author (Convoy-authored)');
    if (plan.author.convoyAuthoredFiles.length === 0) {
      L.push('  (none — repo already has a complete deployment surface)');
    } else {
      for (const file of plan.author.convoyAuthoredFiles) {
        L.push(`  + ${file.path.padEnd(40)} ${String(file.lines).padStart(4)} lines  ${file.summary}`);
      }
    }
    L.push('');

    L.push('Files Convoy will NOT touch (developer-authored)');
    if (plan.author.readOnlyPaths.length === 0) {
      L.push('  (no developer directories detected at the target root)');
    } else {
      for (const entry of plan.author.readOnlyPaths) {
        L.push(`  ~ ${entry.path.padEnd(40)} ${entry.note}`);
      }
    }
    if (plan.author.note) L.push(`  ${plan.author.note}`);
    L.push('');

    L.push('Rehearsal');
    L.push(`  Target        ${plan.rehearsal.targetDescriptor}`);
    if (plan.rehearsal.buildCommand) L.push(`  Build         ${plan.rehearsal.buildCommand}`);
    if (plan.rehearsal.startCommand) L.push(`  Start         ${plan.rehearsal.startCommand}`);
    if (plan.rehearsal.expectedPort !== null) L.push(`  Port          ${plan.rehearsal.expectedPort}`);
    L.push(`  Validations   ${plan.rehearsal.validations.join(' · ')}`);
    L.push(`  Lifecycle     ~${plan.rehearsal.estimatedDurationSeconds}s · ${plan.rehearsal.estimatedCost}`);
    L.push('');

    L.push('Promotion');
    L.push(`  Canary        ${plan.promotion.canary.trafficPercent}% · ${plan.promotion.canary.bakeWindowSeconds}s bake`);
    const steps = plan.promotion.steps.map((s) => `${s.trafficPercent}%`).join(' → ');
    L.push(`  Steps         ${steps}`);
    L.push(`  Halt on       ${plan.promotion.haltOn.join(' · ')}`);
    L.push('');

    L.push('Rollback (pre-staged)');
    L.push(`  Strategy      ${plan.rollback.strategy}`);
    L.push(`  Target        ${plan.rollback.target}`);
    L.push(`  ETA           ~${plan.rollback.estimatedSeconds}s if triggered`);
    L.push('');

    L.push('Approvals required');
    for (const approval of plan.approvals) {
      L.push(`  [ ] ${approval.kind.padEnd(18)} ${approval.description}`);
    }
    L.push('');
  }

  if (plan.risks.length > 0) {
    L.push('Risk callouts');
    for (const risk of plan.risks) {
      const tag = risk.level === 'block' ? 'BLOCK' : risk.level === 'warn' ? 'WARN ' : 'INFO ';
      L.push(`  [${tag}] ${risk.message}`);
    }
    L.push('');
  }

  if (plan.evidence.length > 0) {
    L.push('Evidence');
    for (const ev of plan.evidence.slice(0, 8)) L.push(`  · ${ev}`);
    if (plan.evidence.length > 8) L.push(`  · ... and ${plan.evidence.length - 8} more`);
    L.push('');
  }

  L.push('Estimates');
  L.push(`  Run time      ${plan.estimate.runTimeMinutesMin}–${plan.estimate.runTimeMinutesMax} min`);
  L.push(`  Opus spend    $${plan.estimate.opusSpendUsdMin.toFixed(2)}–$${plan.estimate.opusSpendUsdMax.toFixed(2)}`);

  return L.join('\n');
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
