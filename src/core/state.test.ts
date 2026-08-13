import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RunStateStore } from './state.js';

test('RunStateStore persists lane ids on events and approvals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convoy-state-'));
  const dbPath = join(dir, 'state.db');
  const store = new RunStateStore(dbPath);

  try {
    const run = store.createRun('https://github.com/example/repo');
    store.appendEvent(run.id, 'scan', 'progress', { phase: 'scan.repo' }, 'backend-apps-api');
    store.requestApproval(run.id, 'stage_secrets', { missing: ['DATABASE_URL'] }, 'backend-apps-api');

    const [event] = store.listEvents(run.id);
    const [approval] = store.listPendingApprovals(run.id);

    assert.equal(event?.laneId, 'backend-apps-api');
    assert.equal(approval?.laneId, 'backend-apps-api');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two stores on the same DB serialize writes without corrupting state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convoy-state-'));
  const dbPath = join(dir, 'state.db');
  const lockPath = `${dbPath}.lock`;

  // Second construction exercises the same migration path a second process
  // would — both run #migrate on the same file. The file lock serializes
  // schema setup so the ALTER TABLEs cannot race.
  const a = new RunStateStore(dbPath);
  const b = new RunStateStore(dbPath);

  try {
    const runA = a.createRun('https://github.com/example/a');
    const runB = b.createRun('https://github.com/example/b');
    a.appendEvent(runA.id, 'scan', 'progress', { phase: 'scan.repo' });
    b.appendEvent(runB.id, 'rehearse', 'progress', { phase: 'deploy.push' });
    a.requestApproval(runA.id, 'promote', { lane: 'web' });
    b.decideApproval(a.listPendingApprovals(runA.id)[0]!.id, 'approved');

    assert.equal(a.getRun(runA.id)?.status, 'pending');
    assert.equal(b.getRun(runB.id)?.status, 'pending');
    assert.equal(a.listEvents(runA.id).length, 1);
    assert.equal(b.listEvents(runB.id).length, 1);
    assert.equal(a.listRecentRuns(10).length, 2, 'both runs visible from both connections');
    assert.equal(existsSync(lockPath), false, 'no lock file left behind');
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
