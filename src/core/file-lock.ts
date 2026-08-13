/**
 * Cross-process advisory file lock with stale-lock reaping.
 *
 * Convoy's SQLite state store is written from multiple processes (parallel
 * `convoy apply` sessions, the MCP server). better-sqlite3 serializes
 * individual statements, but multi-statement sequences — the schema
 * migration, insert-then-read pairs, preflight-blocker replacement — can
 * interleave across processes and corrupt logical state. This module gives
 * the state store a mutual-exclusion primitive: acquire before a write,
 * release in `finally`.
 *
 * The lock file is created with `wx` (exclusive create), so acquisition is
 * atomic. It holds a single line with the owner's PID. If the owner dies
 * without releasing (crash, SIGKILL), a waiter detects the dead PID and
 * reaps the stale lock instead of blocking forever.
 *
 * The lock is NOT re-entrant: do not nest `withFileLock` calls on the same
 * path from the same process — the second acquire sees its own PID as a
 * live holder and times out.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing (default 30s, or $CONVOY_STATE_LOCK_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Sleep between acquisition attempts (default 25ms). */
  pollMs?: number;
  /** Age after which an unparseable lock file is treated as stale (default 30s). */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_STALE_MS = 30_000;

/** Thrown when the lock cannot be acquired within `timeoutMs`. */
export class FileLockError extends Error {
  constructor(lockPath: string, timeoutMs: number, holderPid?: number) {
    const holder = holderPid !== undefined ? `PID ${holderPid}` : 'another process';
    super(
      `Timed out after ${timeoutMs}ms waiting for state lock ${lockPath}. ` +
        `${holder} is holding it — concurrent convoy writes are serialized on ` +
        `purpose. If no other convoy process is running, delete the lock file ` +
        `and retry.`,
    );
    this.name = 'FileLockError';
  }
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`.
 *
 * The lock is released (file unlinked) when `fn` returns or throws, so a
 * failed write never leaves a stale lock behind.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const fd = acquire(lockPath, options);
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      unlinkSync(lockPath);
    }
  }
}

function acquire(lockPath: string, options: FileLockOptions): number {
  const timeoutMs = options.timeoutMs ?? envTimeoutMs();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      // The file was created by us (exclusive flag) — record the owner PID.
      writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (err) {
      if (!isEeexist(err)) throw err;
      if (Date.now() >= deadline) {
        throw new FileLockError(lockPath, timeoutMs, holderPid(lockPath));
      }
      // Steal the lock if its owner is gone (crash, SIGKILL) or the file is
      // an aged leftover from a crash mid-write.
      if (reapIfStale(lockPath, staleMs)) continue;
      sleep(pollMs);
    }
  }
}

function holderPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the lock file if the owning process no longer exists. Returns true
 * when the lock was reaped (the caller should retry acquisition immediately).
 */
function reapIfStale(lockPath: string, staleMs: number): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0) {
      if (isProcessAlive(pid)) return false; // legitimately held
    } else {
      // Crash between create and pid-write leaves an unreadable file. Only
      // treat it as stale once it's old enough that no live owner could
      // plausibly still be mid-write.
      if (Date.now() - statSync(lockPath).mtimeMs < staleMs) return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    // ENOENT: someone else reaped it — retry acquisition.
    if (isEnoent(err)) return true;
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isEeexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function envTimeoutMs(): number {
  const raw = process.env['CONVOY_STATE_LOCK_TIMEOUT_MS'];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function sleep(ms: number): void {
  // Block synchronously without busy-spinning the CPU. The state store's
  // better-sqlite3 calls are synchronous, so a sync wait fits the model.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
