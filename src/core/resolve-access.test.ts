import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccessInteractive, type AccessFixer } from './resolve-access.js';
import { type AccessVerifyResult } from './verify-access.js';
import type { PreflightBlocker } from './blockers.js';

function loginBlocker(): PreflightBlocker {
  return {
    id: 'access.vercel.auth',
    title: 'Vercel CLI is not authenticated',
    detail: 'Run vercel login',
    severity: 'hard',
    fixes: [{ kind: 'interactive', label: 'Run vercel login', command: 'vercel login', autoFixable: false }],
  };
}

function failing(): AccessVerifyResult {
  return { ok: false, platform: 'vercel', checks: [], blockers: [loginBlocker()], detail: 'not authenticated' };
}
function passing(): AccessVerifyResult {
  return { ok: true, platform: 'vercel', checks: [], blockers: [], account: 'jane', detail: 'authenticated as jane' };
}

function recordingFixer(confirmReturns: boolean): AccessFixer & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    async confirm() { return confirmReturns; },
    async runCommand(command: string) { ran.push(command); return true; },
    async bootstrap() { return true; },
    note() {},
  };
}

test('resolve loop runs the fix then re-verifies green', async () => {
  // First probe fails, after the fix the second probe passes.
  const results = [failing(), passing()];
  const verify = (async () => results.shift()!) as typeof import('./verify-access.js').verifyDeployAccess;
  const fixer = recordingFixer(true);

  const out = await resolveAccessInteractive('vercel', '/repo', null, null, fixer, { verify });

  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.deepEqual(fixer.ran, ['vercel login']); // it actually ran the login
  assert.equal(out.result.account, 'jane');
});

test('resolve loop stops without looping forever when the operator declines', async () => {
  // Always failing; operator declines every fix → no progress → break.
  const verify = (async () => failing()) as typeof import('./verify-access.js').verifyDeployAccess;
  const fixer = recordingFixer(false);

  const out = await resolveAccessInteractive('vercel', '/repo', null, null, fixer, { verify, maxRounds: 5 });

  assert.equal(out.ok, false);
  assert.equal(fixer.ran.length, 0); // declined → nothing run
  assert.equal(out.attempts, 1); // bailed after the first round made no progress
});

test('resolve loop returns immediately when access is already verified', async () => {
  const verify = (async () => passing()) as typeof import('./verify-access.js').verifyDeployAccess;
  const fixer = recordingFixer(true);
  const out = await resolveAccessInteractive('vercel', '/repo', null, null, fixer, { verify });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 1);
  assert.equal(fixer.ran.length, 0);
});
