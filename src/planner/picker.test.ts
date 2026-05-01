import test from 'node:test';
import assert from 'node:assert/strict';

import { pickPlatform } from './picker.js';
import type { ScanResult } from './scanner.js';

test('VPS is opt-in by default — Fly outscores it for container-shaped repos', () => {
  // Without CONVOY_VPS_HOST set, VPS should not autopick over a managed
  // PaaS for a typical Dockerfile + Postgres app.
  delete process.env['CONVOY_VPS_HOST'];
  const decision = pickPlatform(scanResult({ hasDockerfile: true, dataLayer: ['postgres'] }));
  assert.notEqual(decision.chosen, 'vps', 'VPS should never autopick without explicit opt-in');
});

test('VPS jumps to top when CONVOY_VPS_HOST is set and Dockerfile is present', () => {
  process.env['CONVOY_VPS_HOST'] = 'deploy@example.com';
  try {
    const decision = pickPlatform(scanResult({ hasDockerfile: true }));
    assert.equal(decision.chosen, 'vps', 'opt-in env should make VPS the top score');
  } finally {
    delete process.env['CONVOY_VPS_HOST'];
  }
});

test('--platform=vps override is respected even without opt-in', () => {
  delete process.env['CONVOY_VPS_HOST'];
  const decision = pickPlatform(scanResult({ hasDockerfile: true }), 'vps');
  assert.equal(decision.chosen, 'vps');
  assert.equal(decision.source, 'override');
});

test('VPS is rejected for static-only sites — CDN territory', () => {
  process.env['CONVOY_VPS_HOST'] = 'deploy@example.com';
  try {
    const decision = pickPlatform(scanResult({ topology: 'static' }));
    assert.notEqual(decision.chosen, 'vps', 'static sites belong on a CDN');
  } finally {
    delete process.env['CONVOY_VPS_HOST'];
  }
});

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    localPath: '/tmp/repo',
    scanRoot: '/tmp/repo',
    ecosystem: 'node',
    language: 'typescript',
    runtime: 'node',
    framework: null,
    topology: 'web',
    dataLayer: [],
    existingPlatform: null,
    hasDockerfile: false,
    hasDockerignore: false,
    dockerfileBase: null,
    hasCi: false,
    packageManager: 'npm',
    startCommand: 'npm start',
    buildCommand: 'npm run build',
    devCommand: 'npm run dev',
    testCommand: 'npm test',
    healthPath: '/health',
    port: 3000,
    scripts: {},
    topLevelDirs: ['src'],
    topLevelFiles: ['package.json'],
    sourceDirs: ['src'],
    testDirs: ['test'],
    isMonorepo: false,
    monorepoTool: null,
    workspaces: [],
    subServices: [],
    readmeTitle: 'Repo',
    readmeFirstPara: 'Example repo',
    deployability: 'deployable-web-service',
    deployabilityReason: 'Deployable web service.',
    evidence: ['package.json present'],
    risks: [],
    ...overrides,
  };
}
