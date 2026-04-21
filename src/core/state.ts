import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  Approval,
  ApprovalKind,
  ApprovalStatus,
  EventKind,
  Platform,
  Run,
  RunEvent,
  RunStatus,
  StageName,
} from './types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    repo_url       TEXT NOT NULL,
    platform       TEXT,
    status         TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    live_url       TEXT
  );

  CREATE TABLE IF NOT EXISTS run_events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    stage       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);

  CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    kind        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    decided_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);
`;

interface RunRow {
  id: string;
  repo_url: string;
  platform: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  live_url: string | null;
}

interface RunEventRow {
  id: string;
  run_id: string;
  stage: string;
  kind: string;
  payload: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  kind: string;
  summary: string;
  status: string;
  decided_at: string | null;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    repoUrl: row.repo_url,
    platform: row.platform as Platform | null,
    status: row.status as RunStatus,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    liveUrl: row.live_url,
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage as StageName,
    kind: row.kind as EventKind,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: new Date(row.created_at),
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ApprovalKind,
    summary: JSON.parse(row.summary) as unknown,
    status: row.status as ApprovalStatus,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
  };
}

export interface RunUpdates {
  status?: RunStatus;
  platform?: Platform | null;
  liveUrl?: string | null;
  completedAt?: Date | null;
}

export class RunStateStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  createRun(repoUrl: string): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO runs (id, repo_url, status, started_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, repoUrl, 'pending' satisfies RunStatus, now);
    const run = this.getRun(id);
    if (!run) throw new Error(`Run ${id} missing after insert`);
    return run;
  }

  getRun(id: string): Run | null {
    const row = this.#db
      .prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?')
      .get(id);
    return row ? toRun(row) : null;
  }

  listRecentRuns(limit = 10): Run[] {
    const rows = this.#db
      .prepare<[number], RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit);
    return rows.map(toRun);
  }

  updateRun(id: string, updates: RunUpdates): Run {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.platform !== undefined) {
      fields.push('platform = ?');
      values.push(updates.platform);
    }
    if (updates.liveUrl !== undefined) {
      fields.push('live_url = ?');
      values.push(updates.liveUrl);
    }
    if (updates.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completedAt ? updates.completedAt.toISOString() : null);
    }

    if (fields.length === 0) {
      const existing = this.getRun(id);
      if (!existing) throw new Error(`Run ${id} not found`);
      return existing;
    }

    this.#db
      .prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values, id);

    const run = this.getRun(id);
    if (!run) throw new Error(`Run ${id} missing after update`);
    return run;
  }

  appendEvent(
    runId: string,
    stage: StageName,
    kind: EventKind,
    payload: unknown,
  ): RunEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO run_events (id, run_id, stage, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, runId, stage, kind, JSON.stringify(payload), now);

    return {
      id,
      runId,
      stage,
      kind,
      payload,
      createdAt: new Date(now),
    };
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.#db
      .prepare<[string], RunEventRow>(
        'SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC',
      )
      .all(runId);
    return rows.map(toRunEvent);
  }

  requestApproval(runId: string, kind: ApprovalKind, summary: unknown): Approval {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO approvals (id, run_id, kind, summary, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, runId, kind, JSON.stringify(summary), 'pending' satisfies ApprovalStatus);

    const approval = this.getApproval(id);
    if (!approval) throw new Error(`Approval ${id} missing after insert`);
    return approval;
  }

  decideApproval(id: string, status: 'approved' | 'rejected'): Approval {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
      .run(status, now, id, 'pending');

    if (result.changes === 0) {
      throw new Error(`Approval ${id} not found or already decided`);
    }
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`Approval ${id} missing after decide`);
    return approval;
  }

  getApproval(id: string): Approval | null {
    const row = this.#db
      .prepare<[string], ApprovalRow>('SELECT * FROM approvals WHERE id = ?')
      .get(id);
    return row ? toApproval(row) : null;
  }

  listPendingApprovals(runId: string): Approval[] {
    const rows = this.#db
      .prepare<[string, string], ApprovalRow>(
        "SELECT * FROM approvals WHERE run_id = ? AND status = ? ORDER BY id ASC",
      )
      .all(runId, 'pending');
    return rows.map(toApproval);
  }

  close(): void {
    this.#db.close();
  }
}
