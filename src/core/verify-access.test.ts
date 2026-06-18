import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyDeployAccess, type VerifyDeps } from './verify-access.js';
import type { ConnectionStatus } from '../adapters/types.js';
import type { DeployTarget } from '../onboard/preferences.js';
import type { DeployIdentity } from './identity-store.js';

function connStatus(partial: Partial<ConnectionStatus>): ConnectionStatus {
  return {
    platform: 'vercel',
    cliAvailable: true,
    authenticated: false,
    projectLinked: false,
    rollbackReady: false,
    envKeys: [],
    expectedSecrets: [],
    missingExpectedSecrets: [],
    secretsReady: true,
    checks: [],
    ...partial,
  };
}

function deps(over: Partial<VerifyDeps>): VerifyDeps {
  return {
    probePlatformConnection: (async () => connStatus({})) as VerifyDeps['probePlatformConnection'],
    sshAvailable: async () => true,
    probeSshAuth: async () => ({ status: 'connected', user: 'deploy', detail: 'connected as deploy' }),
    probeRemote: async () => ({ reachable: true, hasDocker: true, hasNginx: false, deployRootExists: true, diskFreeGb: 50, user: 'deploy' }),
    ...over,
  };
}

const ident: DeployIdentity = { platform: 'vps', ref: { kind: 'ssh-key-path', path: '/k' }, updatedAt: '' };

test('cloud: not-authenticated maps to a hard blocker carrying the login command', async () => {
  const d = deps({
    probePlatformConnection: (async () => connStatus({
      platform: 'vercel',
      checks: [
        { area: 'cli', ok: true, required: true, summary: 'vercel installed' },
        { area: 'auth', ok: false, required: true, summary: 'Vercel CLI is not authenticated', remedy: 'Run vercel login', command: 'vercel login' },
      ],
    })) as VerifyDeps['probePlatformConnection'],
  });
  const res = await verifyDeployAccess('vercel', '/repo', null, null, { probeRemote: true }, d);
  assert.equal(res.ok, false);
  assert.equal(res.blockers.length, 1);
  const fix = res.blockers[0]!.fixes[0]!;
  assert.equal(fix.command, 'vercel login');
  assert.equal(fix.kind, 'interactive'); // auth fixes are run in the foreground
});

test('cloud: authenticated yields ok with the account', async () => {
  const d = deps({
    probePlatformConnection: (async () => connStatus({
      platform: 'fly',
      account: 'jane@example.com',
      checks: [{ area: 'auth', ok: true, required: true, summary: 'authed' }],
    })) as VerifyDeps['probePlatformConnection'],
  });
  const res = await verifyDeployAccess('fly', '/repo', null, null, { probeRemote: true }, d);
  assert.equal(res.ok, true);
  assert.equal(res.account, 'jane@example.com');
});

test('cloud: no probe consent never blocks (verifies later)', async () => {
  const res = await verifyDeployAccess('vercel', '/repo', null, null, { probeRemote: false }, deps({}));
  assert.equal(res.ok, true);
  assert.equal(res.blockers.length, 0);
});

const vps: DeployTarget = { platform: 'vps', host: 'deploy@box', secretSource: { kind: 'env-file' }, verification: { verifiedAt: null, status: 'unverified' } };

test('vps: no host configured blocks with a convoy connect fix', async () => {
  const res = await verifyDeployAccess('vps', '/repo', null, ident, { probeRemote: true }, deps({}));
  assert.equal(res.ok, false);
  assert.equal(res.blockers[0]!.id, 'access.vps.no-host');
});

test('vps: auth-failed maps to an ssh-copy-id blocker', async () => {
  const d = deps({ probeSshAuth: async () => ({ status: 'auth-failed', detail: 'SSH key auth failed' }) });
  const res = await verifyDeployAccess('vps', '/repo', vps, ident, { probeRemote: true }, d);
  assert.equal(res.ok, false);
  assert.equal(res.blockers[0]!.id, 'access.vps.auth');
  assert.match(res.blockers[0]!.fixes[0]!.command ?? '', /^ssh-copy-id deploy@box/);
});

test('vps: unreachable is a distinct blocker from auth-failed', async () => {
  const d = deps({ probeSshAuth: async () => ({ status: 'unreachable', detail: 'Host unreachable' }) });
  const res = await verifyDeployAccess('vps', '/repo', vps, ident, { probeRemote: true }, d);
  assert.equal(res.blockers[0]!.id, 'access.vps.unreachable');
});

test('vps: connected + docker present verifies green', async () => {
  const res = await verifyDeployAccess('vps', '/repo', vps, ident, { probeRemote: true }, deps({}));
  assert.equal(res.ok, true);
  assert.equal(res.account, 'deploy');
});

test('vps: connected but docker missing blocks on bootstrap', async () => {
  const d = deps({ probeRemote: async () => ({ reachable: true, hasDocker: false, hasNginx: false, deployRootExists: false, diskFreeGb: 50, user: 'deploy' }) });
  const res = await verifyDeployAccess('vps', '/repo', vps, ident, { probeRemote: true }, d);
  assert.equal(res.ok, false);
  assert.equal(res.blockers[0]!.id, 'access.vps.docker');
  assert.match(res.blockers[0]!.fixes[0]!.command ?? '', /vps bootstrap deploy@box/);
});
