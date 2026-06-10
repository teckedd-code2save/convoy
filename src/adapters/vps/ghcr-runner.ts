import { spawn } from 'node:child_process';

/**
 * GHCR-based VPS deployment runner.
 *
 * This is the second VPS delivery path alongside the rsync+build-on-box path
 * in runner.ts. The shape mirrors ship-to-vps: build the Docker image on the
 * Convoy agent machine, push to GHCR, then SSH to the box and let Docker pull
 * the exact SHA-tagged image and roll the compose service.
 *
 * Why this exists: rsync+build-on-box works well for small boxes with limited
 * bandwidth (only the diff transfers, build happens where the docker cache
 * lives). GHCR path is better when the operator already has a registry account
 * (GHCR is free on public repos), when the box is underpowered for image
 * builds, or when the deploy path must exactly mirror a GitHub Actions workflow
 * (CI builds to GHCR → box pulls same image).
 *
 * Caddy helpers live here because ship-to-vps uses Caddy exclusively, and
 * any app deployed via GHCR from a B2DP-scaffold is expected to land behind
 * Caddy.
 */

export interface GhcrDeployTarget {
  /** SSH destination — `user@host` or `host` (uses ~/.ssh/config). */
  host: string;
  port?: number;
  identityFile?: string;
  /** Base directory on the box, e.g. /opt/my-app. */
  deployRoot: string;
}

export interface GhcrExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface SpawnOpts {
  input?: string;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Local docker operations
// ---------------------------------------------------------------------------

export async function dockerAvailable(): Promise<boolean> {
  const result = await spawnCapture('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 4000,
  });
  return result.ok || result.stdout.trim().length > 0;
}

/** Login to a registry — idempotent, token piped via stdin (no shell history). */
export async function ghcrLogin(
  registry: string,
  username: string,
  token: string,
): Promise<GhcrExecResult> {
  return spawnCapture('docker', ['login', registry, '-u', username, '--password-stdin'], {
    input: token,
    timeoutMs: 15_000,
  });
}

export interface BuildPushOpts {
  /** Docker build args injected at build time. */
  buildArgs?: Record<string, string>;
  /** Tag suffix appended to imageRef. Default: the current UTC ms as base36. */
  tag?: string;
  /** Additional tags (e.g. 'latest'). */
  extraTags?: string[];
  /** Stream build log lines to a callback. */
  onLog?: (line: string) => void;
  /** Hard timeout in ms. Default 15 min. */
  timeoutMs?: number;
}

export interface BuildPushResult {
  ok: boolean;
  imageRef: string;
  tag: string;
  logs: string[];
  error?: string;
}

/**
 * Build and push a Docker image to GHCR in one step using `docker buildx build
 * --push`. The caller supplies the base imageRef (e.g. `ghcr.io/myorg/my-app`);
 * we append the tag and return the fully-qualified ref for rollback staging.
 */
export async function buildAndPushGhcr(
  localPath: string,
  imageRef: string,
  opts: BuildPushOpts = {},
): Promise<BuildPushResult> {
  const tag = opts.tag ?? `r${Date.now().toString(36)}`;
  const fullRef = `${imageRef}:${tag}`;

  const args = ['buildx', 'build', '--push', '--tag', fullRef];
  if (opts.extraTags) {
    for (const t of opts.extraTags) args.push('--tag', `${imageRef}:${t}`);
  }
  if (opts.buildArgs) {
    for (const [k, v] of Object.entries(opts.buildArgs)) {
      args.push('--build-arg', `${k}=${v}`);
    }
  }
  args.push('.');

  const logs: string[] = [];
  const result = await spawnCapture('docker', args, {
    cwd: localPath,
    timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
    onLog: (line) => {
      logs.push(line);
      opts.onLog?.(line);
    },
  });

  return {
    ok: result.ok,
    imageRef: fullRef,
    tag,
    logs,
    ...(result.ok ? {} : { error: (result.stderr || result.stdout).trim().slice(0, 500) }),
  };
}

// ---------------------------------------------------------------------------
// Remote deploy via docker compose
// ---------------------------------------------------------------------------

export interface ComposeDeployOpts {
  /** Full image reference including tag, e.g. `ghcr.io/myorg/my-app:abc1234`. */
  imageRef: string;
  /** Compose service to roll. Default: `web`. */
  service?: string;
  /** Path to the compose file on the box. Default: `<deployRoot>/docker-compose.yml`. */
  composeFile?: string;
  /** Run migrations container before rolling the service. */
  runMigrations?: boolean;
  /** Docker network for the migrations container. Default: derived from appName. */
  migrationNetwork?: string;
  /** GitHub username for GHCR login on the box. */
  ghcrUsername: string;
  /** GitHub token for GHCR login on the box. */
  ghcrToken: string;
  /** GHCR registry hostname. Default: `ghcr.io`. */
  registry?: string;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

export interface ComposeDeployResult {
  ok: boolean;
  imageRef: string;
  logs: string[];
  error?: string;
}

/**
 * Deploy a GHCR-tagged image to a VPS by SSHing in and running:
 *   docker login → docker pull → (optional migrations) → docker compose up
 *
 * This mirrors the deploy.yml step from ship-to-vps exactly, so apps that
 * were set up by that skill slot straight into this runner.
 */
export async function composeDeployViaGhcr(
  target: GhcrDeployTarget,
  opts: ComposeDeployOpts,
): Promise<ComposeDeployResult> {
  const registry = opts.registry ?? 'ghcr.io';
  const service = opts.service ?? 'web';
  const composeFile = opts.composeFile ?? `${target.deployRoot}/docker-compose.yml`;
  const envFile = `${target.deployRoot}/.env`;
  const logs: string[] = [];
  const migrationNetwork = opts.migrationNetwork ?? target.deployRoot.split('/').pop() ?? service;

  // Build the remote script — mirror deploy.yml deploy step.
  // Migration command follows shippability-contract item 1: `node
  // node_modules/prisma/build/index.js migrate deploy --url "$DATABASE_URL"`
  // The --url flag (Prisma 7.2+) bypasses prisma.config.ts in one-shot
  // containers so transitive config-load deps (effect, etc.) aren't needed.
  const migrations = opts.runMigrations
    ? `echo "[convoy] running migrations"
docker run --rm \\
  --network ${migrationNetwork} \\
  --env-file ${envFile} \\
  "${opts.imageRef}" \\
  sh -c 'node node_modules/prisma/build/index.js migrate deploy --url "$DATABASE_URL"'
`
    : '';

  const remoteScript = `set -euo pipefail
echo "${opts.ghcrToken}" | docker login ${registry} -u "${opts.ghcrUsername}" --password-stdin
echo "[convoy] pulling ${opts.imageRef}"
docker pull "${opts.imageRef}"
${migrations}
echo "[convoy] rolling service ${service}"
cd ${target.deployRoot}
WEB_IMAGE="${opts.imageRef}" docker compose -f "${composeFile}" up -d --no-deps --pull always ${service}
echo "[convoy] compose done"
docker compose -f "${composeFile}" ps
docker logs --tail=30 ${migrationNetwork}-${service} 2>/dev/null || true`;

  const result = await sshExec(target, remoteScript, {
    timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
    onLog: (line) => {
      logs.push(line);
      opts.onLog?.(line);
    },
  });

  return {
    ok: result.ok,
    imageRef: opts.imageRef,
    logs,
    ...(result.ok ? {} : { error: (result.stderr || result.stdout).trim().slice(0, 500) }),
  };
}

/**
 * Read the currently-deployed image tag from the compose service so we can
 * pre-stage a rollback before deploying. Returns null if the service isn't
 * running or the image format is unexpected.
 */
export async function readCurrentComposeImage(
  target: GhcrDeployTarget,
  deployRoot: string,
  service: string = 'web',
): Promise<string | null> {
  const result = await sshExec(target, `docker inspect --format '{{.Config.Image}}' $(docker compose -f "${deployRoot}/docker-compose.yml" ps -q ${service} 2>/dev/null | head -1) 2>/dev/null || echo none`, {
    timeoutMs: 8000,
  });
  const image = result.stdout.trim();
  if (!image || image === 'none' || !image.includes(':')) return null;
  return image;
}

/**
 * Roll back to a previous image by SSHing in and running compose up with the
 * previous image tag — same mechanism as the forward deploy but deterministic
 * (no pull if the layer cache already has the image).
 */
export async function rollbackComposeImage(
  target: GhcrDeployTarget,
  deployRoot: string,
  previousImageRef: string,
  service: string = 'web',
): Promise<GhcrExecResult> {
  const composeFile = `${deployRoot}/docker-compose.yml`;
  const cmd = `set -euo pipefail
cd ${deployRoot}
echo "[convoy] rolling back to ${previousImageRef}"
WEB_IMAGE="${previousImageRef}" docker compose -f "${composeFile}" up -d --no-deps ${service}
echo "[convoy] rollback done"`;
  return sshExec(target, cmd, { timeoutMs: 5 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// Health probe (reusable across VPS paths)
// ---------------------------------------------------------------------------

export interface HttpProbeResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export async function httpProbe(url: string, timeoutMs = 5000): Promise<HttpProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Caddy management
// ---------------------------------------------------------------------------

const CADDY_SITES_DIR = '/etc/caddy/sites';
const CADDY_MAIN_CONFIG = '/etc/caddy/Caddyfile';

/**
 * Ensure the main Caddyfile imports the sites directory. Idempotent — checks
 * with grep before appending. This is the fix the ship-to-vps skill requires
 * on fresh boxes (Caddy does not auto-load subdirectory files).
 */
export async function ensureCaddyImport(target: GhcrDeployTarget): Promise<GhcrExecResult> {
  const cmd = `grep -q "import ${CADDY_SITES_DIR}" ${CADDY_MAIN_CONFIG} 2>/dev/null \\
  || printf "\\nimport ${CADDY_SITES_DIR}/*.caddy\\n" >> ${CADDY_MAIN_CONFIG}
echo ok`;
  return sshExec(target, cmd, { timeoutMs: 5000 });
}

/**
 * Write a Caddy site file for the app. Creates `/etc/caddy/sites/<appName>.caddy`
 * as a simple reverse proxy. Idempotent — overwrites if already exists.
 */
export async function writeCaddySiteFile(
  target: GhcrDeployTarget,
  appName: string,
  domain: string,
  containerPort: number = 3000,
): Promise<GhcrExecResult> {
  const siteFile = `${CADDY_SITES_DIR}/${appName}.caddy`;
  const content = `${domain} {
  reverse_proxy localhost:${containerPort}
}`;
  const cmd = `mkdir -p ${CADDY_SITES_DIR}
cat > ${siteFile} <<'CADDY_EOF'
${content}
CADDY_EOF
echo written`;
  return sshExec(target, cmd, { timeoutMs: 5000 });
}

/**
 * Validate and reload Caddy. `caddy validate` catches config errors before
 * the reload so a bad site file doesn't take down all other sites.
 */
export async function reloadCaddy(target: GhcrDeployTarget): Promise<GhcrExecResult> {
  const cmd = `caddy validate --config ${CADDY_MAIN_CONFIG} >/dev/null 2>&1 \\
  && systemctl reload caddy \\
  && echo reloaded`;
  return sshExec(target, cmd, { timeoutMs: 8000 });
}

/**
 * Check that `caddy` is installed on the box.
 */
export async function caddyAvailable(target: GhcrDeployTarget): Promise<boolean> {
  const result = await sshExec(target, 'command -v caddy >/dev/null 2>&1 && echo yes || echo no', {
    timeoutMs: 5000,
  });
  return result.stdout.trim() === 'yes';
}

// ---------------------------------------------------------------------------
// SSH helpers — mirrored from runner.ts but for GhcrDeployTarget shape.
// Kept separate to avoid circular imports between the two runner files.
// ---------------------------------------------------------------------------

export async function sshExec(
  target: GhcrDeployTarget,
  remoteCommand: string,
  opts: { input?: string; timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<GhcrExecResult> {
  const args: string[] = [];
  if (target.port) args.push('-p', String(target.port));
  if (target.identityFile) args.push('-i', target.identityFile);
  args.push('-o', 'BatchMode=yes', target.host, '--', 'bash', '-lc', remoteCommand);
  return spawnCapture('ssh', args, opts);
}

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; onLog?: (line: string) => void; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GhcrExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: opts.env }),
    });
    let stdout = '';
    let stderr = '';
    const onChunk = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (opts.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) opts.onLog(line);
        }
      }
    };
    child.stdout.on('data', (c: Buffer) => onChunk('stdout', c));
    child.stderr.on('data', (c: Buffer) => onChunk('stderr', c));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          resolve({ ok: false, stdout, stderr: stderr || `${cmd} timed out`, code: -1 });
        }, opts.timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: -1 });
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
