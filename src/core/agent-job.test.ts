import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentJobStore } from './agent-job.js';

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'convoy-agent-job-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

test('persists jobs, child tasks, checkpoints and evidence across store restarts', () => {
  const repo = tmp();
  const store = new AgentJobStore(repo);
  const job = store.createJob({
    goal: 'ship the API safely',
    capabilities: ['repo.inspect', 'deploy.verify'],
  });
  store.transitionJob(job.id, 'running');

  const parent = store.createTask(job.id, { title: 'inspect repo' });
  store.transitionTask(parent.id, 'running');
  store.checkpointTask(parent.id, { scanned: true });
  store.addArtifact(parent.id, { kind: 'repo-scan', services: 3 });

  const child = store.createTask(job.id, {
    title: 'verify deployment',
    parentTaskId: parent.id,
  });
  store.close();

  const reopened = new AgentJobStore(repo);
  assert.equal(reopened.getJob(job.id)?.status, 'running');
  assert.deepEqual(reopened.getTask(parent.id)?.checkpoint, { scanned: true });
  assert.equal(reopened.getTask(parent.id)?.artifacts[0]?.['kind'], 'repo-scan');
  assert.equal(reopened.getTask(child.id)?.parentTaskId, parent.id);
  reopened.close();
});

test('rejects invalid transitions and allows retry from failed', () => {
  const repo = tmp();
  const store = new AgentJobStore(repo);
  const job = store.createJob({ goal: 'diagnose production' });
  assert.throws(() => store.transitionJob(job.id, 'completed'), /Invalid agent job transition/);

  store.transitionJob(job.id, 'running');
  store.transitionJob(job.id, 'failed');
  const retried = store.transitionJob(job.id, 'running');
  assert.equal(retried.status, 'running');
  store.close();
});

test('parent task must belong to the same job', () => {
  const repo = tmp();
  const store = new AgentJobStore(repo);
  const a = store.createJob({ goal: 'a' });
  const b = store.createJob({ goal: 'b' });
  const parent = store.createTask(a.id, { title: 'parent' });
  assert.throws(
    () => store.createTask(b.id, { title: 'child', parentTaskId: parent.id }),
    /same job/,
  );
  store.close();
});
