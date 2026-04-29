import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateAuthoredFiles, normalizePlan, type ConvoyPlan } from './plan.js';

test('normalizePlan migrates legacy single-lane plans into v2', () => {
  const legacyPlan = {
    id: 'plan-123',
    createdAt: '2026-04-29T00:00:00.000Z',
    target: {
      repoUrl: 'https://github.com/example/repo',
      localPath: '/tmp/repo',
      workspace: 'apps/api',
      name: 'repo',
      branch: 'main',
      sha: 'abc1234',
      mode: 'first-deploy',
      ecosystem: 'node',
      framework: 'express',
      topology: 'api',
      readmeTitle: 'Repo',
      readmeExcerpt: null,
    },
    summary: 'legacy plan',
    deployability: { verdict: 'deployable-web-service', reason: 'web service' },
    platform: {
      chosen: 'fly',
      reason: 'existing config',
      source: 'existing-config',
      candidates: [{ platform: 'fly', score: 9, reason: 'config present' }],
    },
    author: {
      convoyAuthoredFiles: [{ path: 'fly.toml', lines: 10, summary: 'fly', contentPreview: 'app = "demo"' }],
    },
    rehearsal: {
      enabled: true,
      targetDescriptor: 'api',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      expectedPort: 3000,
      healthPath: '/health',
      metricsPath: '/metrics',
      validations: ['health'],
      estimatedDurationSeconds: 90,
      estimatedCost: 'low',
    },
    promotion: { canary: { trafficPercent: 10, bakeWindowSeconds: 60 }, steps: [], haltOn: [] },
    rollback: { strategy: 'instant', target: 'previous release', estimatedSeconds: 30 },
    approvals: [{ kind: 'promote', description: 'ship it', required: true }],
    risks: [{ level: 'warn', message: 'check db' }],
    estimate: { runTimeMinutesMin: 3, runTimeMinutesMax: 5, opusSpendUsdMin: 0, opusSpendUsdMax: 0 },
    evidence: ['package.json present'],
    shipNarrative: [{ step: 1, kind: 'action', text: 'deploy' }],
  };

  const normalized = normalizePlan(legacyPlan as Parameters<typeof normalizePlan>[0]);

  assert.equal(normalized.version, 2);
  assert.equal(normalized.repo.name, 'repo');
  assert.equal(normalized.lanes.length, 1);
  assert.equal(normalized.lanes[0]?.id, 'backend-apps/api');
  assert.equal(normalized.lanes[0]?.servicePath, 'apps/api');
  assert.equal(normalized.connectionRequirements[0]?.platform, 'fly');
});

test('aggregateAuthoredFiles deduplicates multi-lane authored files by path', () => {
  const plan: ConvoyPlan = {
    version: 2,
    id: 'plan-456',
    createdAt: '2026-04-29T00:00:00.000Z',
    repo: {
      repoUrl: null,
      localPath: '/tmp/repo',
      branch: null,
      sha: null,
      mode: 'first-deploy',
      name: 'repo',
      readmeTitle: null,
      readmeExcerpt: null,
    },
    lanes: [
      lane('backend-api', 'backend', 'apps/api', [
        { path: 'Dockerfile', lines: 12, summary: 'api docker', contentPreview: 'FROM node:20' },
      ]),
      lane('frontend-web', 'frontend', 'apps/web', [
        { path: 'Dockerfile', lines: 20, summary: 'web docker', contentPreview: 'FROM node:20-alpine' },
        { path: 'vercel.json', lines: 4, summary: 'vercel', contentPreview: '{}' },
      ]),
    ],
    dependencies: [],
    connectionRequirements: [],
    target: {
      repoUrl: null,
      localPath: '/tmp/repo',
      workspace: null,
      name: 'repo',
      branch: null,
      sha: null,
      mode: 'first-deploy',
      ecosystem: 'mixed',
      framework: null,
      topology: 'web',
      readmeTitle: null,
      readmeExcerpt: null,
    },
    summary: 'summary',
    deployability: { verdict: 'deployable-web-service', reason: 'web service' },
    platform: { chosen: 'fly', reason: 'fallback', source: 'scored', candidates: [] },
    author: { convoyAuthoredFiles: [] },
    rehearsal: {
      enabled: true,
      targetDescriptor: 'repo',
      buildCommand: null,
      startCommand: null,
      expectedPort: null,
      healthPath: null,
      metricsPath: null,
      validations: [],
      estimatedDurationSeconds: 0,
      estimatedCost: 'low',
    },
    promotion: { canary: { trafficPercent: 10, bakeWindowSeconds: 60 }, steps: [], haltOn: [] },
    rollback: { strategy: 'instant', target: 'prior', estimatedSeconds: 0 },
    approvals: [],
    risks: [],
    estimate: { runTimeMinutesMin: 0, runTimeMinutesMax: 0, opusSpendUsdMin: 0, opusSpendUsdMax: 0 },
    evidence: [],
    shipNarrative: [],
  };

  const files = aggregateAuthoredFiles(plan);

  assert.equal(files.length, 2);
  assert.equal(files.find((file) => file.path === 'Dockerfile')?.summary, 'web docker');
  assert.equal(files.find((file) => file.path === 'vercel.json')?.summary, 'vercel');
});

function lane(
  id: string,
  role: ConvoyPlan['lanes'][number]['role'],
  servicePath: string,
  convoyAuthoredFiles: ConvoyPlan['lanes'][number]['author']['convoyAuthoredFiles'],
): ConvoyPlan['lanes'][number] {
  return {
    id,
    role,
    servicePath,
    displayName: id,
    scan: {
      ecosystem: 'node',
      framework: null,
      topology: 'api',
      dataLayer: [],
      startCommand: null,
      buildCommand: null,
      testCommand: null,
      healthPath: null,
      port: null,
      evidence: [],
      risks: [],
    },
    platformDecision: { chosen: 'fly', reason: 'fit', source: 'scored', candidates: [] },
    author: { convoyAuthoredFiles },
    rehearsal: {
      enabled: true,
      targetDescriptor: servicePath,
      buildCommand: null,
      startCommand: null,
      expectedPort: null,
      healthPath: null,
      metricsPath: null,
      validations: [],
      estimatedDurationSeconds: 0,
      estimatedCost: 'low',
    },
    promotion: { canary: { trafficPercent: 10, bakeWindowSeconds: 60 }, steps: [], haltOn: [] },
    rollback: { strategy: 'instant', target: 'prior', estimatedSeconds: 0 },
    approvals: [],
    secrets: { expectedKeys: [], sources: [] },
    statusNarrative: [],
  };
}
