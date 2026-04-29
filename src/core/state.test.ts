import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
