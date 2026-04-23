import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PlanSummary } from './plans';

/**
 * Server-side env-staging analysis for the plan page. Mirrors the CLI's
 * computeExpectedKeys + computeStagedKeys so the web panel shows the same
 * accounting the preflight would.
 *
 * Strictly local — reads .env.schema from the plan, .env.example / .env.local.example
 * from the target, and .env.convoy-secrets / .env.convoy-already-set from
 * the target's repo root. No platform queries.
 */

export interface ExpectedKey {
  key: string;
  source: 'schema' | 'example';
}

export function extractEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}

export function computeExpectedKeys(plan: PlanSummary): ExpectedKey[] {
  const seen = new Map<string, ExpectedKey['source']>();

  const schemaFile = plan.author.convoyAuthoredFiles.find((f) => f.path === '.env.schema');
  if (schemaFile) {
    for (const k of extractEnvKeys(schemaFile.contentPreview)) {
      if (!seen.has(k)) seen.set(k, 'schema');
    }
  }

  const targetCwd = plan.target.localPath;
  const exampleCandidates = ['.env.example', '.env.local.example'];
  for (const cand of exampleCandidates) {
    const p = resolve(targetCwd, cand);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf8');
        for (const k of extractEnvKeys(content)) {
          if (!seen.has(k)) seen.set(k, 'example');
        }
      } catch {
        // unreadable — skip
      }
    }
  }

  return [...seen.entries()].map(([key, source]) => ({ key, source }));
}

export interface StagedState {
  stagedLocally: Set<string>;
  markedAlreadySet: Set<string>;
  secretsPath: string;
  alreadySetPath: string;
}

export function computeStagedState(plan: PlanSummary): StagedState {
  const secretsPath = resolve(plan.target.localPath, '.env.convoy-secrets');
  const alreadySetPath = resolve(plan.target.localPath, '.env.convoy-already-set');

  const stagedLocally = new Set<string>();
  if (existsSync(secretsPath)) {
    try {
      for (const k of extractEnvKeys(readFileSync(secretsPath, 'utf8'))) {
        stagedLocally.add(k);
      }
    } catch {
      // ignore
    }
  }

  const markedAlreadySet = new Set<string>();
  if (existsSync(alreadySetPath)) {
    try {
      for (const k of extractEnvKeys(readFileSync(alreadySetPath, 'utf8'))) {
        markedAlreadySet.add(k);
      }
    } catch {
      // ignore
    }
  }

  return { stagedLocally, markedAlreadySet, secretsPath, alreadySetPath };
}

/**
 * Append a KEY=value pair to the plan's .env.convoy-secrets file. Creates
 * the file if missing. Preserves existing content. Normalises trailing
 * newlines so repeated appends don't produce orphan blank lines.
 */
export function appendSecret(plan: PlanSummary, key: string, value: string): string {
  const { secretsPath } = computeStagedState(plan);
  const prior = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : '';
  const separator = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
  appendFileSync(secretsPath, `${separator}${key}=${value}\n`, 'utf8');
  return secretsPath;
}

/**
 * Append a KEY= line to the plan's .env.convoy-already-set file. The file
 * records the operator's declaration that a var is set on the platform
 * (e.g. via Fly console, Vercel env). Convoy does not probe the platform
 * to verify — this is a trust statement.
 */
export function appendAlreadySet(plan: PlanSummary, key: string): string {
  const { alreadySetPath } = computeStagedState(plan);
  const prior = existsSync(alreadySetPath) ? readFileSync(alreadySetPath, 'utf8') : '';
  const separator = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
  appendFileSync(alreadySetPath, `${separator}${key}=\n`, 'utf8');
  return alreadySetPath;
}

/**
 * Remove a key from both the secrets and already-set files. Lets the
 * operator un-stage a var they staged by mistake. Preserves every other
 * line (including comments and blank separators) by rewriting the file
 * without the matching key lines.
 */
export function unstageKey(plan: PlanSummary, key: string): { secretsPath: string; alreadySetPath: string } {
  const { secretsPath, alreadySetPath } = computeStagedState(plan);
  for (const path of [secretsPath, alreadySetPath]) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf8');
      const filtered = content
        .split(/\r?\n/)
        .filter((line) => {
          const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          return !m || m[1] !== key;
        })
        .join('\n');
      writeFileSync(path, filtered, 'utf8');
    } catch {
      // skip
    }
  }
  return { secretsPath, alreadySetPath };
}

export interface RecurringPref {
  recurring: boolean;
}

function recurringPrefPath(plan: PlanSummary): string {
  return resolve(plan.target.localPath, `.convoy/apply-prefs-${plan.id}.json`);
}

/**
 * Store the operator's "this is an update to a live service" declaration
 * in a sidecar file next to the plan state. The CLI reads this on apply
 * so the checkbox persists across plan-page visits without mutating the
 * plan JSON itself (plans stay immutable audit artifacts).
 */
export function readRecurringPref(plan: PlanSummary): boolean {
  const p = recurringPrefPath(plan);
  if (!existsSync(p)) return false;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8')) as RecurringPref;
    return obj.recurring === true;
  } catch {
    return false;
  }
}

export function writeRecurringPref(plan: PlanSummary, recurring: boolean): void {
  const p = recurringPrefPath(plan);
  try {
    writeFileSync(p, JSON.stringify({ recurring }, null, 2), 'utf8');
  } catch {
    // best-effort; a CLI --recurring flag remains a fallback
  }
}
