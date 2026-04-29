import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanServiceGraph } from './scanner.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('scanServiceGraph keeps all monorepo services as coordinated lanes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'convoy-scan-'));
  tempDirs.push(repo);

  write(repo, 'package.json', JSON.stringify({ name: 'monorepo', workspaces: ['apps/*'] }, null, 2));
  write(repo, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
  write(repo, 'infra/main.tf', 'terraform {}\n');

  write(repo, 'apps/api/package.json', JSON.stringify({
    name: '@repo/api',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^5.0.0', pg: '^8.0.0' },
  }, null, 2));
  write(repo, 'apps/api/.env.example', 'DATABASE_URL=\nREDIS_URL=\n');
  write(repo, 'apps/api/server.js', "app.listen(3001)\n");

  write(repo, 'apps/web/package.json', JSON.stringify({
    name: '@repo/web',
    dependencies: { next: '^15.0.0' },
  }, null, 2));
  write(repo, 'apps/web/app/api/health/route.ts', 'export async function GET() {}\n');

  write(repo, 'apps/worker/package.json', JSON.stringify({
    name: '@repo/worker',
    dependencies: { bullmq: '^5.0.0' },
  }, null, 2));
  write(repo, 'apps/worker/src/worker.ts', 'export const queue = true;\n');

  const graph = scanServiceGraph(repo);
  const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]));

  assert.equal(graph.isMonorepo, true);
  assert.deepEqual(
    [...nodesByPath.keys()].sort(),
    ['apps/api', 'apps/web', 'apps/worker', 'infra'],
  );
  assert.equal(nodesByPath.get('infra')?.role, 'infra');
  assert.equal(nodesByPath.get('apps/api')?.role, 'backend');
  assert.equal(nodesByPath.get('apps/web')?.role, 'frontend');
  assert.equal(nodesByPath.get('apps/worker')?.role, 'worker');
  assert.deepEqual(nodesByPath.get('apps/api')?.dependsOn, ['infra-infra']);
  assert.deepEqual(
    (nodesByPath.get('apps/web')?.dependsOn ?? []).sort(),
    ['backend-apps-api', 'infra-infra', 'worker-apps-worker'],
  );
  assert.deepEqual(nodesByPath.get('apps/api')?.secretsHints.expectedKeys, ['DATABASE_URL', 'REDIS_URL']);
});

function write(root: string, relPath: string, content: string): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}
