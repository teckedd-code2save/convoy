/**
 * Shared "blocker" vocabulary for preflight + access verification.
 *
 * These types started life as private interfaces inside cli.ts. They were
 * lifted here so the access-verification layer (core/verify-access.ts) can
 * emit the exact same structured blockers the apply preflight already renders
 * — one renderer, one persistence path (recordPreflightBlockers), one exit
 * code. cli.ts re-imports them so nothing about its existing rendering
 * changes.
 *
 * The rule (per principles.md, "evidence over assertion"): nothing is a
 * blocker unless it actually blocks *this* deploy on *this* platform. A key
 * the platform manages itself isn't "missing" — it's not the operator's job.
 */

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

export type BlockerFixKind = 'shell' | 'flag' | 'edit-file' | 'interactive' | 'manual';

/**
 * One concrete way to clear a blocker. `autoFixable` + a copyable `command`
 * means Convoy (or the operator with one paste) can resolve it; `interactive`
 * fixes (e.g. `vercel login`) are run in the foreground during the access
 * walkthrough rather than thrown back at the operator.
 */
export interface BlockerFix {
  kind: BlockerFixKind;
  label: string;
  command?: string;
  flag?: string;
  autoFixable: boolean;
}

export interface PreflightBlocker {
  id: string;
  title: string;
  detail: string;
  severity: 'hard' | 'soft';
  fixes: BlockerFix[];
  docsUrl?: string;
}
