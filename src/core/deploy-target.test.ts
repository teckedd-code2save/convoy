import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTarget, upsertTarget, isTargetVerified, parseSecretSource } from './deploy-target.js';
import { getIdentity, setIdentity, identityPath } from './identity-store.js';
import type { DeployTarget } from '../onboard/preferences.js';

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'convoy-target-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const vpsTarget: DeployTarget = {
  platform: 'vps',
  host: 'deploy@box.example.com',
  imageRef: 'ghcr.io/acme/app',
  secretSource: { kind: 'manager', manager: 'infisical' },
  verification: { verifiedAt: '2026-06-18T00:00:00.000Z', status: 'verified', account: 'deploy' },
};

test('upsertTarget round-trips a committed target and writes .convoy/.gitignore', () => {
  const repo = tmp();
  upsertTarget(repo, vpsTarget);

  const back = getTarget(repo, 'vps');
  assert.deepEqual(back, vpsTarget);

  // preferences.json itself must NOT be ignored (it's team-shared config)…
  const gi = readFileSync(join(repo, '.convoy', '.gitignore'), 'utf8');
  assert.match(gi, /state\.db/);
  assert.match(gi, /preferences\.json is intentionally NOT ignored/);
  assert.doesNotMatch(gi, /^preferences\.json$/m);
});

test('the committed target holds no secret values — only coordinates + a pointer', () => {
  const repo = tmp();
  upsertTarget(repo, vpsTarget);
  const raw = readFileSync(join(repo, '.convoy', 'preferences.json'), 'utf8');
  // coordinates + pointer present; nothing token/key-shaped.
  assert.match(raw, /ghcr\.io\/acme\/app/);
  assert.match(raw, /"manager": "infisical"/);
  assert.doesNotMatch(raw, /ghp_|BEGIN [A-Z ]*PRIVATE KEY|password/i);
});

test('upsertTarget preserves other platforms and other preferences', () => {
  const repo = tmp();
  upsertTarget(repo, vpsTarget);
  upsertTarget(repo, { platform: 'vercel', appName: 'site', secretSource: { kind: 'platform-native' }, verification: { verifiedAt: null, status: 'unverified' } });
  assert.equal(getTarget(repo, 'vps')?.host, 'deploy@box.example.com');
  assert.equal(getTarget(repo, 'vercel')?.appName, 'site');
});

test('isTargetVerified only true for status verified', () => {
  assert.equal(isTargetVerified(vpsTarget), true);
  assert.equal(isTargetVerified({ ...vpsTarget, verification: { verifiedAt: null, status: 'failed' } }), false);
  assert.equal(isTargetVerified(null), false);
});

test('parseSecretSource maps strings to pointers, falls back on unknown', () => {
  assert.deepEqual(parseSecretSource('infisical', { kind: 'env-file' }), { kind: 'manager', manager: 'infisical' });
  assert.deepEqual(parseSecretSource('azure-devops', { kind: 'env-file' }), { kind: 'manager', manager: 'azure-devops' });
  assert.deepEqual(parseSecretSource('platform-native', { kind: 'env-file' }), { kind: 'platform-native' });
  assert.deepEqual(parseSecretSource('nonsense', { kind: 'env-file' }), { kind: 'env-file' });
  assert.deepEqual(parseSecretSource(undefined, { kind: 'interactive' }), { kind: 'interactive' });
});

test('identity store is machine-local and keyed by repo+platform', () => {
  const fakeHome = tmp();
  const realHome = process.env['HOME'];
  process.env['HOME'] = fakeHome;
  try {
    const repo = tmp();
    setIdentity(repo, 'vps', { kind: 'ssh-key-path', path: '/Users/dev/.ssh/id_ed25519' });
    const back = getIdentity(repo, 'vps');
    assert.equal(back?.ref.kind, 'ssh-key-path');
    // It lives under ~/.convoy, never in the repo.
    assert.ok(identityPath().startsWith(fakeHome));
    assert.equal(existsSync(join(repo, '.convoy', 'identity.json')), false);
    // A different repo gets its own identity.
    assert.equal(getIdentity(tmp(), 'vps'), null);
  } finally {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
  }
});
