import {
  flyAppExists,
  flyAuthStatus,
  flyCreateApp,
  flyctlAvailable,
  flyDeploy,
  flyHealthCheck,
  flyListReleases,
  flyRollback,
  flySetSecrets,
} from '../adapters/fly/runner.js';
import {
  vercelDeploy,
  vercelHealthCheck,
  vercelListDeployments,
  vercelRollback,
} from '../adapters/vercel/runner.js';
import type { ConvoyBus } from './bus.js';
import {
  createPrFromAuthoredFiles,
  detectRepo,
  findExistingConvoyPr,
  gitHubAuthStatus,
  mergePr,
  planBranchName,
  plumbingMatchesDefaultBranch,
  prStatus,
  type GitRepoContext,
} from './github-runner.js';
import { diagnose, type DiagnoseOptions } from './medic.js';
import type { ConvoyPlan } from './plan.js';
import { RehearsalRunner, type MetricsSnapshot } from './rehearsal-runner.js';
import { pickPlatform } from '../planner/picker.js';
import { scanRepository, type ScanResult } from '../planner/scanner.js';
import type { RunStateStore } from './state.js';
import type {
  Approval,
  ApprovalKind,
  EventKind,
  Platform,
  Run,
  RunEvent,
  StageName,
} from './types.js';

export interface OrchestratorOpts {
  dryRun: boolean;
  platformOverride?: Platform;
  autoApprove?: boolean;
  injectFailure?: InjectFailureOpt;
  planId?: string | null;
  /**
   * Keys the operator self-declared via --already-set (or wrote to
   * .env.convoy-already-set) at apply time. CanaryStage's secrets gate
   * uses this to skip the approval pause for keys the operator vouched
   * for. The CLI computes the set in preflight and threads it through
   * here so CanaryStage doesn't need access to ApplyOpts.
   */
  alreadySetKeys?: string[];
  /**
   * When set, the orchestrator continues an existing run row instead of
   * creating a new one. Stages whose last event in this run is `finished`
   * are skipped and their prior payload is replayed into the context. The
   * first stage with a `failed`/incomplete history runs from scratch, and
   * everything after it follows normally. This is what `convoy resume`
   * threads through after the developer fixes a code-level failure.
   */
  continueRunId?: string;
  /**
   * Full plan handed to the stage context so ScanStage can re-run the live
   * scan on plan.target.localPath and PickStage can replay the authoritative
   * pickPlatform decision. Without this, those two stages have no evidence to
   * render — they used to emit hardcoded signals regardless of the repo.
   */
  plan?: ConvoyPlan;
  realRehearsal?: RealRehearsalOpt;
  realAuthor?: RealAuthorOpt;
  realFly?: RealFlyOpt;
  realVercel?: RealVercelOpt;
}

export interface RealAuthorOpt {
  repoPath: string;
  authoredFiles: { path: string; contentPreview: string; summary?: string }[];
  prTitle: string;
  prBody: string;
  mergeOnApproval: boolean;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  /**
   * Operator-authored uncommitted changes captured at preflight. When set,
   * AuthorStage carries these onto the plan-keyed branch as a separate
   * `fix:`-prefixed commit BEFORE writing its plumbing files, so a fix
   * that triggered the resume rides into production through the same PR
   * Convoy is opening — not via a separate `git push origin main` that
   * would trip git-deploy platforms (Vercel, Netlify, Cloud Run) into
   * shipping unproven code.
   *
   * `messageDefault` is the auto-generated commit subject Convoy will use
   * (e.g. "fix: <medic root cause>"). Operator can override later via
   * git rebase if they care; for the demo flow the default is fine.
   */
  carryUncommittedChanges?: {
    files: string[];
    messageDefault: string;
  };
}

export interface RealFlyOpt {
  appName: string;
  cwd: string;
  org?: string;
  createIfMissing?: boolean;
  strategy?: 'canary' | 'rolling' | 'bluegreen' | 'immediate';
  secrets?: Record<string, string>;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealVercelOpt {
  cwd: string;
  healthPath?: string;
  bakeWindowSeconds?: number;
  thresholdErrorRatePct?: number;
  thresholdP99Ms?: number;
  convoyAuthoredFiles?: string[];
}

export interface RealRehearsalOpt {
  /**
   * Repo root — where the lockfile lives. `pnpm install` / `npm ci` runs here.
   * Also used as repoPath for diagnosis context.
   */
  repoPath: string;
  /**
   * Where build and start commands run. Defaults to repoPath when absent.
   * For monorepo workspaces (e.g. `apps/web`) this is the subdir so
   * node_modules/.bin resolves framework binaries (next, vite, tsx, etc.).
   */
  serviceCwd?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand: string;
  port: number;
  healthPath: string;
  metricsPath?: string;
  env?: Record<string, string>;
  probeRequests?: number;
  probeConcurrency?: number;
  probePaths?: string[];
  maxErrorRatePct?: number;
  maxP99Ms?: number;
  convoyAuthoredFiles?: string[];
  /**
   * When true, the rehearsal subprocess inherits the parent env (ANTHROPIC_API_KEY,
   * GH_TOKEN, AWS_*, etc.). Default false — scrubbed to a small allowlist so
   * cloned third-party repos can't exfiltrate operator credentials via their
   * install/start scripts. The CLI surfaces this as --trust-repo.
   */
  inheritAmbientEnv?: boolean;
}

export type InjectFailureOpt = {
  stage: 'rehearse' | 'canary';
  kind: 'latency' | 'error-rate' | 'build';
  logsPath?: string;
  repoPath?: string;
  convoyAuthoredFiles?: string[];
};

export interface StageContext {
  run: Run;
  store: RunStateStore;
  bus: ConvoyBus;
  opts: OrchestratorOpts;
  prior: Record<string, unknown>;
  signal: AbortSignal;
}

export interface Stage {
  readonly name: StageName;
  run(ctx: StageContext): Promise<unknown>;
}

export class ApprovalRejectedError extends Error {
  constructor(readonly kind: ApprovalKind) {
    super(`Approval rejected: ${kind}`);
    this.name = 'ApprovalRejectedError';
  }
}

/**
 * Thrown by triggerRealFlyRollback after it has already set the run to
 * rolled_back. The orchestrator catches this specifically so it does NOT
 * overwrite the status back to 'failed' in its generic error path.
 */
export class RollbackTriggeredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly firedBy: 'promote' | 'observe',
    public readonly restoredVersion?: number,
  ) {
    super(`${firedBy} breach (${reason}) triggered rollback`);
    this.name = 'RollbackTriggeredError';
  }
}

/**
 * Reduce the rehearsal stage's finished-payload to the fields the operator
 * needs to decide whether to open a PR. Tolerates both scripted and real
 * modes, and handles the case where rehearsal didn't run or produced no
 * snapshot. Returns null when there's nothing to show — the approval card
 * then renders "no rehearsal evidence" instead of a half-populated object.
 */
function summarizeRehearsalForApproval(prior: unknown): Record<string, unknown> | null {
  if (!prior || typeof prior !== 'object') return null;
  const p = prior as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof p['mode'] === 'string') summary['mode'] = p['mode'];
  else summary['mode'] = 'real-local';
  if (typeof p['healthy'] === 'boolean') summary['healthy'] = p['healthy'];
  if (typeof p['duration_ms'] === 'number') summary['duration_ms'] = p['duration_ms'];
  if (typeof p['p99_ms'] === 'number') summary['p99_ms'] = p['p99_ms'];
  if (typeof p['smoke_tests_passed'] === 'number') summary['smoke_tests_passed'] = p['smoke_tests_passed'];
  if (typeof p['log_lines'] === 'number') summary['log_lines'] = p['log_lines'];
  if (p['metricsAfter'] && typeof p['metricsAfter'] === 'object') summary['metrics'] = p['metricsAfter'];
  else if (p['metricsBefore'] && typeof p['metricsBefore'] === 'object') summary['metrics'] = p['metricsBefore'];
  return Object.keys(summary).length > 0 ? summary : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

abstract class BaseStage implements Stage {
  abstract readonly name: StageName;
  abstract run(ctx: StageContext): Promise<unknown>;

  protected emit(ctx: StageContext, kind: EventKind, payload: unknown): RunEvent {
    const event = ctx.store.appendEvent(ctx.run.id, this.name, kind, payload);
    ctx.bus.emit({ type: 'event.appended', event });
    return event;
  }

  protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleep(ms, signal);
  }

  /**
   * Streams each tool call the medic agent makes as a `medic.tool_use`
   * progress event so the CLI + web UI can replay "I read src/orders.ts
   * lines 40-80, then grepped for 'orderTotal'" live, instead of only
   * seeing the final diagnosis card.
   */
  protected medicTelemetry(ctx: StageContext): DiagnoseOptions {
    return {
      onToolCall: (call) => {
        this.emit(ctx, 'progress', {
          phase: 'medic.tool_use',
          tool: call.name,
          input: call.input,
        });
      },
    };
  }

  protected async awaitApproval(
    ctx: StageContext,
    kind: ApprovalKind,
    summary: unknown,
  ): Promise<Approval> {
    const approval = ctx.store.requestApproval(ctx.run.id, kind, summary);
    ctx.bus.emit({ type: 'approval.requested', approval });
    this.emit(ctx, 'progress', { awaiting_approval: kind, approval_id: approval.id });

    // Default: pause at every approval gate (opt-out via --auto-approve / -y).
    // The previous default (auto-approve ON) contradicted the README's "humans
    // decide" story and was flagged by pre-demo adversarial review.
    const autoApprove = ctx.opts.autoApprove === true;
    if (autoApprove) {
      await this.sleep(400, ctx.signal);
      const decided = ctx.store.decideApproval(approval.id, 'approved');
      ctx.bus.emit({ type: 'approval.decided', approval: decided });
      return decided;
    }

    // No timeout — operator drives from the web UI on their own schedule.
    // Abort via Ctrl+C or killing the process if the run is no longer wanted.
    while (true) {
      if (ctx.signal.aborted) throw new Error('aborted');
      await this.sleep(400);
      const current = ctx.store.getApproval(approval.id);
      if (!current) throw new Error(`Approval ${approval.id} missing`);
      if (current.status !== 'pending') {
        ctx.bus.emit({ type: 'approval.decided', approval: current });
        if (current.status === 'rejected') {
          throw new ApprovalRejectedError(kind);
        }
        return current;
      }
    }
  }
}

export class ScanStage extends BaseStage {
  readonly name = 'scan' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', { repo_url: ctx.run.repoUrl });

    const plan = ctx.opts.plan;
    if (plan) {
      try {
        const scanOpts = plan.target.workspace ? { workspace: plan.target.workspace } : {};
        const scan = scanRepository(plan.target.localPath, scanOpts);
        const signals = {
          language: scan.language ?? scan.ecosystem,
          runtime: scan.runtime,
          framework: scan.framework,
          topology: scan.topology,
          data: scan.dataLayer,
          hints: {
            has_dockerfile: scan.hasDockerfile,
            has_ci: scan.hasCi,
            package_manager: scan.packageManager,
            monorepo: scan.isMonorepo ? scan.monorepoTool : null,
            existing_platform: scan.existingPlatform,
          },
          evidence: scan.evidence.slice(0, 6),
        };
        this.emit(ctx, 'finished', { signals });
        return scan;
      } catch (err) {
        // Target directory may have moved since the plan was saved. Fall back
        // to the plan's recorded target metadata rather than emitting fiction.
        const message = err instanceof Error ? err.message : String(err);
        this.emit(ctx, 'progress', {
          note: `live scan unavailable: ${message}`,
          fallback: 'plan.target',
        });
        const signals = {
          language: plan.target.ecosystem,
          runtime: null,
          framework: plan.target.framework,
          topology: plan.target.topology,
          data: [] as string[],
          hints: { source: 'plan-record' as const },
        };
        this.emit(ctx, 'finished', { signals });
        return null;
      }
    }

    // No plan attached — shouldn't happen on the apply path, but keep a
    // minimal emission so downstream stages don't crash.
    this.emit(ctx, 'progress', { note: 'no plan attached to run; scan skipped' });
    this.emit(ctx, 'finished', { signals: null });
    return null;
  }
}

export class PickStage extends BaseStage {
  readonly name = 'pick' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    this.emit(ctx, 'started', {});

    const scan = (ctx.prior['scan'] as ScanResult | null | undefined) ?? null;
    const plan = ctx.opts.plan;

    // Prefer re-running pickPlatform against the live scan (that's the
    // honest "we just scored four platforms" demo). Fall back to the plan's
    // recorded decision if live scan failed. Last resort: platformOverride.
    let decision;
    if (scan) {
      decision = pickPlatform(scan, ctx.opts.platformOverride);
      if (plan && decision.chosen !== plan.platform.chosen) {
        this.emit(ctx, 'progress', {
          note: 'live pick diverged from plan',
          plan_chose: plan.platform.chosen,
          live_chose: decision.chosen,
        });
      }
    } else if (plan) {
      decision = plan.platform;
    } else {
      const chosen: Platform = ctx.opts.platformOverride ?? 'fly';
      decision = {
        chosen,
        reason: `fallback: ${chosen}`,
        source: 'override' as const,
        candidates: [],
      };
    }

    ctx.store.updateRun(ctx.run.id, { platform: decision.chosen });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    this.emit(ctx, 'decision', decision);
    this.emit(ctx, 'finished', decision);
    return decision;
  }
}

export class AuthorStage extends BaseStage {
  readonly name = 'author' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realAuthor) {
      return this.#runReal(ctx, ctx.opts.realAuthor);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });
    await this.sleep(1200, ctx.signal);

    // Pull the real authored-file list from the plan so the approval card
    // shows the same evidence the real-author path would: path, line count,
    // summary, and content preview. Previously scripted mode emitted a fake
    // pr_url and a bare string[] of filenames, leaving the operator to
    // approve blind.
    const plan = ctx.opts.plan;
    const files = plan
      ? plan.author.convoyAuthoredFiles.map((f) => ({
          path: f.path,
          lines: f.lines,
          summary: f.summary,
          contentPreview: f.contentPreview,
        }))
      : [
          { path: 'Dockerfile', lines: 0, summary: '(no plan attached)', contentPreview: '' },
        ];

    this.emit(ctx, 'progress', {
      phase: 'files_drafted',
      mode: 'scripted',
      files: files.map((f) => f.path),
      file_count: files.length,
    });

    // Scripted mode never opens a real PR, but the approval card still
    // shows what rehearsal produced + the file set — so the demo narrative
    // matches the real flow: operator sees rehearsal evidence, then says
    // "open it."
    await this.awaitApproval(ctx, 'open_pr', {
      mode: 'scripted',
      note: 'Scripted pipeline — no real PR will be opened. These are the files Convoy would commit after rehearsal.',
      rehearsal: summarizeRehearsalForApproval(ctx.prior['rehearse']),
      files,
    });

    const result = {
      mode: 'scripted' as const,
      files: files.map((f) => f.path),
      merged: true,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runReal(ctx: StageContext, cfg: RealAuthorOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-github', repo_path: cfg.repoPath });

    const repo = await detectRepo(cfg.repoPath);
    if (!repo) {
      throw new Error(
        `real-author requires ${cfg.repoPath} to be a git repo with a github.com remote. ` +
          `Found no .git directory there or no parseable GitHub origin.`,
      );
    }

    this.emit(ctx, 'progress', {
      phase: 'git.detected',
      owner: repo.owner,
      repo: repo.repo,
      default_branch: repo.defaultBranch,
    });

    const auth = await gitHubAuthStatus();
    if (!auth.ok) {
      throw new Error(
        `gh is not authenticated (${auth.error ?? 'unknown'}). Run: gh auth login`,
      );
    }
    this.emit(ctx, 'progress', { phase: 'gh.authenticated', user: auth.user, scopes: auth.scopes });

    // Plan-keyed branch name — stable across resumes. With this, a fix-and-
    // resume after a failed merge force-pushes the same branch and reuses
    // the same PR instead of opening a duplicate. Falls back to run id only
    // when no plan is in context (legacy callers / programmer error).
    const planId = ctx.opts.plan?.id ?? ctx.run.id;
    const branch = planBranchName(planId);

    // Probe BEFORE the open_pr approval. If a PR for this branch was already
    // merged in a prior attempt, AuthorStage has nothing to do and we should
    // tell the operator that — not pause for an approval gate they don't
    // need. If a PR is already open, the approval card surfaces "reuse" so
    // the operator isn't surprised when no new PR appears on GitHub.
    const existing = await findExistingConvoyPr(repo, branch);
    if (existing && existing.state === 'merged') {
      this.emit(ctx, 'progress', {
        phase: 'pr.already_merged',
        pr_url: existing.prUrl,
        pr_number: existing.prNumber,
        branch,
        note: 'A prior attempt of this plan already opened and merged a PR. Skipping author.',
      });
      const result = {
        pr_url: existing.prUrl,
        pr_number: existing.prNumber,
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'merged' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    // Symmetric to pr.already_merged but for the case where the plumbing
    // landed on origin/<default> via a different code path (a hand-merged
    // PR, a run on a legacy run-id-keyed branch, or a developer who copied
    // the files manually). findExistingConvoyPr can't see it because no
    // *open* convoy/<branch> PR exists, but the files ARE already shipped.
    // Without this check, AuthorStage would branch off origin/<default>,
    // write identical content, and crash on `git commit` with "nothing to
    // commit". With it, we recognize the no-op cleanly — but only when no
    // operator carry is needed; if the working tree is dirty we still need
    // to author so the carry commit rides into a PR.
    const plumbingShipped = await plumbingMatchesDefaultBranch(
      repo,
      cfg.authoredFiles.map((f) => ({ path: f.path, contentPreview: f.contentPreview })),
    );
    const willCarry = cfg.carryUncommittedChanges !== undefined;
    if (plumbingShipped && !willCarry && !existing) {
      this.emit(ctx, 'progress', {
        phase: 'pr.already_shipped',
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        default_branch: repo.defaultBranch,
        note: `Plumbing files already match origin/${repo.defaultBranch}. A prior PR (or a hand-merge) shipped them. Skipping author.`,
      });
      const result = {
        pr_url: null,
        pr_number: null,
        branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'already_on_default' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    // Pre-PR gate: before any git mutation, show the operator what rehearsal
    // produced + the authored file set, and wait for approval to open (or
    // reuse) the PR. This is the "rehearsal must pass AND operator must
    // confirm before PR opens" gate.
    const authoredForApproval = cfg.authoredFiles.map((f) => ({
      path: f.path,
      lines: f.contentPreview.split(/\r?\n/).length,
      summary: f.summary ?? '',
      contentPreview: f.contentPreview,
    }));

    // The carry block is the operator's uncommitted fix that Convoy will
    // commit onto its branch BEFORE writing plumbing. We surface the file
    // list + the planned commit subject in the approval card so the
    // operator sees the combined picture (their fix + Convoy's plumbing)
    // before clicking approve. They can reject if the dirty list looks
    // wrong (stray editor file, accidentally-staged secret, etc.) and
    // clean it up before the next resume.
    const carryForApproval = cfg.carryUncommittedChanges
      ? {
          files: cfg.carryUncommittedChanges.files,
          file_count: cfg.carryUncommittedChanges.files.length,
          commit_subject: cfg.carryUncommittedChanges.messageDefault,
          note:
            'These uncommitted files will be committed to the convoy branch as a separate `fix:` commit before Convoy writes its plumbing. Main stays untouched until you approve the merge.',
        }
      : undefined;

    const baseNote = existing?.state === 'open'
      ? `Rehearsal passed. A PR for this plan is already open at ${existing.prUrl}; Convoy will force-push the latest authored files to its branch and reuse it.`
      : 'Rehearsal passed. Convoy will open a PR with these deployment-surface files only — no application source is touched.';
    const carryNote = carryForApproval
      ? ` In addition, Convoy is carrying ${carryForApproval.file_count} operator-authored file${carryForApproval.file_count === 1 ? '' : 's'} from your working tree as a separate \`fix:\` commit on the same branch — no push to ${repo.defaultBranch} is needed for those changes to deploy.`
      : '';

    await this.awaitApproval(ctx, 'open_pr', {
      mode: 'real',
      repo: `${repo.owner}/${repo.repo}`,
      default_branch: repo.defaultBranch,
      branch_to_create: branch,
      reuse_pr_url: existing?.state === 'open' ? existing.prUrl : undefined,
      note: `${baseNote}${carryNote}`,
      rehearsal: summarizeRehearsalForApproval(ctx.prior['rehearse']),
      files: authoredForApproval,
      carry: carryForApproval,
    });

    let pr;
    try {
      pr = await createPrFromAuthoredFiles(
        repo,
        branch,
        cfg.authoredFiles.map((f) => ({ path: f.path, contentPreview: f.contentPreview })),
        cfg.prTitle,
        cfg.prBody,
        existing?.state === 'open' ? existing.prUrl : undefined,
        cfg.carryUncommittedChanges
          ? {
              files: cfg.carryUncommittedChanges.files,
              message: cfg.carryUncommittedChanges.messageDefault,
            }
          : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PR creation failed: ${message}`);
    }

    // No-op signal from createPrFromAuthoredFiles: plumbing already matched
    // origin/<default> AND the carry's diff was empty (or no carry was
    // instructed). Possible if the operator's "dirty tree" was entirely
    // gitignored content (.vscode/, .env*.local, etc.), or if the
    // plumbingMatchesDefaultBranch pre-check missed the case for any
    // reason. Either way: nothing to push, nothing to PR, stage is a no-op.
    if (pr.noOp) {
      this.emit(ctx, 'progress', {
        phase: 'pr.no_op',
        branch: pr.branch,
        files: cfg.authoredFiles.map((f) => f.path),
        note:
          'Plumbing already on origin/<default> and no operator changes had a non-empty diff. Skipping PR; advancing to deploy.',
      });
      const result = {
        pr_url: null,
        pr_number: null,
        branch: pr.branch,
        files: cfg.authoredFiles.map((f) => f.path),
        merged: true,
        reused: 'no_op' as const,
      };
      this.emit(ctx, 'finished', result);
      return result;
    }

    if (cfg.carryUncommittedChanges) {
      this.emit(ctx, 'progress', {
        phase: 'pr.carry_committed',
        files: cfg.carryUncommittedChanges.files,
        commit_subject: cfg.carryUncommittedChanges.messageDefault,
        note: 'operator-authored fix committed to convoy branch alongside the deploy plumbing',
      });
    }

    this.emit(ctx, 'progress', {
      phase: 'pr.opened',
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
    });

    await this.awaitApproval(ctx, 'merge_pr', {
      mode: 'real',
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      note: 'Only Convoy-authored deployment files were committed. Source code is untouched. Review on GitHub and approve to merge.',
      // Full file shape so the approval card can render the same content
      // preview the plan page shows. Operator should never approve blind.
      files: authoredForApproval,
    });

    if (cfg.mergeOnApproval) {
      this.emit(ctx, 'progress', { phase: 'pr.merging' });
      const merge = await mergePr(pr.prUrl, { method: cfg.mergeMethod ?? 'squash' });
      if (!merge.ok) {
        throw new Error(`PR merge failed: ${merge.error ?? 'unknown'}`);
      }
      this.emit(ctx, 'progress', { phase: 'pr.merged' });
    } else {
      // User opted out of auto-merge — poll indefinitely until someone merges
      // or closes the PR. No timeout; they drive on their own schedule.
      while (true) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const status = await prStatus(pr.prUrl);
        if (status === 'merged') break;
        if (status === 'closed') throw new Error('PR was closed without merging');
        await this.sleep(5000);
      }
    }

    const result = {
      pr_url: pr.prUrl,
      pr_number: pr.prNumber,
      branch: pr.branch,
      files: cfg.authoredFiles.map((f) => f.path),
      merged: true,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }
}

export class RehearseStage extends BaseStage {
  readonly name = 'rehearse' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realRehearsal) {
      return this.#runReal(ctx, ctx.opts.realRehearsal);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });
    this.emit(ctx, 'progress', { phase: 'ephemeral.creating', mode: 'scripted' });
    await this.sleep(1200, ctx.signal);

    // Scripted rehearsal does not spin up a real ephemeral service, so there
    // is no URL to advertise. Previously we emitted
    // https://convoy-rehearsal-<hash>.fly.dev which never existed.
    this.emit(ctx, 'progress', { phase: 'ephemeral.ready', mode: 'scripted' });
    await this.sleep(400, ctx.signal);

    this.emit(ctx, 'progress', { phase: 'smoke_tests.passed', count: 8 });
    await this.sleep(500, ctx.signal);

    const inject = ctx.opts.injectFailure;
    if (inject && inject.stage === 'rehearse') {
      this.emit(ctx, 'progress', {
        phase: 'synthetic_load.breach',
        p99_ms: 494,
        error_rate_pct: 6.67,
        threshold_error_rate_pct: 1.0,
      });
      await this.sleep(300, ctx.signal);

      const logs = await loadInjectedLogs(inject);

      this.emit(ctx, 'progress', { phase: 'medic.invoked' });

      const diagnosis = await diagnose({
        stage: 'rehearse',
        phase: 'synthetic_load',
        repoPath: inject.repoPath ?? '.',
        convoyAuthoredFiles: inject.convoyAuthoredFiles ?? [],
        logs,
        metrics: { p99_ms: 494, p95_ms: 410, error_rate_pct: 6.67, count: 90 },
        errorMessage: 'synthetic load breached error-rate tolerance (6.67% > 1%)',
      }, this.medicTelemetry(ctx));

      this.emit(ctx, 'diagnosis', diagnosis);
      this.emit(ctx, 'progress', { phase: 'ephemeral.destroying' });
      await this.sleep(300, ctx.signal);

      throw new RehearsalBreachError(diagnosis);
    }

    this.emit(ctx, 'progress', { phase: 'synthetic_load.passed', p99_ms: 142 });
    await this.sleep(400, ctx.signal);

    this.emit(ctx, 'progress', { phase: 'ephemeral.destroying' });
    await this.sleep(300, ctx.signal);

    const result = {
      mode: 'scripted' as const,
      healthy: true,
      p99_ms: 142,
      smoke_tests_passed: 8,
      new_error_fingerprints: 0,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runReal(ctx: StageContext, cfg: RealRehearsalOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-local', target: cfg.repoPath });

    const runner = new RehearsalRunner(
      {
        installCwd: cfg.repoPath,
        serviceCwd: cfg.serviceCwd ?? cfg.repoPath,
        startCommand: cfg.startCommand,
        port: cfg.port,
        healthPath: cfg.healthPath,
        inheritAmbientEnv: cfg.inheritAmbientEnv === true,
        ...(cfg.installCommand !== undefined && { installCommand: cfg.installCommand }),
        ...(cfg.buildCommand !== undefined && { buildCommand: cfg.buildCommand }),
        ...(cfg.metricsPath !== undefined && { metricsPath: cfg.metricsPath }),
        ...(cfg.env !== undefined && { env: cfg.env }),
      },
      {
        maxErrorRatePct: cfg.maxErrorRatePct ?? 1.0,
        maxP99Ms: cfg.maxP99Ms ?? 500,
      },
      (phase, payload) => {
        this.emit(ctx, 'progress', { phase, ...(payload ?? {}) });
      },
    );

    const rehearsal = await runner.run(
      {
        requests: cfg.probeRequests ?? 60,
        concurrency: cfg.probeConcurrency ?? 4,
        paths: cfg.probePaths ?? [cfg.healthPath],
        timeoutMs: 5000,
      },
      ctx.signal,
    );

    if (!rehearsal.ok) {
      this.emit(ctx, 'progress', { phase: 'medic.invoked' });
      const diagnosis = await diagnose({
        stage: 'rehearse',
        phase: 'real_local',
        repoPath: cfg.repoPath,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: rehearsal.logs,
        metrics: {
          ...(rehearsal.metricsAfter ?? rehearsal.metricsBefore ?? {}) as Record<string, unknown>,
        },
        errorMessage: rehearsal.reason ?? 'rehearsal failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new RehearsalBreachError(diagnosis);
    }

    const result = {
      healthy: true,
      duration_ms: rehearsal.durationMs,
      metricsBefore: rehearsal.metricsBefore,
      metricsAfter: rehearsal.metricsAfter,
      log_lines: rehearsal.logs.length,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }
}

export class RehearsalBreachError extends Error {
  constructor(public readonly diagnosis: unknown) {
    super('rehearsal breached tolerance — medic produced a diagnosis');
    this.name = 'RehearsalBreachError';
  }
}

async function loadInjectedLogs(inject: InjectFailureOpt): Promise<string[]> {
  if (!inject.logsPath) return defaultBuggyLogs();
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(inject.logsPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return defaultBuggyLogs();
  }
}

function defaultBuggyLogs(): string[] {
  const now = new Date().toISOString();
  return [
    `{"ts":"${now}","level":"info","message":"server_started","port":8080,"mode":"production"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":1,"pageSize":20,"latency_ms":14}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":2,"pageSize":20,"latency_ms":12}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":3,"pageSize":20,"latency_ms":15}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":474,"endpoint":"/orders","page":1,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":4,"pageSize":20,"latency_ms":13}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":5,"pageSize":20,"latency_ms":18}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":492,"endpoint":"/orders","page":2,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
    `{"ts":"${now}","level":"info","message":"orders_served","count":20,"page":6,"pageSize":20,"latency_ms":14}`,
    `{"ts":"${now}","level":"error","message":"orders_query_timeout","latency_ms":461,"endpoint":"/orders","page":3,"pageSize":20,"note":"downstream orders-db call exceeded deadline"}`,
  ];
}

export class CanaryStage extends BaseStage {
  readonly name = 'canary' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    // Secrets gate — fires only when we're about to do a real platform
    // deploy. Computes expected vs staged keys; if any required keys are
    // missing AND the operator hasn't self-declared them, request a
    // stage_secrets approval and pause. The approval form (web UI) lets
    // the operator paste values inline; the server action writes them to
    // .env.convoy-secrets AND pushes them to the platform via the
    // platform CLI, so the deploy that follows actually has them.
    //
    // No probing of platform state — operator's declarations (file or
    // --already-set) are trusted as the source of truth. Verification
    // can be added later as a separate gate.
    const isRealDeploy = Boolean(ctx.opts.realFly || ctx.opts.realVercel);
    if (isRealDeploy && ctx.opts.plan) {
      await this.#secretsGate(ctx, ctx.opts.plan);
    }

    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel);
    }

    this.emit(ctx, 'started', {});

    await this.awaitApproval(ctx, 'promote', {
      note: 'Rehearsal clean. Promote to canary at 5% traffic?',
      bake_window_seconds: 120,
    });

    this.emit(ctx, 'progress', { traffic_split_percent: 5 });
    await this.sleep(1200, ctx.signal);

    this.emit(ctx, 'progress', {
      baseline_comparison: { p99_delta_ms: 3, error_rate_delta_pct: 0.0 },
    });
    await this.sleep(400, ctx.signal);

    const result = {
      healthy: true,
      traffic_split_percent: 5,
      p99_delta_ms: 3,
      error_rate_delta_pct: 0.0,
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-fly', app: cfg.appName, strategy: cfg.strategy ?? 'canary' });

    const available = await flyctlAvailable();
    if (!available) {
      throw new Error(
        'flyctl is not installed. Install it first: `curl -L https://fly.io/install.sh | sh`',
      );
    }
    const auth = await flyAuthStatus();
    if (!auth.ok) {
      throw new Error(`flyctl not authenticated: ${auth.error ?? 'unknown'}. Run: fly auth login`);
    }
    this.emit(ctx, 'progress', { phase: 'fly.authenticated', user: auth.user });

    const exists = await flyAppExists(cfg.appName);
    if (!exists) {
      if (!cfg.createIfMissing) {
        throw new Error(
          `Fly app "${cfg.appName}" does not exist. Create it first (fly apps create ${cfg.appName}) or pass --fly-create-app.`,
        );
      }
      this.emit(ctx, 'progress', { phase: 'fly.creating', app: cfg.appName, org: cfg.org ?? 'personal' });
      await flyCreateApp(cfg.appName, cfg.org);
      this.emit(ctx, 'progress', { phase: 'fly.created' });
    }

    if (cfg.secrets && Object.keys(cfg.secrets).length > 0) {
      this.emit(ctx, 'progress', { phase: 'secrets.staging', count: Object.keys(cfg.secrets).length });
      await flySetSecrets(cfg.appName, cfg.secrets);
      this.emit(ctx, 'progress', { phase: 'secrets.staged' });
    }

    await this.awaitApproval(ctx, 'promote', {
      app: cfg.appName,
      strategy: cfg.strategy ?? 'canary',
      note: `Rehearsal clean. Deploy to Fly app "${cfg.appName}" using ${cfg.strategy ?? 'canary'} strategy?`,
    });

    const preReleases = await flyListReleases(cfg.appName);
    const previousVersion = preReleases[0]?.version;
    if (previousVersion !== undefined) {
      this.emit(ctx, 'progress', { phase: 'rollback.prestaged', previous_version: previousVersion });
    }

    this.emit(ctx, 'progress', { phase: 'fly.deploying', strategy: cfg.strategy ?? 'canary' });

    const deployResult = await flyDeploy(cfg.appName, cfg.cwd, {
      strategy: cfg.strategy ?? 'canary',
      remoteOnly: true,
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!deployResult.ok) {
      this.emit(ctx, 'progress', { phase: 'fly.deploy_failed', error: deployResult.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'fly_deploy',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: deployResult.logs,
        errorMessage: deployResult.error ?? 'fly deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Fly deploy failed: ${deployResult.error}`);
    }

    const hostname = deployResult.hostname ?? `${cfg.appName}.fly.dev`;
    this.emit(ctx, 'progress', { phase: 'fly.deployed', hostname });

    const result = {
      healthy: true,
      strategy: cfg.strategy ?? 'canary',
      hostname,
      app: cfg.appName,
      ...(previousVersion !== undefined && { previous_version: previousVersion }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealVercel(ctx: StageContext, cfg: RealVercelOpt): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vercel', cwd: cfg.cwd });

    await this.awaitApproval(ctx, 'promote', {
      note: 'Convoy-authored PR merged. Deploy to Vercel as a preview?',
      cwd: cfg.cwd,
    });

    // Capture prior prod for rollback.
    const priorDeployments = await vercelListDeployments(cfg.cwd, 20);
    const previousProd = priorDeployments.find((d) => d.target === 'production' && d.state === 'READY');
    if (previousProd) {
      this.emit(ctx, 'progress', {
        phase: 'rollback.prestaged',
        previous_production_url: previousProd.url,
      });
    }

    this.emit(ctx, 'progress', { phase: 'vercel.deploying_preview' });

    const preview = await vercelDeploy({
      cwd: cfg.cwd,
      target: 'preview',
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!preview.ok) {
      this.emit(ctx, 'progress', { phase: 'vercel.preview_failed', error: preview.error });
      const diagnosis = await diagnose({
        stage: 'canary',
        phase: 'vercel_preview',
        repoPath: cfg.cwd,
        convoyAuthoredFiles: cfg.convoyAuthoredFiles ?? [],
        logs: preview.logs,
        errorMessage: preview.error ?? 'vercel preview deploy failed',
      }, this.medicTelemetry(ctx));
      this.emit(ctx, 'diagnosis', diagnosis);
      throw new Error(`Vercel preview deploy failed: ${preview.error}`);
    }

    const previewUrl = preview.url!;
    this.emit(ctx, 'progress', { phase: 'vercel.preview_ready', preview_url: previewUrl });

    const result = {
      healthy: true,
      preview_url: previewUrl,
      ...(previousProd?.url && { previous_production_url: previousProd.url }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  /**
   * Secrets gate. Computes which required keys aren't yet staged and
   * requests a stage_secrets approval if any are missing. The approval's
   * summary carries the missing-key list + the platform context (so the
   * web UI's paste form knows what to render and which platform CLI to
   * push to). Ambient operator decisions:
   *   - file: <repo>/.env.convoy-secrets (KEY=VALUE)
   *   - file: <repo>/.env.convoy-already-set (KEY= names)
   *   - flag: --already-set=K1,K2 (passed via opts.alreadySetKeys)
   *
   * No platform probing — `--already-set` claims are still trusted on
   * faith here. Verification is a separate v2 gate.
   */
  async #secretsGate(ctx: StageContext, plan: ConvoyPlan): Promise<void> {
    const { keys: expected, sources } = computeExpectedKeysFromPlan(plan);
    if (expected.size === 0) return;

    const targetCwd = plan.target.workspace
      ? `${plan.target.localPath}/${plan.target.workspace}`
      : plan.target.localPath;
    const secretsPath = `${plan.target.localPath}/.env.convoy-secrets`;
    const alreadyPath = `${plan.target.localPath}/.env.convoy-already-set`;

    const fileSecrets = readEnvKeyOnly(secretsPath);
    const fileAlready = readEnvKeyOnly(alreadyPath);
    const cliAlready = ctx.opts.alreadySetKeys ?? [];

    const staged = new Set<string>([...fileSecrets, ...fileAlready, ...cliAlready]);
    const missing = [...expected].filter((k) => !staged.has(k));

    // Filter platform-managed keys we never expect operators to stage.
    const filtered = missing.filter((k) => !isPlatformManagedKey(k, plan.platform.chosen));

    if (filtered.length === 0) {
      this.emit(ctx, 'progress', {
        phase: 'secrets.staged',
        sources,
        expected_count: expected.size,
        staged_count: expected.size - missing.length,
      });
      return;
    }

    const platform = plan.platform.chosen;
    const flyAppName = platform === 'fly'
      ? (ctx.opts.realFly?.appName ?? null)
      : null;

    this.emit(ctx, 'progress', {
      phase: 'secrets.gate',
      missing: filtered,
      sources,
      platform,
      note: 'pausing for stage_secrets approval — paste values in the UI or self-declare and Convoy will push to the platform before the deploy command runs',
    });

    await this.awaitApproval(ctx, 'stage_secrets', {
      mode: 'real',
      missing: filtered.map((key) => ({
        key,
        severity: classifySecretSeverity(key),
        purpose: secretPurposeHint(key),
      })),
      sources,
      platform,
      plan_id: plan.id,
      fly_app: flyAppName,
      target_cwd: targetCwd,
      secrets_path: secretsPath,
      already_set_path: alreadyPath,
      note:
        'These required env vars aren\'t staged yet. Paste each value below to push it to the platform now, mark it as already set if you set it elsewhere, or skip with explicit acknowledgment.',
    });

    this.emit(ctx, 'progress', { phase: 'secrets.gate.cleared', missing: filtered });
  }
}

/**
 * Per-key severity classifier — drives the visual weight in the stage_secrets
 * approval card. DB / credential / token keys read as critical (the deploy
 * provably can't function without them); everything else is "standard."
 *
 * Pattern-based and intentionally heuristic — false negatives just downgrade
 * a key to "standard" (still surfaced, just less alarming). False positives
 * upgrade harmless keys to "critical" (operator notices, no harm done).
 */
function classifySecretSeverity(key: string): 'critical' | 'standard' {
  const k = key.toUpperCase();
  if (/(DATABASE|POSTGRES|MONGODB|REDIS|MYSQL|SQL)_?URL$/.test(k)) return 'critical';
  if (/_DATABASE_URL$|^PRISMA_DATABASE_URL$/.test(k)) return 'critical';
  if (/_CONNECTION_STRING$|_CONNECTION_URI$/.test(k)) return 'critical';
  if (/(API_KEY|SECRET|TOKEN|PRIVATE_KEY|CLIENT_SECRET)$/.test(k)) return 'critical';
  if (/^(STRIPE_|CLERK_SECRET|JWT_SECRET|AUTH_SECRET|NEXTAUTH_SECRET)/.test(k)) return 'critical';
  return 'standard';
}

/**
 * Hint string surfaced under the key name in the approval card so the
 * operator sees what the value is *for* without having to grep their schema.
 * Heuristic again — when no pattern matches we just say "required by .env.schema".
 */
function secretPurposeHint(key: string): string {
  const k = key.toUpperCase();
  if (/(DATABASE|POSTGRES|MYSQL|SQL)_?URL$/.test(k)) return 'database connection string';
  if (/MONGODB_?URL$/.test(k)) return 'MongoDB connection string';
  if (/REDIS_?URL$/.test(k)) return 'Redis connection string';
  if (/_API_KEY$/.test(k)) return 'API key';
  if (/_SECRET$|^.*_SECRET$/.test(k)) return 'secret';
  if (/_TOKEN$/.test(k)) return 'token';
  if (/^STRIPE_/.test(k)) return 'Stripe credential';
  if (/^CLERK_/.test(k)) return 'Clerk auth credential';
  if (/^NEXT_PUBLIC_/.test(k)) return 'public env var (shipped to client bundle)';
  return 'required by .env.schema';
}

/**
 * Filter out keys the platform itself sets at runtime — operators shouldn't
 * have to stage these and Convoy shouldn't pause for them.
 */
function isPlatformManagedKey(key: string, platform: Platform): boolean {
  if (platform === 'vercel') {
    return key.startsWith('VERCEL_') || key.startsWith('NEXT_PUBLIC_VERCEL_');
  }
  if (platform === 'fly') {
    return key.startsWith('FLY_') || key === 'PORT';
  }
  if (platform === 'cloudrun') {
    return key === 'PORT' || key === 'K_SERVICE' || key === 'K_REVISION' || key === 'K_CONFIGURATION';
  }
  return false;
}

/**
 * Plan-only computation of expected keys — duplicated from cli.ts's
 * computeExpectedKeys to keep stages.ts self-contained (the cli version
 * is imported from cli.ts, which would create a circular dep). Reads
 * .env.schema from the plan's authoredFiles + the target's .env.example.
 */
function computeExpectedKeysFromPlan(plan: ConvoyPlan): {
  keys: Set<string>;
  sources: string[];
} {
  const keys = new Set<string>();
  const sources: string[] = [];

  const schema = plan.author.convoyAuthoredFiles.find((f) => f.path === '.env.schema');
  if (schema) {
    const k = extractEnvKeysFromText(schema.contentPreview);
    k.forEach((key) => keys.add(key));
    if (k.length > 0) sources.push(`.env.schema (${k.length})`);
  }

  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const targetCwd = plan.target.workspace
    ? path.resolve(plan.target.localPath, plan.target.workspace)
    : plan.target.localPath;
  for (const cand of ['.env.example', '.env.local.example']) {
    const candidates = [path.resolve(targetCwd, cand), path.resolve(plan.target.localPath, cand)];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const k = extractEnvKeysFromText(fs.readFileSync(p, 'utf8'));
          k.forEach((key) => keys.add(key));
          if (k.length > 0) sources.push(`${cand} (${k.length})`);
          break;
        } catch {
          // unreadable, skip
        }
      }
    }
  }

  return { keys, sources };
}

function extractEnvKeysFromText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) out.push(key);
  }
  return out;
}

function readEnvKeyOnly(filePath: string): string[] {
  const fs = require('node:fs') as typeof import('node:fs');
  if (!fs.existsSync(filePath)) return [];
  try {
    return extractEnvKeysFromText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

export class PromoteStage extends BaseStage {
  readonly name = 'promote' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel, ctx.prior['canary'] as Record<string, unknown> | undefined);
    }

    this.emit(ctx, 'started', { mode: 'scripted' });

    for (const pct of [10, 25, 50, 100]) {
      this.emit(ctx, 'progress', { traffic_split_percent: pct });
      await this.sleep(450, ctx.signal);
    }

    // No fake live URL in scripted mode. Before this change the demo path
    // emitted https://convoy-demo-<hash>.fly.dev which never resolved — the
    // CLI printed it green, the web UI linked to it, both lied. Scripted
    // runs end without a live URL; only real deploys populate run.liveUrl.
    const result = { mode: 'scripted' as const, release: 'v1', note: 'scripted pipeline — no deployment' };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    // Fly's canary strategy already rolled out to all machines inside the
    // CanaryStage. PromoteStage just verifies the live hostname for a short
    // window — this is the earliest moment we can say users are served the
    // new image.
    this.emit(ctx, 'started', { mode: 'real-fly', phase: 'verify-live' });

    const hostname = `${cfg.appName}.fly.dev`;
    const healthPath = cfg.healthPath ?? '/health';
    const verifyWindowMs = 20_000;
    const probeTimeoutMs = 5_000;
    const deadline = Date.now() + verifyWindowMs;
    const latencies: number[] = [];
    let consecutive = 0;
    let lastFailure: { status?: number; error?: string } | null = null;
    while (Date.now() < deadline && consecutive < 3) {
      const h = await flyHealthCheck(hostname, healthPath, probeTimeoutMs);
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);
      this.emit(ctx, 'progress', {
        phase: 'fly.health_probe',
        status: h.status ?? 0,
        latency_ms: h.latencyMs,
        ok: h.ok,
      });
      if (h.ok) {
        consecutive += 1;
      } else {
        consecutive = 0;
        lastFailure = { ...(h.status !== undefined && { status: h.status }), ...(h.error !== undefined && { error: h.error }) };
      }
      await this.sleep(1500, ctx.signal);
    }

    if (consecutive < 3) {
      const reason = lastFailure
        ? `${healthPath} did not pass (last probe: status=${lastFailure.status ?? 0}${lastFailure.error ? `, error=${lastFailure.error}` : ''})`
        : `${healthPath} did not return 200 three times in a row within ${verifyWindowMs}ms`;
      return triggerRealFlyRollback(ctx, cfg, reason, 'promote');
    }

    const liveUrl = `https://${hostname}`;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const releases = await flyListReleases(cfg.appName);
    const currentVersion = releases[0]?.version;

    const result = {
      live_url: liveUrl,
      hostname,
      p99_ms: percentile(latencies, 0.99),
      ...(currentVersion !== undefined && { release_version: currentVersion }),
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #runRealVercel(
    ctx: StageContext,
    cfg: RealVercelOpt,
    canaryResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    this.emit(ctx, 'started', { mode: 'real-vercel', phase: 'promote-to-prod' });

    // Verify the preview deployment is healthy before promoting.
    const previewUrl = typeof canaryResult?.['preview_url'] === 'string' ? canaryResult['preview_url'] : null;
    const healthPath = cfg.healthPath ?? '/';
    if (previewUrl) {
      const probe = await vercelHealthCheck(previewUrl, healthPath);
      this.emit(ctx, 'progress', {
        phase: 'preview.probe',
        url: previewUrl,
        status: probe.status ?? 0,
        latency_ms: probe.latencyMs,
        ok: probe.ok,
      });
      if (!probe.ok) {
        throw new Error(
          `preview at ${previewUrl}${healthPath} did not respond 200 (status=${probe.status ?? 0}, error=${probe.error ?? 'n/a'})`,
        );
      }
    }

    this.emit(ctx, 'progress', { phase: 'vercel.deploying_production' });

    const prod = await vercelDeploy({
      cwd: cfg.cwd,
      target: 'production',
      onLog: (line) => {
        if (/error|failed|panic/i.test(line)) {
          this.emit(ctx, 'log', { line });
        }
      },
    });

    if (!prod.ok) {
      throw new Error(`Vercel production deploy failed: ${prod.error}`);
    }

    const liveUrl = prod.url!;
    ctx.store.updateRun(ctx.run.id, { liveUrl });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });

    const result = {
      live_url: liveUrl,
      ...(prod.deploymentId && { deployment_id: prod.deploymentId }),
    };
    this.emit(ctx, 'finished', result);
    return result;
  }
}

/**
 * Shared rollback helper invoked by promote and observe stages when they
 * detect a breach. Emits phases, calls flyRollback, updates run status to
 * rolled_back, and throws so the orchestrator records a clean failure.
 */
async function triggerRealFlyRollback(
  ctx: StageContext,
  cfg: RealFlyOpt,
  reason: string,
  firedBy: 'promote' | 'observe',
): Promise<never> {
  const emit = (kind: EventKind, payload: unknown): void => {
    const event = ctx.store.appendEvent(ctx.run.id, firedBy, kind, payload);
    ctx.bus.emit({ type: 'event.appended', event });
  };
  emit('progress', { phase: 'rollback.starting', reason });
  const result = await flyRollback(cfg.appName);
  if (!result.ok) {
    emit('progress', { phase: 'rollback.failed', error: result.error });
    ctx.store.updateRun(ctx.run.id, {
      outcomeReason: `${reason}; rollback failed: ${result.error}`,
      completedAt: new Date(),
    });
    throw new Error(`${firedBy} breach AND rollback failed: ${result.error}`);
  }
  emit('progress', {
    phase: 'rollback.done',
    restored_version: result.restoredVersion,
  });
  ctx.store.updateRun(ctx.run.id, {
    status: 'rolled_back',
    completedAt: new Date(),
    outcomeReason: reason,
    outcomeRestoredVersion: result.restoredVersion ?? null,
  });
  const updated = ctx.store.getRun(ctx.run.id);
  if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
  throw new RollbackTriggeredError(reason, firedBy, result.restoredVersion);
}

export class ObserveStage extends BaseStage {
  readonly name = 'observe' as const;

  override async run(ctx: StageContext): Promise<unknown> {
    if (ctx.opts.realFly) {
      return this.#runRealFly(ctx, ctx.opts.realFly);
    }
    if (ctx.opts.realVercel) {
      return this.#runRealVercel(ctx, ctx.opts.realVercel, ctx.prior['promote'] as Record<string, unknown> | undefined);
    }

    this.emit(ctx, 'started', { bake_window_seconds: 2 });
    await this.sleep(2000, ctx.signal);

    const result = {
      window_seconds: 2,
      slo_healthy: true,
      observations: { p99_ms: 138, error_rate_pct: 0.0 },
    };
    this.emit(ctx, 'finished', result);
    return result;
  }

  async #runRealFly(ctx: StageContext, cfg: RealFlyOpt): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const hostname = `${cfg.appName}.fly.dev`;
    const healthPath = cfg.healthPath ?? '/health';
    const thresholdErrorRatePct = cfg.thresholdErrorRatePct ?? 1.0;
    const thresholdP99Ms = cfg.thresholdP99Ms ?? 1000;

    const probeEveryMs = 2000;
    const deadline = Date.now() + window * 1000;
    let probeCount = 0;
    let errors = 0;
    const latencies: number[] = [];
    let lastEmittedOk: boolean | null = null;
    let lastEmittedAt = 0;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const h = await flyHealthCheck(hostname, healthPath);
      probeCount += 1;
      if (!h.ok) errors += 1;
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);

      const errorRatePct = (errors / probeCount) * 100;
      const p99 = percentile(latencies, 0.99);

      // Throttle: emit on first probe, on ok-state change, every 5 probes, or
      // when a threshold is crossed. Keeps the timeline readable on long
      // bake windows without losing signal.
      const stateChanged = lastEmittedOk !== null && lastEmittedOk !== h.ok;
      const periodic = probeCount === 1 || probeCount % 5 === 0;
      const willBreach =
        (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) ||
        (p99 !== undefined && p99 > thresholdP99Ms);
      const shouldEmit = stateChanged || periodic || willBreach || Date.now() - lastEmittedAt > 10000;
      if (shouldEmit) {
        this.emit(ctx, 'progress', {
          phase: 'observe.probe',
          probe_count: probeCount,
          error_rate_pct: Number(errorRatePct.toFixed(2)),
          p99_ms: p99,
          ok: h.ok,
        });
        lastEmittedOk = h.ok;
        lastEmittedAt = Date.now();
      }

      if (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `error rate ${errorRatePct.toFixed(2)}% exceeded ${thresholdErrorRatePct}%`,
        });
        return this.#triggerRollback(ctx, cfg, `error rate ${errorRatePct.toFixed(2)}% > ${thresholdErrorRatePct}%`);
      }
      if (p99 !== undefined && p99 > thresholdP99Ms) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `p99 ${p99}ms exceeded ${thresholdP99Ms}ms`,
        });
        return this.#triggerRollback(ctx, cfg, `p99 ${p99}ms > ${thresholdP99Ms}ms`);
      }

      await this.sleep(probeEveryMs, ctx.signal);
    }

    const p99 = percentile(latencies, 0.99);
    const errorRatePct = probeCount === 0 ? 0 : (errors / probeCount) * 100;
    const result = {
      window_seconds: window,
      slo_healthy: true,
      probe_count: probeCount,
      error_rate_pct: Number(errorRatePct.toFixed(2)),
      p99_ms: p99,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #triggerRollback(ctx: StageContext, cfg: RealFlyOpt, reason: string): Promise<unknown> {
    return triggerRealFlyRollback(ctx, cfg, reason, 'observe');
  }

  async #runRealVercel(
    ctx: StageContext,
    cfg: RealVercelOpt,
    promoteResult: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const window = cfg.bakeWindowSeconds ?? 60;
    this.emit(ctx, 'started', { bake_window_seconds: window });

    const liveUrl = typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null;
    if (!liveUrl) {
      // Nothing to probe — skip observe window.
      const result = { window_seconds: 0, slo_healthy: false, reason: 'no live URL from promote' };
      this.emit(ctx, 'finished', result);
      return result;
    }

    const healthPath = cfg.healthPath ?? '/';
    const thresholdErrorRatePct = cfg.thresholdErrorRatePct ?? 1.0;
    const thresholdP99Ms = cfg.thresholdP99Ms ?? 2000;

    const probeEveryMs = 3000;
    const deadline = Date.now() + window * 1000;
    let probeCount = 0;
    let errors = 0;
    const latencies: number[] = [];
    let lastEmittedAt = 0;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const h = await vercelHealthCheck(liveUrl, healthPath);
      probeCount += 1;
      if (!h.ok) errors += 1;
      if (h.latencyMs !== undefined) latencies.push(h.latencyMs);

      const errorRatePct = (errors / probeCount) * 100;
      const p99 = percentile(latencies, 0.99);

      const shouldEmit = probeCount === 1 || probeCount % 5 === 0 || Date.now() - lastEmittedAt > 10000 || !h.ok;
      if (shouldEmit) {
        this.emit(ctx, 'progress', {
          phase: 'observe.probe',
          probe_count: probeCount,
          error_rate_pct: Number(errorRatePct.toFixed(2)),
          p99_ms: p99,
          ok: h.ok,
        });
        lastEmittedAt = Date.now();
      }

      if (probeCount >= 5 && errorRatePct > thresholdErrorRatePct) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `error rate ${errorRatePct.toFixed(2)}% exceeded ${thresholdErrorRatePct}%`,
        });
        return this.#triggerVercelRollback(ctx, cfg, promoteResult, `error rate ${errorRatePct.toFixed(2)}% > ${thresholdErrorRatePct}%`);
      }
      if (p99 !== undefined && p99 > thresholdP99Ms) {
        this.emit(ctx, 'progress', {
          phase: 'observe.breach',
          reason: `p99 ${p99}ms exceeded ${thresholdP99Ms}ms`,
        });
        return this.#triggerVercelRollback(ctx, cfg, promoteResult, `p99 ${p99}ms > ${thresholdP99Ms}ms`);
      }

      await this.sleep(probeEveryMs, ctx.signal);
    }

    const p99 = percentile(latencies, 0.99);
    const errorRatePct = probeCount === 0 ? 0 : (errors / probeCount) * 100;
    const result = {
      window_seconds: window,
      slo_healthy: true,
      probe_count: probeCount,
      error_rate_pct: Number(errorRatePct.toFixed(2)),
      p99_ms: p99,
    };
    this.emit(ctx, 'finished', result as unknown as Record<string, unknown>);
    return result;
  }

  async #triggerVercelRollback(
    ctx: StageContext,
    cfg: RealVercelOpt,
    promoteResult: Record<string, unknown> | undefined,
    reason: string,
  ): Promise<unknown> {
    this.emit(ctx, 'progress', { phase: 'rollback.starting', reason });

    // For Vercel, "rollback" = alias the prod hostname back to a prior prod
    // deployment. We look up prior prod deployments and pick the most recent
    // stable one that isn't what we just shipped.
    const currentLive = typeof promoteResult?.['live_url'] === 'string' ? promoteResult['live_url'] : null;
    const deployments = await vercelListDeployments(cfg.cwd, 20);
    const priorProd = deployments.find((d) => d.target === 'production' && d.state === 'READY' && d.url !== currentLive);
    if (!priorProd) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: 'no prior production deployment to roll back to' });
      ctx.store.updateRun(ctx.run.id, {
        outcomeReason: `${reason}; rollback failed: no prior production deployment`,
        completedAt: new Date(),
      });
      throw new Error(`observe breach AND rollback failed: no prior production deployment`);
    }

    // Derive production alias from the current live URL's hostname (best effort).
    const prodAlias = currentLive ? currentLive.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    if (!prodAlias) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: 'could not determine production alias' });
      throw new Error('rollback: could not determine production alias from live URL');
    }

    const result = await vercelRollback(cfg.cwd, prodAlias, priorProd.url);
    if (!result.ok) {
      this.emit(ctx, 'progress', { phase: 'rollback.failed', error: result.error });
      ctx.store.updateRun(ctx.run.id, {
        outcomeReason: `${reason}; rollback failed: ${result.error}`,
        completedAt: new Date(),
      });
      throw new Error(`observe breach AND rollback failed: ${result.error}`);
    }
    this.emit(ctx, 'progress', {
      phase: 'rollback.done',
      restored_deployment: priorProd.url,
    });
    ctx.store.updateRun(ctx.run.id, {
      status: 'rolled_back',
      completedAt: new Date(),
      outcomeReason: reason,
    });
    const updated = ctx.store.getRun(ctx.run.id);
    if (updated) ctx.bus.emit({ type: 'run.updated', run: updated });
    throw new RollbackTriggeredError(reason, 'observe');
  }
}

function percentile(latencies: number[], q: number): number | undefined {
  if (latencies.length === 0) return undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

export function defaultStages(): Stage[] {
  // Order matters: rehearse runs BEFORE author so no PR is opened and no
  // repo state is mutated until Convoy has proof the service boots and
  // responds healthy. The operator approves opening the PR with rehearsal
  // evidence on-screen, then approves merging the PR after reviewing it on
  // GitHub. Previously author ran first and could merge before rehearsal,
  // which meant a rehearsal failure could leave the repo in a merged-but-
  // undeployed state.
  return [
    new ScanStage(),
    new PickStage(),
    new RehearseStage(),
    new AuthorStage(),
    new CanaryStage(),
    new PromoteStage(),
    new ObserveStage(),
  ];
}
