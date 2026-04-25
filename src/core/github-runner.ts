import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface GitRepoContext {
  path: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  remoteUrl: string;
}

export interface AuthoredFileInput {
  path: string;
  contentPreview: string;
}

export interface PrResult {
  branch: string;
  prUrl: string;
  prNumber: number;
  /**
   * Set when neither the carry commit nor the plumbing commit had content
   * to commit (because both already match origin/<default>). The caller
   * sees this and decides whether to skip the stage entirely; PrResult
   * still includes branch/prUrl/prNumber as null-ish placeholders so the
   * caller doesn't have to special-case the type.
   */
  noOp?: boolean;
}

export interface AuthResult {
  ok: boolean;
  user?: string;
  scopes?: string[];
  error?: string;
}

/**
 * Execute a shell command in a directory, capturing stdout/stderr. Throws on
 * non-zero exit with the combined output.
 */
function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const result = { stdout, stderr, code: code ?? -1 };
      if (code === 0 || opts.allowFailure) resolve(result);
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Walk up from `path` looking for the nearest `.git` directory, and return
 * the git root + parsed GitHub owner/repo. Returns null if the path is not a
 * git repo OR if the target path itself doesn't host a .git dir (we refuse to
 * operate on a git repo whose root is a parent of the target — too easy to
 * accidentally push someone else's tree).
 */
export async function detectRepo(targetPath: string): Promise<GitRepoContext | null> {
  const abs = resolve(targetPath);
  if (!existsSync(join(abs, '.git'))) return null;

  try {
    const remote = await sh('git', ['remote', 'get-url', 'origin'], { cwd: abs });
    const remoteUrl = remote.stdout.trim();
    const slug = parseGitHubSlug(remoteUrl);
    if (!slug) return null;

    const branch = await sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: abs,
      allowFailure: true,
    });
    let defaultBranch = branch.stdout.trim().replace('refs/remotes/origin/', '');
    if (!defaultBranch) {
      defaultBranch = 'main';
    }

    return {
      path: abs,
      owner: slug.owner,
      repo: slug.repo,
      defaultBranch,
      remoteUrl,
    };
  } catch {
    return null;
  }
}

function parseGitHubSlug(url: string): { owner: string; repo: string } | null {
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

export async function gitHubAuthStatus(): Promise<AuthResult> {
  try {
    const res = await sh('gh', ['auth', 'status', '--hostname', 'github.com'], {
      allowFailure: true,
    });
    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.code !== 0) {
      return { ok: false, error: 'gh is not authenticated' };
    }
    const userMatch = combined.match(/Logged in to github\.com account (\S+)/) ||
      combined.match(/Logged in to github\.com as (\S+)/);
    const scopesMatch = combined.match(/Token scopes:\s*(.+)/);
    const out: AuthResult = { ok: true };
    if (userMatch && userMatch[1]) out.user = userMatch[1];
    if (scopesMatch && scopesMatch[1]) {
      out.scopes = scopesMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
    }
    return out;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function hasUncommittedChanges(ctx: GitRepoContext): Promise<boolean> {
  const res = await sh('git', ['status', '--porcelain'], { cwd: ctx.path });
  return res.stdout.trim().length > 0;
}

/**
 * Convoy's stable branch name for a given plan. Plan id is stable across
 * resumes; run id is not. Keying the branch off plan id is what makes
 * AuthorStage idempotent — a resume after a merge failure pushes to the
 * same branch and reuses the same PR instead of opening a duplicate.
 */
export function planBranchName(planId: string): string {
  return `convoy/${planId.slice(0, 8)}`;
}

/**
 * Compare each authored file's planned content against the current
 * `origin/<default>` snapshot. Returns true when every file already exists
 * on the default branch with matching content — i.e. a prior Convoy run
 * (or a hand-merged PR) already shipped the plumbing.
 *
 * AuthorStage calls this AFTER findExistingConvoyPr and BEFORE the open_pr
 * approval gate. Without this check, a resumed run whose author stage
 * previously failed will branch off origin/<default>, write files
 * identical to what's already there, and crash on `git commit` with
 * "nothing to commit, working tree clean". With this check we recognize
 * the no-op and skip the stage cleanly.
 *
 * We deliberately don't probe gh's API for this — `git show <ref>:<path>`
 * is local, fast, and authoritative since `git fetch origin <default>`
 * runs as part of the author flow anyway. We refresh origin first to make
 * sure we're comparing against the latest default branch.
 */
export async function plumbingMatchesDefaultBranch(
  ctx: GitRepoContext,
  files: AuthoredFileInput[],
): Promise<boolean> {
  if (files.length === 0) return true;
  // Refresh the operator's view of origin/<default> so we don't false-
  // negative on a stale remote-tracking branch.
  await sh('git', ['fetch', 'origin', ctx.defaultBranch], { cwd: ctx.path, allowFailure: true });
  for (const file of files) {
    const ref = `origin/${ctx.defaultBranch}:${file.path}`;
    const result = await sh('git', ['show', ref], { cwd: ctx.path, allowFailure: true });
    if (result.code !== 0) return false; // file missing on default
    if (result.stdout !== file.contentPreview) return false; // content differs
  }
  return true;
}

/**
 * Probe GitHub for an existing convoy/* PR. Returns the open PR if one
 * exists for `branch`, the most-recently-merged PR if one was already
 * shipped, or null otherwise. AuthorStage uses this before authoring so
 * resume after a merge failure can:
 *   - reuse the open PR (force-push new content to its branch)
 *   - skip the stage entirely if a prior PR already merged
 *   - fall back to creating a new PR if none exists
 */
export async function findExistingConvoyPr(
  ctx: GitRepoContext,
  branch: string,
): Promise<{ state: 'open'; prUrl: string; prNumber: number } | { state: 'merged'; prUrl: string; prNumber: number } | null> {
  // List open PRs first; that's the most actionable case (resume continues here).
  const open = await sh(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
    { cwd: ctx.path, allowFailure: true },
  );
  if (open.code === 0 && open.stdout.trim().length > 0) {
    try {
      const parsed = JSON.parse(open.stdout) as { number: number; url: string }[];
      const first = parsed[0];
      if (first) return { state: 'open', prUrl: first.url, prNumber: first.number };
    } catch {
      // fall through
    }
  }

  // No open PR — check whether an earlier attempt already merged this branch.
  const merged = await sh(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,url', '--limit', '1'],
    { cwd: ctx.path, allowFailure: true },
  );
  if (merged.code === 0 && merged.stdout.trim().length > 0) {
    try {
      const parsed = JSON.parse(merged.stdout) as { number: number; url: string }[];
      const first = parsed[0];
      if (first) return { state: 'merged', prUrl: first.url, prNumber: first.number };
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Operator-authored uncommitted changes that AuthorStage carries onto its
 * branch as a `fix:`-prefixed commit before writing Convoy's plumbing. See
 * the `RealAuthorOpt.carryUncommittedChanges` doc in stages.ts for the
 * "why" (git-deploy platforms must not see the fix on main before Convoy's
 * gates have run).
 */
export interface CarryUncommittedInput {
  /** File paths from `git status --porcelain`, used for logging only. */
  files: string[];
  /** Commit subject. Caller pre-formats this (e.g. "fix: <medic root cause>"). */
  message: string;
}

/**
 * Create a branch, optionally carry the operator's uncommitted fix as a
 * separate commit, write Convoy's plumbing as a second commit, push, and
 * open a PR.
 *
 * Idempotent across resumes: callers pass a stable plan-keyed branch name
 * (see `planBranchName`). When the branch already exists locally or on
 * origin we reset it to the default branch HEAD and force-push the new
 * content. The caller is expected to have already probed for an existing
 * open/merged PR via `findExistingConvoyPr` and passed `existingPrUrl` if
 * a same-branch PR is open — in that case we skip `gh pr create` and
 * return the existing URL with the new commits pushed to its head.
 *
 * Carry flow when `carry` is provided:
 *   1. git stash push -u (preserve the dirty tree across the checkout)
 *   2. git fetch + checkout -B <branch> from origin/<default>
 *   3. git stash pop (restore dirty tree onto the new branch)
 *   4. git add -A; git commit -m "<carry.message>" (the operator's fix)
 *   5. write Convoy plumbing files
 *   6. git add -f -- <plumbing>; git commit -m "<title>"
 *   7. git push --force-with-lease
 *
 * Without carry it's the original two-step (checkout, write, commit, push).
 *
 * Throws on any step's failure with context the caller can surface.
 */
export async function createPrFromAuthoredFiles(
  ctx: GitRepoContext,
  branch: string,
  files: AuthoredFileInput[],
  title: string,
  body: string,
  existingPrUrl?: string,
  carry?: CarryUncommittedInput,
): Promise<PrResult> {
  if (files.length === 0) {
    throw new Error('createPrFromAuthoredFiles called with no files');
  }

  // Containment check — reject any authored path that would write outside the
  // repo root BEFORE we mutate git state or disk. The plan is treated as an
  // executable artifact elsewhere in the pipeline, so "Convoy only authors
  // deployment-surface files" has to be enforced at the filesystem boundary,
  // not just assumed from the plan.
  const repoRoot = resolve(ctx.path);
  for (const file of files) {
    assertPathInsideRepo(repoRoot, file.path);
  }

  // Step 1 — stash if dirty. We stash BEFORE the checkout so the operator's
  // changes survive being switched onto a fresh branch. -u includes untracked
  // files (.vscode/, .env*.local, etc.) that the operator might have on disk.
  // Without --keep-index since there's no staged-vs-unstaged distinction we
  // care to preserve: the dirty content goes into one stash entry and comes
  // back as one diff.
  const stashed = carry !== undefined && (await hasUncommittedChanges(ctx));
  if (carry !== undefined && !stashed) {
    // Operator told us to carry, but the working tree is clean by the time
    // we got here — likely a race with an editor or a second `convoy resume`
    // that already committed. Carrying nothing is the right answer; fall
    // through to the no-carry branch.
  }
  if (stashed) {
    await sh('git', ['stash', 'push', '-u', '-m', 'convoy: pre-author carry'], { cwd: ctx.path });
  } else if (await hasUncommittedChanges(ctx)) {
    // No carry instructed but tree is dirty — preserve the existing safety
    // contract. The caller (preflight) should have caught this; reaching
    // here means something slipped past, and we'd rather fail loud than
    // silently lose the operator's WIP.
    throw new Error(
      'target repo has uncommitted changes and no carry was instructed; commit or stash before running real-author',
    );
  }

  // Step 2 — make sure we're branching from the latest default branch. -B
  // resets the branch to that commit, which is what we want for re-attempts:
  // the prior run's commits on this branch (if any) are overwritten with
  // fresh content built from the plan's authored files. Force-push later
  // cements that.
  await sh('git', ['fetch', 'origin', ctx.defaultBranch], { cwd: ctx.path });
  await sh('git', ['checkout', '-B', branch, `origin/${ctx.defaultBranch}`], { cwd: ctx.path });

  // Step 3 — pop the stash if we created one. This puts the operator's
  // uncommitted changes back into the working tree, now on convoy's branch.
  // If the dirty file paths overlap with files Convoy is about to write,
  // we let the operator's content win in the carry commit; Convoy's commit
  // (Step 6) re-overwrites those paths with the plan's authored content.
  if (stashed) {
    try {
      await sh('git', ['stash', 'pop'], { cwd: ctx.path });
    } catch (err) {
      // Stash pop conflicts mean the operator's dirty content collides with
      // origin/<default>. Surface clearly — Convoy can't auto-resolve, and
      // proceeding would produce an inconsistent commit.
      throw new Error(
        `stash pop failed when carrying uncommitted changes onto ${branch}: ${err instanceof Error ? err.message : String(err)}. ` +
          `The operator's changes may conflict with origin/${ctx.defaultBranch}. ` +
          `Resolve manually: cd ${ctx.path} && git stash pop, then re-run \`convoy resume\`.`,
      );
    }
  }

  // Step 4 — carry the operator's fix as a separate commit. -A picks up
  // tracked-modified, untracked-not-ignored, and deletions. Empty diff
  // (e.g. all dirty files were gitignored) → silently skip the commit so
  // the PR doesn't get an empty `fix:` entry.
  let carryCommitted = false;
  if (carry !== undefined && stashed) {
    await sh('git', ['add', '-A'], { cwd: ctx.path });
    const staged = await sh('git', ['diff', '--cached', '--name-only'], { cwd: ctx.path, allowFailure: true });
    if (staged.code === 0 && staged.stdout.trim().length > 0) {
      await sh('git', ['commit', '-m', carry.message], { cwd: ctx.path });
      carryCommitted = true;
    }
  }

  // Step 5 — write each Convoy-authored file to disk. These overwrite
  // anything the carry commit might have placed at the same path (e.g. if
  // the operator edited a Convoy-owned file by hand).
  for (const file of files) {
    const abs = resolve(repoRoot, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contentPreview, 'utf8');
  }

  // Step 6 — stage, commit, push. Force-add: Convoy owns this list
  // (Dockerfile, platform manifest, .env.schema, .convoy/*) and many Node
  // templates gitignore .env* broadly, which would silently drop .env.schema
  // without -f. Empty-staged-diff guard: when the plumbing files already
  // match origin/<default> (a prior PR already shipped them), git diff
  // --cached is empty and `git commit` would fail "nothing to commit" — we
  // skip the commit and let the caller decide what to do via the noOp
  // signal in PrResult. --force-with-lease on push: rewrite the prior
  // attempt's branch head safely (refuses if someone else pushed
  // concurrently).
  await sh('git', ['add', '-f', '--', ...files.map((f) => f.path)], { cwd: ctx.path });
  const plumbingStaged = await sh('git', ['diff', '--cached', '--name-only'], { cwd: ctx.path, allowFailure: true });
  const plumbingHasDiff = plumbingStaged.code === 0 && plumbingStaged.stdout.trim().length > 0;
  let plumbingCommitted = false;
  if (plumbingHasDiff) {
    await sh('git', ['commit', '-m', title], { cwd: ctx.path });
    plumbingCommitted = true;
  }

  // Did this whole flow result in any new commits? Possible no-op cases:
  //   - plumbing already on origin/<default> AND no carry was instructed
  //   - plumbing already on origin/<default> AND carry's diff was empty
  // In both, the branch points at origin/<default> and there's nothing to
  // push. Surface that clearly so AuthorStage skips with pr.already_shipped.
  const anythingCommitted = plumbingCommitted || carryCommitted;
  if (!anythingCommitted) {
    return {
      branch,
      prUrl: existingPrUrl ?? '',
      prNumber: existingPrUrl ? (parsePrNumber(existingPrUrl) ?? 0) : 0,
      noOp: true,
    };
  }

  await sh('git', ['push', '--force-with-lease', '-u', 'origin', branch], { cwd: ctx.path });

  if (existingPrUrl) {
    const prNumber = parsePrNumber(existingPrUrl);
    if (prNumber === null) {
      throw new Error(`could not parse PR number from existing PR url ${existingPrUrl}`);
    }
    return { branch, prUrl: existingPrUrl, prNumber };
  }

  // Open the PR via gh.
  const prCreate = await sh(
    'gh',
    [
      'pr',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--base',
      ctx.defaultBranch,
      '--head',
      branch,
    ],
    { cwd: ctx.path },
  );

  const prUrl = extractPrUrl(prCreate.stdout) ?? extractPrUrl(prCreate.stderr);
  if (!prUrl) {
    throw new Error(`gh pr create did not return a URL; output was:\n${prCreate.stdout}\n${prCreate.stderr}`);
  }
  const prNumber = parsePrNumber(prUrl);
  if (prNumber === null) {
    throw new Error(`could not parse PR number from ${prUrl}`);
  }
  return { branch, prUrl, prNumber };
}

/**
 * Refuse absolute paths and any relative path that resolves outside the repo
 * root (traversal via `..`, symlink-style escapes). Throws with the offending
 * path so the caller surfaces it in the run log.
 */
function assertPathInsideRepo(repoRoot: string, relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new Error(`authored file path must be relative to repo root: ${relPath}`);
  }
  const abs = resolve(repoRoot, relPath);
  if (abs === repoRoot) {
    throw new Error(`authored file path resolves to repo root itself: ${relPath}`);
  }
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`authored file path escapes repo root: ${relPath}`);
  }
}

function extractPrUrl(output: string): string | null {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match?.[0] ?? null;
}

function parsePrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  if (!match || !match[1]) return null;
  return Number(match[1]);
}

export async function prStatus(prUrl: string): Promise<'open' | 'merged' | 'closed' | null> {
  try {
    const res = await sh('gh', ['pr', 'view', prUrl, '--json', 'state'], { allowFailure: true });
    if (res.code !== 0) return null;
    const parsed = JSON.parse(res.stdout) as { state?: string };
    if (parsed.state === 'OPEN') return 'open';
    if (parsed.state === 'MERGED') return 'merged';
    if (parsed.state === 'CLOSED') return 'closed';
    return null;
  } catch {
    return null;
  }
}

export async function mergePr(
  prUrl: string,
  opts: { method?: 'merge' | 'squash' | 'rebase' } = {},
): Promise<{ ok: boolean; error?: string }> {
  const method = opts.method ?? 'squash';
  try {
    await sh('gh', ['pr', 'merge', prUrl, `--${method}`, '--delete-branch']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
