import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveTarget } from './target-resolver.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTarget uses localBaseDir for relative local paths', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'convoy-target-'));
  tempDirs.push(repo);

  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });

  const resolvedRepo = await resolveTarget('.', { localBaseDir: repo, fetch: false });
  const resolvedApp = await resolveTarget('./apps/web', { localBaseDir: repo, fetch: false });

  assert.equal(resolvedRepo.source, 'local');
  assert.equal(resolvedRepo.localPath, repo);
  assert.equal(resolvedApp.source, 'local');
  assert.equal(resolvedApp.localPath, join(repo, 'apps', 'web'));
});
