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
 * Create a branch, write the authored files, commit, push, and open a PR.
 *
 * Idempotent across resumes: callers pass a stable plan-keyed branch name
 * (see `planBranchName`). When the branch already exists locally or on
 * origin we reset it to the default branch HEAD and force-push the new
 * content. The caller is expected to have already probed for an existing
 * open/merged PR via `findExistingConvoyPr` and passed `existingPrUrl` if
 * a same-branch PR is open — in that case we skip `gh pr create` and
 * return the existing URL with the new commit pushed to its head.
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
): Promise<PrResult> {
  if (files.length === 0) {
    throw new Error('createPrFromAuthoredFiles called with no files');
  }
  if (await hasUncommittedChanges(ctx)) {
    throw new Error('target repo has uncommitted changes; commit or stash before running real-author');
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

  // Make sure we're branching from the latest default branch. -B resets the
  // branch to that commit, which is what we want for re-attempts: the prior
  // run's commit on this branch (if any) is overwritten with fresh content
  // built from the plan's authored files. Force-push later cements that.
  await sh('git', ['fetch', 'origin', ctx.defaultBranch], { cwd: ctx.path });
  await sh('git', ['checkout', '-B', branch, `origin/${ctx.defaultBranch}`], { cwd: ctx.path });

  // Write each authored file to disk.
  for (const file of files) {
    const abs = resolve(repoRoot, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contentPreview, 'utf8');
  }

  // Stage, commit, push. Force-add: Convoy owns this list (Dockerfile, platform manifest,
  // .env.schema, .convoy/*) and many Node templates gitignore .env* broadly, which would
  // silently drop .env.schema without -f. --force-with-lease on push: rewrite the prior
  // attempt's branch head safely (refuses if someone else pushed concurrently).
  await sh('git', ['add', '-f', '--', ...files.map((f) => f.path)], { cwd: ctx.path });
  await sh('git', ['commit', '-m', title], { cwd: ctx.path });
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
