/**
 * Resolve-in-place: the whole point of `convoy connect`. When access
 * verification finds a blocker, we don't throw it back at the operator and
 * make them re-run — we walk them through fixing it *now*, in the same
 * session, then re-verify, and loop until access is green or they bail.
 *
 *   not logged in to Vercel  → run `vercel login` for them, wait, re-check
 *   ssh key not trusted      → run `ssh-copy-id <host>`, re-check
 *   docker missing on box    → offer `convoy vps bootstrap`, re-check
 *
 * The loop is driven by the structured blockers `verifyDeployAccess` emits, so
 * it stays generic. The `AccessFixer` seam keeps it unit-testable: tests pass
 * a fake fixer; the CLI passes one backed by readline + child_process with
 * inherited stdio (so the platform's own login UI shows through).
 */
import type { Platform } from './types.js';
import type { DeployTarget } from '../onboard/preferences.js';
import type { DeployIdentity } from './identity-store.js';
import type { PreflightBlocker } from './blockers.js';
import { verifyDeployAccess, type AccessVerifyResult, type VerifyOptions } from './verify-access.js';

/**
 * The actions the resolve loop needs from its environment. The CLI implements
 * these with real prompts + foreground subprocesses; tests stub them.
 */
export interface AccessFixer {
  /** Ask a yes/no question. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Run a foreground command (stdio inherited) — returns true on exit 0. */
  runCommand(command: string): Promise<boolean>;
  /** Provision Docker/Caddy on the box. Returns true on success. */
  bootstrap(host: string): Promise<boolean>;
  /** Print an operator-facing line (manual remedies, progress notes). */
  note(message: string): void;
}

export interface ResolveResult {
  ok: boolean;
  /** The final verification result after the loop settled. */
  result: AccessVerifyResult;
  /** Attempts made (1 = verified on first probe, no fixing needed). */
  attempts: number;
}

/** Decide the concrete fix for a blocker, or null if it's purely manual. */
function plannedFix(
  blocker: PreflightBlocker,
  target: DeployTarget | null,
): { kind: 'run'; command: string; label: string } | { kind: 'bootstrap'; host: string } | null {
  // Docker-on-box → call bootstrap directly (not a recursive convoy subprocess).
  if (blocker.id === 'access.vps.docker' && target?.host) {
    return { kind: 'bootstrap', host: target.host };
  }
  const runnable = blocker.fixes.find(
    (f) => (f.kind === 'interactive' || f.kind === 'shell') && f.command && f.command.split(' ')[0] !== 'convoy',
  );
  if (runnable?.command) return { kind: 'run', command: runnable.command, label: runnable.label };
  return null;
}

/**
 * Verify access and resolve every fixable blocker in place. Returns once
 * access is green, or once a round makes no progress (operator declined every
 * fix, or a blocker is purely manual). The caller persists `result` and
 * decides whether a non-ok outcome is fatal (CI) or just informational.
 */
export async function resolveAccessInteractive(
  platform: Platform,
  repoPath: string,
  target: DeployTarget | null,
  identity: DeployIdentity | null,
  fixer: AccessFixer,
  opts: {
    maxRounds?: number;
    expectedSecrets?: string[];
    /** Injectable for tests; defaults to the real verifier. */
    verify?: typeof verifyDeployAccess;
  } = {},
): Promise<ResolveResult> {
  const maxRounds = opts.maxRounds ?? 4;
  const verify = opts.verify ?? verifyDeployAccess;
  const verifyOpts: VerifyOptions = {
    probeRemote: true,
    ...(opts.expectedSecrets ? { expectedSecrets: opts.expectedSecrets } : {}),
  };

  let result = await verify(platform, repoPath, target, identity, verifyOpts);
  let attempts = 1;
  if (result.ok) return { ok: true, result, attempts };

  for (let round = 0; round < maxRounds && !result.ok; round++) {
    let progressed = false;

    for (const blocker of result.blockers) {
      const fix = plannedFix(blocker, target);
      if (!fix) {
        const manual = blocker.fixes.find((f) => f.kind === 'manual');
        fixer.note(`• ${blocker.title} — ${manual?.label ?? blocker.detail}`);
        continue;
      }

      if (fix.kind === 'bootstrap') {
        if (await fixer.confirm(`Provision Docker + Caddy on ${fix.host} now?`, true)) {
          progressed = (await fixer.bootstrap(fix.host)) || progressed;
        }
        continue;
      }

      if (await fixer.confirm(`${blocker.title}. Run \`${fix.command}\` now?`, true)) {
        const ran = await fixer.runCommand(fix.command);
        progressed = ran || progressed;
        if (!ran) fixer.note(`  \`${fix.command}\` did not complete cleanly — re-checking anyway.`);
      } else {
        fixer.note(`  Skipped \`${fix.command}\`. Convoy still needs this before it can deploy.`);
      }
    }

    if (!progressed) break; // nothing left we can act on this round

    result = await verify(platform, repoPath, target, identity, verifyOpts);
    attempts++;
  }

  return { ok: result.ok, result, attempts };
}
