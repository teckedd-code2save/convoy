import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPlan } from './index.js';

/**
 * Issue #28 field bug: a repo with root-level docker-compose + Caddyfile
 * scored vps at the plan level, but the backend lane re-scored fly and the
 * frontend lane vercel — producing a "ship to vps" headline alongside a
 * bogus fly-auth preflight blocker. Lanes must inherit the root decision
 * when root-level infra topology binds the services together.
 */
function makeComposeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'convoy-coherence-'));
  writeFileSync(
    join(dir, 'docker-compose.yml'),
    [
      'services:',
      '  backend:',
      '    build: ./backend',
      '    ports:',
      '      - "8000:8000"',
      '  frontend:',
      '    build: ./frontend',
      '    ports:',
      '      - "5173:5173"',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'Caddyfile'), 'example.com {\n  reverse_proxy backend:8000\n}\n', 'utf8');

  mkdirSync(join(dir, 'backend'));
  writeFileSync(join(dir, 'backend', 'requirements.txt'), 'fastapi\nuvicorn\n', 'utf8');
  writeFileSync(join(dir, 'backend', 'main.py'), 'app = None\n', 'utf8');

  mkdirSync(join(dir, 'frontend'));
  writeFileSync(
    join(dir, 'frontend', 'package.json'),
    JSON.stringify({ name: 'frontend', devDependencies: { vite: '^5.0.0' }, scripts: { build: 'vite build' } }, null, 2),
    'utf8',
  );
  return dir;
}

test('lanes inherit the root vps decision when compose + Caddy bind the repo together', async (t) => {
  const prevVpsHost = process.env['CONVOY_VPS_HOST'];
  delete process.env['CONVOY_VPS_HOST'];
  const dir = makeComposeRepo();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevVpsHost !== undefined) process.env['CONVOY_VPS_HOST'] = prevVpsHost;
  });

  const { plan } = await buildPlan(dir, { ai: { disable: true } });

  assert.equal(plan.platform.chosen, 'vps', 'root decision should score vps from compose + Caddyfile');
  assert.ok(plan.lanes.length >= 2, `expected at least 2 lanes, got ${plan.lanes.length}`);
  for (const lane of plan.lanes) {
    assert.equal(
      lane.platformDecision.chosen,
      'vps',
      `lane ${lane.id} (${lane.servicePath}) must inherit vps, got ${lane.platformDecision.chosen}`,
    );
    assert.equal(lane.platformDecision.source, plan.platform.source);
  }

  // The frontend would score vercel well above vps standalone — that
  // disagreement must surface as an advisory, not vanish.
  const frontend = plan.lanes.find((lane) => lane.servicePath === 'frontend');
  assert.ok(frontend, 'frontend lane should exist');
  assert.ok(
    frontend.platformDecision.advisory && /keeping vps/.test(frontend.platformDecision.advisory),
    `frontend lane should carry an advisory, got: ${frontend.platformDecision.advisory ?? '(none)'}`,
  );
});

test('mandate plans pin every lane to the mandated platform', async (t) => {
  const prevVpsHost = process.env['CONVOY_VPS_HOST'];
  delete process.env['CONVOY_VPS_HOST'];
  const dir = makeComposeRepo();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevVpsHost !== undefined) process.env['CONVOY_VPS_HOST'] = prevVpsHost;
  });

  const { plan } = await buildPlan(dir, { ai: { disable: true }, platformMandate: 'fly' });
  assert.equal(plan.platform.chosen, 'fly');
  assert.equal(plan.platform.source, 'mandate');
  for (const lane of plan.lanes) {
    assert.equal(lane.platformDecision.chosen, 'fly');
    assert.equal(lane.platformDecision.source, 'mandate');
  }
});
