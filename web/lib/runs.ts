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
  status: string;
  startedAt: string;
  completedAt: string | null;
  liveUrl: string | null;
}

export interface EventRow {
  id: string;
  runId: string;
  stage: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ApprovalRow {
  id: string;
  runId: string;
  kind: string;
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

export function listRuns(limit = 30): RunRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[number], {
        id: string;
        repo_url: string;
        platform: string | null;
        status: string;
        started_at: string;
        completed_at: string | null;
        live_url: string | null;
      }>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit);
    return rows.map((r) => ({
      id: r.id,
      repoUrl: r.repo_url,
      platform: r.platform,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      liveUrl: r.live_url,
    }));
  } finally {
    db.close();
  }
}

export function getRun(id: string): RunRow | null {
  const db = openDb();
  if (!db) return null;
  try {
    const row = db
      .prepare<[string], {
        id: string;
        repo_url: string;
        platform: string | null;
        status: string;
        started_at: string;
        completed_at: string | null;
        live_url: string | null;
      }>('SELECT * FROM runs WHERE id = ?')
      .get(id);
    if (!row) {
      // Prefix match fallback
      const all = db
        .prepare<[], { id: string }>('SELECT id FROM runs ORDER BY started_at DESC LIMIT 100')
        .all();
      const match = all.find((r) => r.id.startsWith(id));
      if (!match) return null;
      return getRunInternal(db, match.id);
    }
    return {
      id: row.id,
      repoUrl: row.repo_url,
      platform: row.platform,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      liveUrl: row.live_url,
    };
  } finally {
    db.close();
  }
}

function getRunInternal(db: Database.Database, id: string): RunRow {
  const row = db
    .prepare<[string], {
      id: string;
      repo_url: string;
      platform: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      live_url: string | null;
    }>('SELECT * FROM runs WHERE id = ?')
    .get(id)!;
  return {
    id: row.id,
    repoUrl: row.repo_url,
    platform: row.platform,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    liveUrl: row.live_url,
  };
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
        payload: string;
        created_at: string;
      }>('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stage: r.stage,
      kind: r.kind,
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
        summary: string;
        status: string;
        decided_at: string | null;
      }>('SELECT * FROM approvals WHERE run_id = ? ORDER BY id ASC')
      .all(runId);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      summary: safeParse(r.summary),
      status: r.status,
      decidedAt: r.decided_at,
    }));
  } finally {
    db.close();
  }
}

export function decideApproval(id: string, status: 'approved' | 'rejected'): ApprovalRow | null {
  const db = openDb();
  if (!db) return null;
  try {
    const now = new Date().toISOString();
    const result = db
      .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
      .run(status, now, id, 'pending');
    if (result.changes === 0) return null;
    const row = db
      .prepare<[string], {
        id: string;
        run_id: string;
        kind: string;
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
