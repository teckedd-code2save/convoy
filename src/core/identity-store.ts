/**
 * Per-developer deploy identity — the machine-local half of `convoy connect`.
 *
 * Where does THIS developer's access come from? Which local SSH key, or the
 * agent? That answer differs per person and per machine, so it must NOT live
 * in the repo (where it would be committed and wrong for everyone else). It
 * lives in `~/.convoy/identity.json`, keyed by repo + platform.
 *
 * Like everything else in Convoy's credential story, this stores REFERENCES,
 * never secrets: a key *path*, the choice to use ssh-agent, or an opaque OS
 * keychain *handle*. The private key never leaves ~/.ssh; no token value is
 * ever written here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Platform } from './types.js';

/** How this machine authenticates to a target. A pointer, never a secret. */
export type IdentityRef =
  | { kind: 'ssh-key-path'; path: string }
  | { kind: 'ssh-agent' }
  | { kind: 'cli-cache' } // platform CLI (fly/vercel/gcloud/railway) holds its own auth
  | { kind: 'keychain'; handle: string };

export interface DeployIdentity {
  platform: Platform;
  ref: IdentityRef;
  updatedAt: string;
}

interface IdentityFile {
  version: 1;
  /** Keyed by `${repoKey}::${platform}`. */
  entries: Record<string, DeployIdentity>;
}

/**
 * Stable per-repo key. We use the absolute repo path — it's machine-local
 * anyway, and avoids hashing surprises across checkouts of the same repo in
 * different directories (each gets its own identity, which is correct).
 */
export function repoKeyFor(repoPath: string): string {
  return resolve(repoPath);
}

export function identityPath(): string {
  return join(homedir(), '.convoy', 'identity.json');
}

function load(): IdentityFile {
  const p = identityPath();
  if (!existsSync(p)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as IdentityFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return { version: 1, entries: {} };
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function persist(file: IdentityFile): void {
  const dir = join(homedir(), '.convoy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(identityPath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

export function getIdentity(repoPath: string, platform: Platform): DeployIdentity | null {
  const file = load();
  return file.entries[`${repoKeyFor(repoPath)}::${platform}`] ?? null;
}

export function setIdentity(repoPath: string, platform: Platform, ref: IdentityRef): DeployIdentity {
  const file = load();
  const entry: DeployIdentity = { platform, ref, updatedAt: new Date().toISOString() };
  file.entries[`${repoKeyFor(repoPath)}::${platform}`] = entry;
  persist(file);
  return entry;
}
