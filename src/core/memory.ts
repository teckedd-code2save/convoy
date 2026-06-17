import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_facts (
    id          TEXT PRIMARY KEY,
    target_path TEXT,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0,
    source_run  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_facts_target ON memory_facts(target_path);

  CREATE TABLE IF NOT EXISTS memory_outcomes (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT NOT NULL,
    target_path          TEXT,
    platform             TEXT,
    status               TEXT NOT NULL,
    p99_ms               REAL,
    error_rate           REAL,
    stage_reached        TEXT,
    medic_classification TEXT,
    lesson               TEXT,
    created_at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_outcomes_target ON memory_outcomes(target_path);

  CREATE TABLE IF NOT EXISTS memory_skills (
    id           TEXT PRIMARY KEY,
    target_path  TEXT,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]',
    use_count    INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_skills_target ON memory_skills(target_path);

  CREATE TABLE IF NOT EXISTS decision_traces (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    stage          TEXT NOT NULL,
    decision_type  TEXT NOT NULL,
    input_hash     TEXT,
    decision       TEXT NOT NULL,
    outcome        TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decision_traces_run ON decision_traces(run_id);
`;

export interface MemoryFact {
  id: string;
  targetPath: string | null;
  key: string;
  value: string;
  confidence: number;
  sourceRun: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryOutcome {
  id: string;
  runId: string;
  targetPath: string | null;
  platform: string | null;
  status: string;
  p99Ms: number | null;
  errorRate: number | null;
  stageReached: string | null;
  medicClassification: string | null;
  lesson: string | null;
  createdAt: Date;
}

export interface MemorySkill {
  id: string;
  targetPath: string | null;
  title: string;
  body: string;
  tags: string[];
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface DecisionTrace {
  id: string;
  runId: string;
  stage: string;
  decisionType: string;
  inputHash: string | null;
  decision: string;
  outcome: string | null;
  createdAt: Date;
}

interface MemoryFactRow {
  id: string;
  target_path: string | null;
  key: string;
  value: string;
  confidence: number;
  source_run: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryOutcomeRow {
  id: string;
  run_id: string;
  target_path: string | null;
  platform: string | null;
  status: string;
  p99_ms: number | null;
  error_rate: number | null;
  stage_reached: string | null;
  medic_classification: string | null;
  lesson: string | null;
  created_at: string;
}

interface MemorySkillRow {
  id: string;
  target_path: string | null;
  title: string;
  body: string;
  tags: string;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
}

interface DecisionTraceRow {
  id: string;
  run_id: string;
  stage: string;
  decision_type: string;
  input_hash: string | null;
  decision: string;
  outcome: string | null;
  created_at: string;
}

/**
 * Three-tier agent memory store using the same SQLite database as RunStateStore.
 *
 * Tiers:
 *  - Semantic (memory_facts): persistent key/value facts about a repo or team,
 *    written by the learn pass, read by the enricher.
 *  - Episodic (memory_outcomes): one compressed record per run — what happened,
 *    what the signals were, what lesson was extracted.
 *  - Procedural (memory_skills): reusable step-by-step patterns discovered
 *    across runs, loaded into enricher context.
 *
 * Decision traces link Opus decisions to outcomes, enabling the picker to
 * self-correct when the platform it chose is routinely overridden.
 */
export class ConvoyMemory {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(MEMORY_SCHEMA);
  }

  // ── Semantic memory ──────────────────────────────────────────────────────

  setFact(
    key: string,
    value: string,
    targetPath?: string | null,
    confidence = 1.0,
    sourceRun?: string | null,
  ): MemoryFact {
    const now = new Date().toISOString();
    const tp = targetPath ?? null;
    const existing = this.#db
      .prepare<[string, string | null, string | null], MemoryFactRow>(
        `SELECT * FROM memory_facts
         WHERE key = ?
           AND (target_path = ? OR (target_path IS NULL AND ? IS NULL))
         LIMIT 1`,
      )
      .get(key, tp, tp);

    if (existing) {
      this.#db
        .prepare(
          'UPDATE memory_facts SET value = ?, confidence = ?, source_run = ?, updated_at = ? WHERE id = ?',
        )
        .run(value, confidence, sourceRun ?? null, now, existing.id);
      return this.#factById(existing.id)!;
    }

    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO memory_facts
         (id, target_path, key, value, confidence, source_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tp, key, value, confidence, sourceRun ?? null, now, now);
    return this.#factById(id)!;
  }

  getFacts(targetPath?: string | null): MemoryFact[] {
    const tp = targetPath ?? null;
    const rows = tp !== null
      ? this.#db
          .prepare<[string], MemoryFactRow>(
            'SELECT * FROM memory_facts WHERE target_path = ? OR target_path IS NULL ORDER BY updated_at DESC',
          )
          .all(tp)
      : this.#db
          .prepare<[], MemoryFactRow>(
            'SELECT * FROM memory_facts WHERE target_path IS NULL ORDER BY updated_at DESC',
          )
          .all();
    return rows.map(toFact);
  }

  #factById(id: string): MemoryFact | null {
    const row = this.#db
      .prepare<[string], MemoryFactRow>('SELECT * FROM memory_facts WHERE id = ?')
      .get(id);
    return row ? toFact(row) : null;
  }

  // ── Episodic memory ───────────────────────────────────────────────────────

  recordOutcome(data: Omit<MemoryOutcome, 'id' | 'createdAt'>): MemoryOutcome {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO memory_outcomes
         (id, run_id, target_path, platform, status,
          p99_ms, error_rate, stage_reached, medic_classification, lesson, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.runId,
        data.targetPath ?? null,
        data.platform ?? null,
        data.status,
        data.p99Ms ?? null,
        data.errorRate ?? null,
        data.stageReached ?? null,
        data.medicClassification ?? null,
        data.lesson ?? null,
        now,
      );
    const row = this.#db
      .prepare<[string], MemoryOutcomeRow>('SELECT * FROM memory_outcomes WHERE id = ?')
      .get(id)!;
    return toOutcome(row);
  }

  getOutcomes(targetPath?: string | null, limit = 10): MemoryOutcome[] {
    const tp = targetPath ?? null;
    const rows = tp !== null
      ? this.#db
          .prepare<[string, number], MemoryOutcomeRow>(
            'SELECT * FROM memory_outcomes WHERE target_path = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(tp, limit)
      : this.#db
          .prepare<[number], MemoryOutcomeRow>(
            'SELECT * FROM memory_outcomes ORDER BY created_at DESC LIMIT ?',
          )
          .all(limit);
    return rows.map(toOutcome);
  }

  // ── Procedural memory ─────────────────────────────────────────────────────

  saveSkill(data: {
    targetPath?: string | null;
    title: string;
    body: string;
    tags?: string[];
  }): MemorySkill {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO memory_skills (id, target_path, title, body, tags, use_count, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        data.targetPath ?? null,
        data.title,
        data.body,
        JSON.stringify(data.tags ?? []),
        now,
      );
    const row = this.#db
      .prepare<[string], MemorySkillRow>('SELECT * FROM memory_skills WHERE id = ?')
      .get(id)!;
    return toSkill(row);
  }

  loadRelevantSkills(targetPath?: string | null, limit = 5): MemorySkill[] {
    const tp = targetPath ?? null;
    const rows = tp !== null
      ? this.#db
          .prepare<[string, number], MemorySkillRow>(
            `SELECT * FROM memory_skills
             WHERE target_path = ? OR target_path IS NULL
             ORDER BY use_count DESC, created_at DESC
             LIMIT ?`,
          )
          .all(tp, limit)
      : this.#db
          .prepare<[number], MemorySkillRow>(
            'SELECT * FROM memory_skills WHERE target_path IS NULL ORDER BY use_count DESC LIMIT ?',
          )
          .all(limit);
    return rows.map(toSkill);
  }

  markSkillUsed(id: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'UPDATE memory_skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
      )
      .run(now, id);
  }

  // ── Decision tracing ──────────────────────────────────────────────────────

  traceDecision(
    runId: string,
    stage: string,
    decisionType: string,
    decision: string,
    inputHash?: string,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO decision_traces
         (id, run_id, stage, decision_type, input_hash, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, stage, decisionType, inputHash ?? null, decision, now);
    return id;
  }

  resolveDecision(traceId: string, outcome: string): void {
    this.#db
      .prepare('UPDATE decision_traces SET outcome = ? WHERE id = ?')
      .run(outcome, traceId);
  }

  // ── Context summary for enricher ──────────────────────────────────────────

  /**
   * Builds a Markdown-style context block injected into the enricher's system
   * prompt so Opus has prior knowledge of this repo when drafting the plan.
   */
  buildContextSummary(targetPath: string): string {
    const facts = this.getFacts(targetPath);
    const outcomes = this.getOutcomes(targetPath, 5);
    const skills = this.loadRelevantSkills(targetPath, 3);

    if (facts.length === 0 && outcomes.length === 0 && skills.length === 0) {
      return '';
    }

    const parts: string[] = ['## Prior knowledge (from memory)'];

    if (facts.length > 0) {
      parts.push('\n### Persistent facts about this repo');
      for (const f of facts) {
        parts.push(
          `- **${f.key}**: ${f.value}${f.confidence < 0.8 ? ` *(confidence ${(f.confidence * 100).toFixed(0)}%)*` : ''}`,
        );
      }
    }

    if (outcomes.length > 0) {
      parts.push('\n### Recent deployment history');
      for (const o of outcomes) {
        const metrics = [
          o.p99Ms != null ? `p99=${o.p99Ms.toFixed(0)}ms` : null,
          o.errorRate != null ? `err=${o.errorRate.toFixed(3)}%` : null,
        ]
          .filter(Boolean)
          .join(' ');
        const detail = [
          o.platform ?? 'unknown platform',
          o.stageReached ? `reached ${o.stageReached}` : null,
          metrics || null,
          o.lesson ? `→ ${o.lesson}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        parts.push(`- [**${o.status}**] ${detail}`);
      }
    }

    if (skills.length > 0) {
      parts.push('\n### Relevant patterns / skills');
      for (const s of skills) {
        parts.push(`**${s.title}**: ${s.body}`);
      }
    }

    return parts.join('\n');
  }

  close(): void {
    this.#db.close();
  }
}

function toFact(row: MemoryFactRow): MemoryFact {
  return {
    id: row.id,
    targetPath: row.target_path,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceRun: row.source_run,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toOutcome(row: MemoryOutcomeRow): MemoryOutcome {
  return {
    id: row.id,
    runId: row.run_id,
    targetPath: row.target_path,
    platform: row.platform,
    status: row.status,
    p99Ms: row.p99_ms,
    errorRate: row.error_rate,
    stageReached: row.stage_reached,
    medicClassification: row.medic_classification,
    lesson: row.lesson,
    createdAt: new Date(row.created_at),
  };
}

function toSkill(row: MemorySkillRow): MemorySkill {
  return {
    id: row.id,
    targetPath: row.target_path,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags) as string[],
    useCount: row.use_count,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    createdAt: new Date(row.created_at),
  };
}
