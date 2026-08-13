import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { withFileLock } from './file-lock.js';

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
    live_url       TEXT,
    plan_id        TEXT
  );

  CREATE TABLE IF NOT EXISTS run_events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    stage       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    lane_id     TEXT,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);

  CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    kind        TEXT NOT NULL,
    lane_id     TEXT,
    summary     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    decided_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);

  CREATE TABLE IF NOT EXISTS preflight_blockers (
    id          TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL,
    run_id      TEXT,
    blocker_id  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_preflight_blockers_plan_id
    ON preflight_blockers(plan_id);
`;

interface RunRow {
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
}

interface RunEventRow {
  id: string;
  run_id: string;
  stage: string;
  kind: string;
  lane_id: string | null;
  payload: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  kind: string;
  lane_id: string | null;
  summary: string;
  status: string;
  decided_at: string | null;
}

/**
 * Persisted shape of one preflight blocker. The payload field carries the
 * full PreflightBlocker JSON (id, title, fixes[], etc.) so the viewer can
 * render it without the CLI being in the loop. Status starts 'open'; the
 * operator can mark 'acknowledged' to suppress display until the next
 * preflight run mutates state — preflight itself is the source of truth.
 */
interface PreflightBlockerRow {
  id: string;
  plan_id: string;
  run_id: string | null;
  blocker_id: string;
  payload: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export type PreflightBlockerStatus = 'open' | 'acknowledged' | 'resolved';

export interface PersistedBlocker {
  id: string;
  planId: string;
  runId: string | null;
  blockerId: string;
  payload: unknown;
  status: PreflightBlockerStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

function toPersistedBlocker(row: PreflightBlockerRow): PersistedBlocker {
  return {
    id: row.id,
    planId: row.plan_id,
    runId: row.run_id,
    blockerId: row.blocker_id,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status as PreflightBlockerStatus,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    repoUrl: row.repo_url,
    platform: row.platform as Platform | 'multi' | null,
    platformSummary: row.platform as Platform | 'multi' | null,
    status: row.status as RunStatus,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    liveUrl: row.live_url,
    planId: row.plan_id,
    outcomeReason: row.outcome_reason,
    outcomeRestoredVersion: row.outcome_restored_version,
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage as StageName,
    kind: row.kind as EventKind,
    laneId: row.lane_id,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: new Date(row.created_at),
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ApprovalKind,
    laneId: row.lane_id,
    summary: JSON.parse(row.summary) as unknown,
    status: row.status as ApprovalStatus,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
  };
}

export interface RunUpdates {
  status?: RunStatus;
  platform?: Platform | 'multi' | null;
  liveUrl?: string | null;
  completedAt?: Date | null;
  outcomeReason?: string | null;
  outcomeRestoredVersion?: number | null;
}

export class RunStateStore {
  readonly #db: Database.Database;
  readonly #lockPath: string;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#lockPath = `${path}.lock`;
    // DB creation, pragmas, and schema migration are writes too — serialize
    // them so two processes opening a fresh DB can't race the ALTER TABLEs
    // in #migrate. The lock is released before the constructor returns.
    this.#db = withFileLock(this.#lockPath, () => {
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA);
      this.#migrate(db);
      return db;
    });
  }

  #migrate(db: Database.Database): void {
    const cols = db
      .prepare<[], { name: string }>('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name);
    if (!cols.includes('plan_id')) {
      db.exec('ALTER TABLE runs ADD COLUMN plan_id TEXT');
    }
    if (!cols.includes('outcome_reason')) {
      db.exec('ALTER TABLE runs ADD COLUMN outcome_reason TEXT');
    }
    if (!cols.includes('outcome_restored_version')) {
      db.exec('ALTER TABLE runs ADD COLUMN outcome_restored_version INTEGER');
    }
    const eventCols = db
      .prepare<[], { name: string }>('PRAGMA table_info(run_events)')
      .all()
      .map((c) => c.name);
    if (!eventCols.includes('lane_id')) {
      db.exec('ALTER TABLE run_events ADD COLUMN lane_id TEXT');
    }
    const approvalCols = db
      .prepare<[], { name: string }>('PRAGMA table_info(approvals)')
      .all()
      .map((c) => c.name);
    if (!approvalCols.includes('lane_id')) {
      db.exec('ALTER TABLE approvals ADD COLUMN lane_id TEXT');
    }
  }

  createRun(repoUrl: string, planId?: string | null): Run {
    return withFileLock(this.#lockPath, () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.#db
        .prepare(
          'INSERT INTO runs (id, repo_url, status, started_at, plan_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, repoUrl, 'pending' satisfies RunStatus, now, planId ?? null);
      const run = this.getRun(id);
      if (!run) throw new Error(`Run ${id} missing after insert`);
      return run;
    });
  }

  listRunsForPlan(planId: string): Run[] {
    const rows = this.#db
      .prepare<[string], RunRow>('SELECT * FROM runs WHERE plan_id = ? ORDER BY started_at DESC')
      .all(planId);
    return rows.map(toRun);
  }

  getRun(id: string): Run | null {
    const row = this.#db
      .prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?')
      .get(id);
    if (row) return toRun(row);
    // Prefix match — accept first 7+ chars of the uuid.
    if (id.length >= 7) {
      const prefix = this.#db
        .prepare<[string], RunRow>('SELECT * FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1')
        .get(`${id}%`);
      if (prefix) return toRun(prefix);
    }
    return null;
  }

  listRecentRuns(limit = 10): Run[] {
    const rows = this.#db
      .prepare<[number], RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit);
    return rows.map(toRun);
  }

  updateRun(id: string, updates: RunUpdates): Run {
    return withFileLock(this.#lockPath, () => {
      const fields: string[] = [];
      const values: (string | number | null)[] = [];

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
      if (updates.outcomeReason !== undefined) {
        fields.push('outcome_reason = ?');
        values.push(updates.outcomeReason);
      }
      if (updates.outcomeRestoredVersion !== undefined) {
        fields.push('outcome_restored_version = ?');
        values.push(updates.outcomeRestoredVersion);
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
    });
  }

  appendEvent(
    runId: string,
    stage: StageName,
    kind: EventKind,
    payload: unknown,
    laneId?: string | null,
  ): RunEvent {
    return withFileLock(this.#lockPath, () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.#db
        .prepare(
          'INSERT INTO run_events (id, run_id, stage, kind, lane_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, runId, stage, kind, laneId ?? null, JSON.stringify(payload), now);

      return {
        id,
        runId,
        stage,
        kind,
        ...(laneId !== undefined ? { laneId } : {}),
        payload,
        createdAt: new Date(now),
      };
    });
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.#db
      .prepare<[string], RunEventRow>(
        'SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC',
      )
      .all(runId);
    return rows.map(toRunEvent);
  }

  requestApproval(runId: string, kind: ApprovalKind, summary: unknown, laneId?: string | null): Approval {
    return withFileLock(this.#lockPath, () => {
      const id = randomUUID();
      this.#db
        .prepare(
          'INSERT INTO approvals (id, run_id, kind, lane_id, summary, status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, runId, kind, laneId ?? null, JSON.stringify(summary), 'pending' satisfies ApprovalStatus);

      const approval = this.getApproval(id);
      if (!approval) throw new Error(`Approval ${id} missing after insert`);
      return approval;
    });
  }

  decideApproval(id: string, status: 'approved' | 'rejected'): Approval {
    return withFileLock(this.#lockPath, () => {
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
    });
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

  /**
   * Replace the open blocker set for a plan. Each preflight invocation is
   * authoritative — old open rows for this plan get marked 'resolved'
   * (preflight believes they're cleared) and the current blockers get
   * inserted as fresh 'open' rows. Acknowledged rows are left alone so
   * we don't lose audit trail of operator actions, but they no longer
   * reflect current state once the new rows land.
   */
  recordPreflightBlockers(
    planId: string,
    blockers: { blockerId: string; payload: unknown }[],
    runId?: string | null,
  ): PersistedBlocker[] {
    return withFileLock(this.#lockPath, () => {
      const now = new Date().toISOString();
      const tx = this.#db.transaction(() => {
        this.#db
          .prepare(
            `UPDATE preflight_blockers
             SET status = 'resolved', resolved_at = ?
             WHERE plan_id = ? AND status = 'open'`,
          )
          .run(now, planId);

        const insert = this.#db.prepare(
          `INSERT INTO preflight_blockers
          (id, plan_id, run_id, blocker_id, payload, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?)`,
        );
        for (const b of blockers) {
          insert.run(randomUUID(), planId, runId ?? null, b.blockerId, JSON.stringify(b.payload), now);
        }
      });
      tx();
      return this.listOpenBlockersByPlan(planId);
    });
  }

  listOpenBlockersByPlan(planId: string): PersistedBlocker[] {
    const rows = this.#db
      .prepare<[string], PreflightBlockerRow>(
        `SELECT * FROM preflight_blockers
         WHERE plan_id = ? AND status = 'open'
         ORDER BY created_at DESC`,
      )
      .all(planId);
    return rows.map(toPersistedBlocker);
  }

  acknowledgeBlocker(id: string): PersistedBlocker | null {
    return withFileLock(this.#lockPath, () => {
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE preflight_blockers
           SET status = 'acknowledged', resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(now, id);
      const row = this.#db
        .prepare<[string], PreflightBlockerRow>('SELECT * FROM preflight_blockers WHERE id = ?')
        .get(id);
      return row ? toPersistedBlocker(row) : null;
    });
  }

  close(): void {
    this.#db.close();
  }
}
