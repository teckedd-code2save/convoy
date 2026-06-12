import test from 'node:test';
import assert from 'node:assert/strict';

import { collectPlatformSignals, detectDrift, signalsToAdjustments } from './drift.js';
import type { OrientResult } from './index.js';
import type { DeployPreferences } from '../onboard/preferences.js';
import { DEFAULT_PREFERENCES } from '../onboard/preferences.js';

function orientResult(overrides: {
  topLevelFiles?: string[];
  topLevelDirs?: string[];
  deploySteps?: string[];
} = {}): OrientResult {
  return {
    graph: {
      localPath: '/tmp/repo',
      scanRoot: '/tmp/repo',
      workspace: null,
      isMonorepo: false,
      monorepoTool: null,
      readmeTitle: null,
      readmeFirstPara: null,
      topLevelDirs: overrides.topLevelDirs ?? [],
      topLevelFiles: overrides.topLevelFiles ?? [],
      evidence: [],
      risks: [],
      nodes: [],
    } as unknown as OrientResult['graph'],
    ciWorkflows: overrides.deploySteps
      ? [{ file: '.github/workflows/deploy.yml', triggers: ['push'], deploySteps: overrides.deploySteps, secretsReferenced: [] }]
      : [],
    secretsManager: null,
    observability: [],
    summary: '',
  };
}

function prefs(overrides: { vpsHost?: string | null } = {}): DeployPreferences {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...DEFAULT_PREFERENCES,
    deployment: { ...DEFAULT_PREFERENCES.deployment, vpsHost: overrides.vpsHost ?? null },
  };
}

test('vercel.json against a fly mandate is drift; fly.toml is not', () => {
  const signals = collectPlatformSignals(
    orientResult({ topLevelFiles: ['fly.toml', 'vercel.json'] }),
    prefs(),
  );
  const drift = detectDrift('fly', signals);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.detectedPlatform, 'vercel');
  assert.equal(drift[0]!.evidence, 'vercel.json');
});

test('consistent repo (mandate platform only) produces no drift', () => {
  const signals = collectPlatformSignals(orientResult({ topLevelFiles: ['fly.toml'] }), prefs());
  assert.equal(detectDrift('fly', signals).length, 0);
});

test('CI deploy steps surface as +30 adjustments; config files as +40', () => {
  const signals = collectPlatformSignals(
    orientResult({ topLevelFiles: ['railway.json'], deploySteps: ['run: gcloud run deploy api --image x'] }),
    prefs(),
  );
  const adjustments = signalsToAdjustments(signals);
  assert.equal(adjustments.railway?.[0]?.delta, 40);
  assert.equal(adjustments.cloudrun?.[0]?.delta, 30);
  assert.match(adjustments.cloudrun?.[0]?.label ?? '', /CI already configured/);
});

test('VPS host in preferences yields a +50 vps signal', () => {
  const signals = collectPlatformSignals(orientResult(), prefs({ vpsHost: 'root@203.0.113.7' }));
  const adjustments = signalsToAdjustments(signals);
  assert.equal(adjustments.vps?.[0]?.delta, 50);
  // ...and counts as drift when the mandate points elsewhere.
  assert.equal(detectDrift('fly', signals).length, 1);
});
