import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

const STATE_PATH = resolve(
  process.env['CONVOY_STATE_PATH'] ?? join(process.cwd(), '..', '.convoy', 'state.db'),
);

export interface MedicChatTurn {
  id: string;
  runId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/**
 * Chat with the medic after it has produced a diagnosis. Each run owns its
 * own chat thread. Table created lazily so we don't need a migration step —
 * first write materialises the schema alongside the CLI-owned tables.
 */
function openDb(): Database.Database | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const db = new Database(STATE_PATH, { readonly: false, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS medic_chat_turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_medic_chat_run ON medic_chat_turns(run_id, created_at);
    `);
    return db;
  } catch {
    return null;
  }
}

export function listChatTurns(runId: string): MedicChatTurn[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare<[string], {
        id: string;
        run_id: string;
        role: 'user' | 'assistant';
        content: string;
        created_at: string;
      }>('SELECT * FROM medic_chat_turns WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId);
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function appendChatTurn(
  runId: string,
  role: 'user' | 'assistant',
  content: string,
): MedicChatTurn {
  const db = openDb();
  if (!db) {
    throw new Error('convoy state db unavailable');
  }
  try {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO medic_chat_turns (id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, runId, role, content, createdAt);
    return { id, runId, role, content, createdAt };
  } finally {
    db.close();
  }
}
