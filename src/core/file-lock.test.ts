import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileLockError, withFileLock } from './file-lock.js';

function tmpLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'convoy-lock-'));
  return join(dir, 'state.db.lock');
}

function cleanup(lockPath: string): void {
  rmSync(join(lockPath, '..'), { recursive: true, force: true });
}

test('withFileLock runs fn, creates the lock file while inside, and releases it after', () => {
  const lockPath = tmpLockPath();
  try {
    let sawLockDuringFn = false;
    const result = withFileLock(lockPath, () => {
      sawLockDuringFn = existsSync(lockPath);
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(sawLockDuringFn, true);
    assert.equal(existsSync(lockPath), false, 'lock must be released after fn returns');
  } finally {
    cleanup(lockPath);
  }
});

test('withFileLock releases the lock when fn throws', () => {
  const lockPath = tmpLockPath();
  try {
    assert.throws(
      () =>
        withFileLock(lockPath, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(existsSync(lockPath), false, 'lock must be released on error paths');
  } finally {
    cleanup(lockPath);
  }
});

test('times out cleanly when the lock is held by a live process', () => {
  const lockPath = tmpLockPath();
  try {
    // Our own PID is alive, so this simulates a genuine concurrent holder.
    writeFileSync(lockPath, `${process.pid}\n`);
    assert.throws(
      () => withFileLock(lockPath, () => {}, { timeoutMs: 50, pollMs: 10 }),
      (err: unknown) =>
        err instanceof FileLockError &&
        err.message.includes(`${process.pid}`) &&
        err.message.includes('delete the lock file'),
    );
    assert.equal(existsSync(lockPath), true, 'a live holder lock is never stolen');
  } finally {
    cleanup(lockPath);
  }
});

test('reaps a stale lock left behind by a dead process', () => {
  const lockPath = tmpLockPath();
  try {
    // PIDs this large do not exist — the previous owner crashed without
    // releasing, and the next writer must recover instead of blocking.
    writeFileSync(lockPath, '999999999\n');
    const result = withFileLock(lockPath, () => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(existsSync(lockPath), false);
  } finally {
    cleanup(lockPath);
  }
});

test('reaps an unparseable lock file once it has aged past staleMs', () => {
  const lockPath = tmpLockPath();
  try {
    // Crash between exclusive create and pid-write leaves an empty file.
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    assert.equal(withFileLock(lockPath, () => 'recovered'), 'recovered');
    assert.equal(existsSync(lockPath), false);
  } finally {
    cleanup(lockPath);
  }
});

test('does not steal a fresh unparseable lock file', () => {
  const lockPath = tmpLockPath();
  try {
    writeFileSync(lockPath, '');
    assert.throws(
      () => withFileLock(lockPath, () => {}, { timeoutMs: 50, pollMs: 10, staleMs: 5_000 }),
      FileLockError,
    );
  } finally {
    cleanup(lockPath);
  }
});
