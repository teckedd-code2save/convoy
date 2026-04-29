import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

const STATE_PATH = resolve(
  process.env['CONVOY_STATE_PATH'] ?? join(process.cwd(), '..', '.convoy', 'state.db'),
);

export interface RunRow {
  id: string;
  repoUrl: string;
  platform: string | null;
  platformSummary?: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  liveUrl: string | null;
  planId: string | null;
  outcomeReason: string | null;
  outcomeRestoredVersion: number | null;
}

export interface EventRow {
  id: string;
  runId: string;
  stage: string;
  kind: string;
  laneId?: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  kind: string;
  laneId?: string | null;
  summary: unknown;
  status: string;
  decidedAt: string | null;
}

function openDb(): Database.Database | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const db = new Database(STATE_PATH, { readonly: false, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    return null;
  }
}

type RawRunRow = {
  id: string;
  repo_url: string;
  platform: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  live_url: string | null;
  plan_id: string | null;
  outcome_reason: string | null;
  outcome_restored_version: number | null;
};

function toRunRow(r: RawRunRow): RunRow {
  return {
    id: r.id,
    repoUrl: r.repo_url,
    platform: r.platform,
    platformSummary: r.platform,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    liveUrl: r.live_url,
    planId: r.plan_id,
    outcomeReason: r.outcome_reason,
    outcomeRestoredVersion: r.outcome_restored_version,
  };
}

export function listRuns(limit = 30): RunRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[number], RawRunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit);
    return rows.map(toRunRow);
  } finally {
    db.close();
  }
}

export function listRunsForPlan(planId: string): RunRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[string], RawRunRow>('SELECT * FROM runs WHERE plan_id = ? ORDER BY started_at DESC')
      .all(planId);
    return rows.map(toRunRow);
  } finally {
    db.close();
  }
}

export function getRun(id: string): RunRow | null {
  const db = openDb();
  if (!db) return null;
  try {
    const row = db
      .prepare<[string], RawRunRow>('SELECT * FROM runs WHERE id = ?')
      .get(id);
    if (row) return toRunRow(row);
    // Prefix match fallback
    const all = db
      .prepare<[], RawRunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100')
      .all();
    const match = all.find((r) => r.id.startsWith(id));
    return match ? toRunRow(match) : null;
  } finally {
    db.close();
  }
}

export function listEvents(runId: string): EventRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[string], {
        id: string;
        run_id: string;
        stage: string;
        kind: string;
        lane_id: string | null;
        payload: string;
        created_at: string;
      }>('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stage: r.stage,
      kind: r.kind,
      laneId: r.lane_id,
      payload: safeParse(r.payload),
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function listApprovals(runId: string): ApprovalRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[string], {
        id: string;
        run_id: string;
        kind: string;
        lane_id: string | null;
        summary: string;
        status: string;
        decided_at: string | null;
      }>('SELECT * FROM approvals WHERE run_id = ? ORDER BY id ASC')
      .all(runId);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      laneId: r.lane_id,
      summary: safeParse(r.summary),
      status: r.status,
      decidedAt: r.decided_at,
    }));
  } finally {
    db.close();
  }
}

// Bind every decision to a claimed runId so a caller who only has the approval
// UUID cannot mutate an approval on an unrelated run. Previously the runId
// param on the server action was decorative — forged requests could claim to
// act on one run while mutating another. Flagged by pre-demo adversarial review.
export function decideApproval(
  runId: string,
  id: string,
  status: 'approved' | 'rejected',
): ApprovalRow | null {
  const db = openDb();
  if (!db) return null;
  try {
    const now = new Date().toISOString();
    const result = db
      .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND run_id = ? AND status = ?')
      .run(status, now, id, runId, 'pending');
    if (result.changes === 0) return null;
    const row = db
      .prepare<[string], {
        id: string;
        run_id: string;
        kind: string;
        lane_id: string | null;
        summary: string;
        status: string;
        decided_at: string | null;
      }>('SELECT * FROM approvals WHERE id = ?')
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      laneId: row.lane_id,
      summary: safeParse(row.summary),
      status: row.status,
      decidedAt: row.decided_at,
    };
  } finally {
    db.close();
  }
}

export function runsLocation(): string {
  return STATE_PATH;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
