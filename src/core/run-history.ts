import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunHistoryEntry {
  ts: string;
  runId: string;
  planId: string | null;
  service: string;
  platform: string | null;
  outcome: 'succeeded' | 'rolled_back' | 'failed' | 'abandoned';
  durationMs: number;
  approvals: Array<{ kind: string; decidedMs: number; decision: string }>;
  rehearsalHealthy: boolean | null;
  canaryHealthy: boolean | null;
  secretsMissedAtGate: string[];
  breachReason: string | null;
  resumes: number;
}

export interface TrustLevel {
  level: 0 | 1 | 2 | 3 | 4;
  totalSuccessful: number;
  rollbackRate: number;
  lastBreach: string | null;
}

export function runHistoryPath(repoPath: string): string {
  return resolve(repoPath, '.convoy', 'run-history.jsonl');
}

export function appendRunHistory(repoPath: string, entry: RunHistoryEntry): void {
  const p = runHistoryPath(repoPath);
  mkdirSync(resolve(repoPath, '.convoy'), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
}

export function readRunHistory(repoPath: string): RunHistoryEntry[] {
  const p = runHistoryPath(repoPath);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as RunHistoryEntry);
  } catch {
    return [];
  }
}

export function computeTrustLevel(history: RunHistoryEntry[], service: string): TrustLevel {
  const serviceHistory = history.filter(e => e.service === service);
  const total = serviceHistory.length;
  if (total === 0) return { level: 0, totalSuccessful: 0, rollbackRate: 0, lastBreach: null };

  const successes = serviceHistory.filter(e => e.outcome === 'succeeded').length;
  const rollbacks = serviceHistory.filter(e => e.outcome === 'rolled_back').length;
  const rollbackRate = total > 0 ? rollbacks / total : 0;
  const lastBreach = serviceHistory
    .filter(e => e.outcome === 'rolled_back' || e.breachReason)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]?.ts ?? null;

  // Trust escalation
  let level: 0 | 1 | 2 | 3 | 4 = 0;
  if (successes >= 5 && rollbackRate < 0.1) level = 1;
  if (successes >= 15 && rollbackRate < 0.1) level = 2;
  if (successes >= 30 && rollbackRate < 0.05 && !lastBreach) level = 3;
  // Level 4 is opt-in only (never auto-granted)

  return { level, totalSuccessful: successes, rollbackRate, lastBreach };
}

export function shouldAutoApprove(
  trust: TrustLevel,
  kind: string,
  rehearsalClean: boolean,
  hasComplianceRequirement: boolean,
): boolean {
  // Compliance always forces manual approval regardless of trust
  if (hasComplianceRequirement) return false;

  switch (kind) {
    case 'open_pr':
      // Level 1+: auto-approve open_pr when rehearsal is clean
      return trust.level >= 1 && rehearsalClean;
    case 'promote':
      // Level 2+: auto-approve canary promote gate
      return trust.level >= 2;
    default:
      return false;
  }
}
