import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PlanAuthoredFile {
  path: string;
  lines: number;
  summary: string;
  contentPreview?: string;
}

export interface PlanPlatformCandidate {
  platform: string;
  score: number;
  reason: string;
  adjustments?: Array<{ delta: number; label: string }>;
}

export interface PlanShipStep {
  step: number;
  kind: 'action' | 'approval';
  text: string;
  details?: string[];
}

export interface PlanSummary {
  version?: number;
  id: string;
  createdAt: string;
  repo?: {
    name: string;
    repoUrl: string | null;
    localPath: string;
    readmeTitle: string | null;
  };
  lanes?: Array<{
    id: string;
    role: string;
    servicePath: string;
    displayName: string;
    scan: {
      ecosystem: string;
      framework: string | null;
      topology: string;
      dataLayer: string[];
      risks?: Array<{ level: string; message: string }>;
      healthPath?: string | null;
      port?: number | null;
    };
    platformDecision: {
      chosen: string;
      source: string;
      reason: string;
      candidates: PlanPlatformCandidate[];
      advisory?: string;
    };
    author: {
      convoyAuthoredFiles: PlanAuthoredFile[];
    };
    rehearsal: {
      targetDescriptor: string;
      buildCommand: string | null;
      startCommand: string | null;
      expectedPort: number | null;
      validations: string[];
      healthPath?: string | null;
      metricsPath?: string | null;
    };
    rollback: {
      strategy: string;
      target: string;
      estimatedSeconds: number;
    };
    secrets: {
      expectedKeys: string[];
      sources: string[];
      keys?: Array<{ key: string; kind: 'secret' | 'config'; defaultValue?: string }>;
    };
  }>;
  dependencies?: Array<{ from: string; to: string; reason: string }>;
  target: {
    name: string;
    ecosystem: string;
    framework: string | null;
    repoUrl: string | null;
    localPath: string;
    readmeTitle: string | null;
  };
  platform: {
    chosen: string;
    source: string;
    reason: string;
    candidates: PlanPlatformCandidate[];
  };
  deployability: {
    verdict: string;
    reason: string;
  };
  summary: string;
  author: {
    convoyAuthoredFiles: PlanAuthoredFile[];
  };
  shipNarrative: PlanShipStep[];
  rehearsal: {
    targetDescriptor: string;
    buildCommand: string | null;
    startCommand: string | null;
    expectedPort: number | null;
    validations: string[];
  };
  promotion: {
    canary: { trafficPercent: number; bakeWindowSeconds: number };
    steps: { trafficPercent: number; bakeWindowSeconds: number }[];
    haltOn: string[];
  };
  rollback: {
    strategy: string;
    target: string;
    estimatedSeconds: number;
  };
  approvals: { kind: string; description: string }[];
  risks: { level: string; message: string }[];
  evidence: string[];
  estimate: {
    runTimeMinutesMin: number;
    runTimeMinutesMax: number;
    opusSpendUsdMin: number;
    opusSpendUsdMax: number;
  };
}

export function primaryLane(plan: PlanSummary) {
  return plan.lanes?.[0] ?? null;
}

const PLANS_DIR = resolve(
  process.env['CONVOY_PLANS_DIR'] ?? join(process.cwd(), '..', '.convoy', 'plans'),
);

function plansDirExists(): boolean {
  try {
    return existsSync(PLANS_DIR) && statSync(PLANS_DIR).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plans saved by the CLI use an integrity envelope:
 *
 *   { format: 'convoy-plan-v1', savedAt: '…', sha256: '…', plan: {...} }
 *
 * Older plans (pre-2da4bbb) were saved as the raw PlanSummary at the top
 * level. The web reader has to handle both — unwrap when an envelope is
 * present, return the body otherwise. Without this the plan listing
 * blew up with `Cannot read properties of undefined (reading 'slice')`
 * because `plan.id` was undefined for every newly-saved plan.
 */
function unwrapEnvelope(parsed: unknown): PlanSummary | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj['format'] === 'convoy-plan-v1' && obj['plan'] && typeof obj['plan'] === 'object') {
    return obj['plan'] as PlanSummary;
  }
  // Legacy raw shape — `id` lives at the top level.
  if (typeof obj['id'] === 'string') return obj as unknown as PlanSummary;
  return null;
}

export function listPlans(): PlanSummary[] {
  if (!plansDirExists()) return [];
  let files: string[];
  try {
    files = readdirSync(PLANS_DIR);
  } catch {
    return [];
  }
  const out: PlanSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(PLANS_DIR, file), 'utf8');
      const plan = unwrapEnvelope(JSON.parse(raw));
      if (plan && typeof plan.id === 'string') out.push(plan);
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export function getPlan(id: string): PlanSummary | null {
  if (!plansDirExists()) return null;
  const exactPath = join(PLANS_DIR, `${id}.json`);
  if (existsSync(exactPath)) {
    try {
      const plan = unwrapEnvelope(JSON.parse(readFileSync(exactPath, 'utf8')));
      if (plan && typeof plan.id === 'string') return plan;
    } catch {
      return null;
    }
  }
  for (const plan of listPlans()) {
    if (plan.id === id || plan.id.startsWith(id)) return plan;
  }
  return null;
}

export function plansLocation(): string {
  return PLANS_DIR;
}
