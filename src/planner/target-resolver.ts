import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface TargetResolution {
  localPath: string;
  source: 'local' | 'cloned' | 'cached';
  repoUrl: string | null;
  owner?: string;
  repo?: string;
  branch?: string;
  sha?: string;
}

export interface ResolveOptions {
  cacheDir?: string;
  branch?: string;
  fetch?: boolean;
  onProgress?: (phase: string, detail?: string) => void;
}

/**
 * URL forms we accept:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/<branch>
 *   github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   owner/repo          (shorthand — only when it's not a local dir)
 */
const URL_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github\.com\/)([^/]+)\/([^/.]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+))?(?:\/.*)?$/;
const SHORT_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/;

export async function resolveTarget(
  input: string,
  opts: ResolveOptions = {},
): Promise<TargetResolution> {
  if (!input || input.trim().length === 0) {
    throw new Error('resolveTarget called with empty input');
  }

  const raw = input.trim();
  const progress = opts.onProgress ?? (() => {});

  // Local path takes priority — if it exists on disk and is a directory, use it.
  if (isLocalDir(raw)) {
    return { localPath: resolve(raw), source: 'local', repoUrl: null };
  }

  const parsed = parseGithubTarget(raw);
  if (!parsed) {
    throw new Error(
      `Could not resolve target "${raw}". Expected a local directory, an ` +
        `https://github.com/owner/repo URL, or an owner/repo shorthand.`,
    );
  }

  const { owner, repo, branchFromUrl } = parsed;
  const branch = opts.branch ?? branchFromUrl;
  const cacheDir = resolve(opts.cacheDir ?? join(process.cwd(), '.convoy', 'clones'));
  const localPath = join(cacheDir, 'github.com', owner, repo);
  const repoUrl = `https://github.com/${owner}/${repo}`;

  mkdirSync(cacheDir, { recursive: true });

  const alreadyCloned = existsSync(join(localPath, '.git'));
  if (alreadyCloned) {
    if (opts.fetch ?? true) {
      progress('cache.hit', `${owner}/${repo}`);
      try {
        await sh('git', ['fetch', '--depth=50', 'origin'], { cwd: localPath, timeoutMs: 120_000 });
        const target = branch ?? (await detectDefaultBranch(localPath));
        progress('cache.refresh', target);
        await sh('git', ['checkout', target], { cwd: localPath, timeoutMs: 30_000 });
        await sh('git', ['reset', '--hard', `origin/${target}`], { cwd: localPath, timeoutMs: 30_000 });
      } catch {
        // If fetch fails (offline, auth), proceed with the cached copy we have.
        progress('cache.offline', 'using cached snapshot');
      }
    } else {
      progress('cache.hit', `${owner}/${repo}`);
    }

    const sha = await getHeadSha(localPath);
    const resolved: TargetResolution = {
      localPath,
      source: 'cached',
      repoUrl,
      owner,
      repo,
    };
    if (branch !== undefined) resolved.branch = branch;
    if (sha !== undefined) resolved.sha = sha;
    return resolved;
  }

  // Fresh clone.
  progress('clone.starting', repoUrl);
  mkdirSync(localPath, { recursive: true });
  const cloneArgs = ['clone', '--depth=50'];
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push(repoUrl, localPath);
  try {
    await sh('git', cloneArgs, { timeoutMs: 5 * 60 * 1000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Clone of ${repoUrl} failed: ${message}. If the repo is private, run \`gh auth login\` ` +
        `with a token that has access.`,
    );
  }
  progress('clone.done', localPath);

  const sha = await getHeadSha(localPath);
  const resolved: TargetResolution = {
    localPath,
    source: 'cloned',
    repoUrl,
    owner,
    repo,
  };
  if (branch !== undefined) resolved.branch = branch;
  if (sha !== undefined) resolved.sha = sha;
  return resolved;
}

function isLocalDir(input: string): boolean {
  try {
    return existsSync(input) && statSync(input).isDirectory();
  } catch {
    return false;
  }
}

function parseGithubTarget(
  input: string,
): { owner: string; repo: string; branchFromUrl?: string } | null {
  const urlMatch = input.match(URL_RE);
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const result: { owner: string; repo: string; branchFromUrl?: string } = {
      owner: urlMatch[1],
      repo: urlMatch[2],
    };
    if (urlMatch[3]) result.branchFromUrl = urlMatch[3];
    return result;
  }

  // Shorthand only when it's not a path (no leading ./ or /) and doesn't look
  // like a filename the user would pass by accident (e.g. "plan.json").
  if (!input.startsWith('.') && !input.startsWith('/') && !input.includes(' ')) {
    const shortMatch = input.match(SHORT_RE);
    if (shortMatch && shortMatch[1] && shortMatch[2]) {
      return { owner: shortMatch[1], repo: shortMatch[2] };
    }
  }
  return null;
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const res = await sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
      timeoutMs: 5000,
    });
    const branch = res.stdout.trim().replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // fallthrough
  }
  return 'main';
}

async function getHeadSha(repoPath: string): Promise<string | undefined> {
  try {
    const res = await sh('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeoutMs: 5000 });
    const sha = res.stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`${cmd} ${args.join(' ')} timed out`));
        }, opts.timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
    });
  });
}
