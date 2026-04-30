import test from 'node:test';
import assert from 'node:assert/strict';

import { draftAuthorSection } from './author.js';
import type { ScanResult } from './scanner.js';

test('draftAuthorSection authors Vercel vite framework explicitly', () => {
  const section = draftAuthorSection(scanResult({ framework: 'vite' }), 'vercel');
  const vercel = section.convoyAuthoredFiles.find((file) => file.path === 'vercel.json');

  assert.ok(vercel);
  assert.match(vercel.contentPreview, /"framework": "vite"/);
  assert.equal(vercel.summary, 'framework=vite · regions=iad1');
});

test('draftAuthorSection lets Vercel autodetect unknown frameworks', () => {
  const section = draftAuthorSection(scanResult({ framework: 'express' }), 'vercel');
  const vercel = section.convoyAuthoredFiles.find((file) => file.path === 'vercel.json');

  assert.ok(vercel);
  assert.doesNotMatch(vercel.contentPreview, /"framework":/);
  assert.equal(vercel.summary, 'framework=auto-detect · regions=iad1');
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
