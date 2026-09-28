import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export type AgentJobStatus =
  | 'queued'
  | 'running'
  | 'input_required'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentJob {
  id: string;
  goal: string;
  status: AgentJobStatus;
  harnessProvider: string | null;
  executionProvider: string | null;
  capabilities: string[];
  budget: Record<string, unknown> | null;
  policy: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  jobId: string;
  parentTaskId: string | null;
  title: string;
  status: AgentJobStatus;
  harnessProvider: string | null;
  executionProvider: string | null;
  checkpoint: Record<string, unknown> | null;
  artifacts: Array<Record<string, unknown>>;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

const ALLOWED: Record<AgentJobStatus, AgentJobStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['input_required', 'verifying', 'failed', 'cancelled'],
  input_required: ['running', 'cancelled', 'failed'],
  verifying: ['completed', 'running', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued', 'running', 'cancelled'],
  cancelled: [],
};

function assertTransition(from: AgentJobStatus, to: AgentJobStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`Invalid agent job transition: ${from} -> ${to}`);
  }
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

export class AgentJobStore {
  private readonly db: Database.Database;

  constructor(repoPath: string) {
    const dir = resolve(repoPath, '.convoy');
    mkdirSync(dir, { recursive: true });
    this.db = new Database(resolve(dir, 'state.db'));
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        harness_provider TEXT,
        execution_provider TEXT,
        capabilities_json TEXT NOT NULL,
        budget_json TEXT,
        policy_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        harness_provider TEXT,
        execution_provider TEXT,
        checkpoint_json TEXT,
        artifacts_json TEXT NOT NULL,
        error_text TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tasks_job ON agent_tasks(job_id);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id);
    `);
  }

  createJob(input: {
    goal: string;
    harnessProvider?: string;
    executionProvider?: string;
    capabilities?: string[];
    budget?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  }): AgentJob {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO agent_jobs (
        id, goal, status, harness_provider, execution_provider,
        capabilities_json, budget_json, policy_json, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.goal,
      input.harnessProvider ?? null,
      input.executionProvider ?? null,
      JSON.stringify(input.capabilities ?? []),
      input.budget ? JSON.stringify(input.budget) : null,
      input.policy ? JSON.stringify(input.policy) : null,
      now,
      now,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): AgentJob | null {
    const row = this.db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      goal: String(row['goal']),
      status: row['status'] as AgentJobStatus,
      harnessProvider: (row['harness_provider'] as string | null) ?? null,
      executionProvider: (row['execution_provider'] as string | null) ?? null,
      capabilities: parseJson<string[]>(row['capabilities_json'] as string) ?? [],
      budget: parseJson<Record<string, unknown>>(row['budget_json'] as string | null),
      policy: parseJson<Record<string, unknown>>(row['policy_json'] as string | null),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  transitionJob(id: string, to: AgentJobStatus): AgentJob {
    const current = this.getJob(id);
    if (!current) throw new Error(`Agent job not found: ${id}`);
    assertTransition(current.status, to);
    this.db.prepare('UPDATE agent_jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(to, new Date().toISOString(), id);
    return this.getJob(id)!;
  }

  createTask(jobId: string, input: {
    title: string;
    parentTaskId?: string;
    harnessProvider?: string;
    executionProvider?: string;
  }): AgentTask {
    if (!this.getJob(jobId)) throw new Error(`Agent job not found: ${jobId}`);
    if (input.parentTaskId) {
      const parent = this.getTask(input.parentTaskId);
      if (!parent || parent.jobId !== jobId) {
        throw new Error('Parent task must belong to the same job');
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_tasks (
        id, job_id, parent_task_id, title, status, harness_provider,
        execution_provider, checkpoint_json, artifacts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, '[]', ?, ?)
    `).run(
      id,
      jobId,
      input.parentTaskId ?? null,
      input.title,
      input.harnessProvider ?? null,
      input.executionProvider ?? null,
      now,
      now,
    );
    return this.getTask(id)!;
  }

  getTask(id: string): AgentTask | null {
    const row = this.db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      jobId: String(row['job_id']),
      parentTaskId: (row['parent_task_id'] as string | null) ?? null,
      title: String(row['title']),
      status: row['status'] as AgentJobStatus,
      harnessProvider: (row['harness_provider'] as string | null) ?? null,
      executionProvider: (row['execution_provider'] as string | null) ?? null,
      checkpoint: parseJson<Record<string, unknown>>(row['checkpoint_json'] as string | null),
      artifacts: parseJson<Array<Record<string, unknown>>>(row['artifacts_json'] as string) ?? [],
      error: (row['error_text'] as string | null) ?? null,
      attempts: Number(row['attempts']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  listTasks(jobId: string): AgentTask[] {
    const rows = this.db.prepare('SELECT id FROM agent_tasks WHERE job_id = ? ORDER BY created_at ASC').all(jobId) as Array<{ id: string }>;
    return rows.map(row => this.getTask(row.id)!).filter(Boolean);
  }

  transitionTask(id: string, to: AgentJobStatus, error?: string): AgentTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Agent task not found: ${id}`);
    assertTransition(current.status, to);
    const attempts = to === 'running' ? current.attempts + 1 : current.attempts;
    this.db.prepare(`
      UPDATE agent_tasks
      SET status = ?, error_text = ?, attempts = ?, updated_at = ?
      WHERE id = ?
    `).run(to, error ?? null, attempts, new Date().toISOString(), id);
    return this.getTask(id)!;
  }

  checkpointTask(id: string, checkpoint: Record<string, unknown>): AgentTask {
    if (!this.getTask(id)) throw new Error(`Agent task not found: ${id}`);
    this.db.prepare('UPDATE agent_tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(checkpoint), new Date().toISOString(), id);
    return this.getTask(id)!;
  }

  addArtifact(id: string, artifact: Record<string, unknown>): AgentTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Agent task not found: ${id}`);
    const artifacts = [...current.artifacts, artifact];
    this.db.prepare('UPDATE agent_tasks SET artifacts_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(artifacts), new Date().toISOString(), id);
    return this.getTask(id)!;
  }

  close(): void {
    this.db.close();
  }
}
