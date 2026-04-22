import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { Platform } from './types.js';

/**
 * A ConvoyPlan is an inspectable, Terraform-style artifact describing
 * exactly what `convoy apply` would do. It has no side effects beyond
 * reading the target repo.
 */
export interface ConvoyPlan {
  id: string;
  createdAt: string;
  target: PlanTarget;
  platform: PlanPlatformDecision;
  author: PlanAuthorSection;
  rehearsal: PlanRehearsalSection;
  promotion: PlanPromotionSection;
  rollback: PlanRollbackSection;
  approvals: PlanApproval[];
  estimate: PlanEstimate;
}

export interface PlanTarget {
  repoUrl: string | null;
  localPath: string;
  branch: string | null;
  sha: string | null;
  mode: 'first-deploy' | 'recurring';
}

export interface PlanPlatformDecision {
  chosen: Platform;
  reason: string;
  source: 'override' | 'existing-config' | 'scored';
  candidates: PlanPlatformCandidate[];
}

export interface PlanPlatformCandidate {
  platform: Platform;
  score: number;
  reason: string;
}

export interface PlanAuthorSection {
  convoyAuthoredFiles: PlanAuthoredFile[];
  readOnlyFiles: PlanReadOnlyFile[];
}

export interface PlanAuthoredFile {
  path: string;
  lines: number;
  summary: string;
  contentPreview: string;
}

export interface PlanReadOnlyFile {
  pattern: string;
  note: string;
}

export interface PlanRehearsalSection {
  enabled: boolean;
  targetDescriptor: string;
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

export interface PlanEstimate {
  runTimeMinutesMin: number;
  runTimeMinutesMax: number;
  opusSpendUsdMin: number;
  opusSpendUsdMax: number;
}

/**
 * Persists and reads plans as JSON files under .convoy/plans/<id>.json.
 */
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

/**
 * Render a plan to a human-readable string (Terraform-plan style).
 */
export function renderPlan(plan: ConvoyPlan): string {
  const lines: string[] = [];

  lines.push(`Convoy Plan ${plan.id.slice(0, 8)}`);
  lines.push(''.padEnd(78, '─'));
  lines.push(`Target      ${plan.target.repoUrl ?? plan.target.localPath}`);
  if (plan.target.branch || plan.target.sha) {
    lines.push(
      `            ${plan.target.branch ?? 'HEAD'}${plan.target.sha ? ` @ ${plan.target.sha.slice(0, 7)}` : ''}`,
    );
  }
  lines.push(`Mode        ${plan.target.mode}`);
  lines.push(`Created     ${plan.createdAt}`);
  lines.push('');

  lines.push('Platform decision');
  const rankings = plan.platform.candidates
    .map((c) => `${c.platform} ${c.score}`)
    .join(' · ');
  lines.push(`  Candidates  ${rankings}`);
  lines.push(`  Chosen      ${plan.platform.chosen}  (${plan.platform.source})`);
  lines.push(`  Reason      ${plan.platform.reason}`);
  lines.push('');

  lines.push('Files to author (Convoy-authored)');
  if (plan.author.convoyAuthoredFiles.length === 0) {
    lines.push('  (none — repo already has a complete deployment surface)');
  } else {
    for (const file of plan.author.convoyAuthoredFiles) {
      lines.push(
        `  + ${file.path.padEnd(40)} ${String(file.lines).padStart(4)} lines  ${file.summary}`,
      );
    }
  }
  lines.push('');

  lines.push('Files Convoy will NOT touch (developer-authored)');
  for (const entry of plan.author.readOnlyFiles) {
    lines.push(`  ~ ${entry.pattern.padEnd(40)} ${entry.note}`);
  }
  lines.push('');

  lines.push('Rehearsal');
  lines.push(`  Target        ${plan.rehearsal.targetDescriptor}`);
  lines.push(`  Validations   ${plan.rehearsal.validations.join(' · ')}`);
  lines.push(
    `  Lifecycle     ~${plan.rehearsal.estimatedDurationSeconds}s · ${plan.rehearsal.estimatedCost}`,
  );
  lines.push('');

  lines.push('Promotion');
  lines.push(
    `  Canary        ${plan.promotion.canary.trafficPercent}% · ${plan.promotion.canary.bakeWindowSeconds}s bake`,
  );
  const steps = plan.promotion.steps.map((s) => `${s.trafficPercent}%`).join(' → ');
  lines.push(`  Steps         ${steps}`);
  lines.push(`  Halt on       ${plan.promotion.haltOn.join(' · ')}`);
  lines.push('');

  lines.push('Rollback (pre-staged)');
  lines.push(`  Strategy      ${plan.rollback.strategy}`);
  lines.push(`  Target        ${plan.rollback.target}`);
  lines.push(`  ETA           ~${plan.rollback.estimatedSeconds}s if triggered`);
  lines.push('');

  lines.push('Approvals required');
  for (const approval of plan.approvals) {
    lines.push(`  [ ] ${approval.kind.padEnd(18)} ${approval.description}`);
  }
  lines.push('');

  lines.push('Estimates');
  lines.push(
    `  Run time      ${plan.estimate.runTimeMinutesMin}–${plan.estimate.runTimeMinutesMax} min`,
  );
  lines.push(
    `  Opus spend    $${plan.estimate.opusSpendUsdMin.toFixed(2)}–$${plan.estimate.opusSpendUsdMax.toFixed(2)}`,
  );

  return lines.join('\n');
}
