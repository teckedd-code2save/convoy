import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
 * Create a branch, write the authored files, commit, push, and open a PR.
 * Throws on any step's failure with context the caller can surface.
 */
export async function createPrFromAuthoredFiles(
  ctx: GitRepoContext,
  runId: string,
  files: AuthoredFileInput[],
  title: string,
  body: string,
): Promise<PrResult> {
  if (files.length === 0) {
    throw new Error('createPrFromAuthoredFiles called with no files');
  }
  if (await hasUncommittedChanges(ctx)) {
    throw new Error('target repo has uncommitted changes; commit or stash before running real-author');
  }

  const branch = `convoy/${runId.slice(0, 8)}`;

  // Make sure we're branching from the latest default branch.
  await sh('git', ['fetch', 'origin', ctx.defaultBranch], { cwd: ctx.path });
  await sh('git', ['checkout', '-B', branch, `origin/${ctx.defaultBranch}`], { cwd: ctx.path });

  // Write each authored file to disk.
  for (const file of files) {
    const abs = join(ctx.path, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contentPreview, 'utf8');
  }

  // Stage, commit, push. Force-add: Convoy owns this list (Dockerfile, platform manifest,
  // .env.schema, .convoy/*) and many Node templates gitignore .env* broadly, which would
  // silently drop .env.schema without -f.
  await sh('git', ['add', '-f', '--', ...files.map((f) => f.path)], { cwd: ctx.path });
  await sh('git', ['commit', '-m', title], { cwd: ctx.path });
  await sh('git', ['push', '-u', 'origin', branch], { cwd: ctx.path });

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
