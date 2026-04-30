import { spawn } from 'node:child_process';

/**
 * Low-level VPS deploy primitives over SSH + rsync. Convoy is the control
 * plane (no platform CLI to lean on), so the safety properties have to come
 * from this file: blue/green slots, atomic nginx swap (when the operator
 * opts into managed nginx), and a previous slot that stays running until
 * observe passes — that's the pre-staged reverse the principles demand.
 *
 * Cheapest delivery path by default: rsync the source tree to the box,
 * `docker build` on the box. Only the diff transfers; subsequent layers
 * reuse the local Docker layer cache. No registry account needed, no
 * `docker save | docker load` (which transfers the full image every time).
 */

export interface VpsTarget {
  /** SSH destination — `user@host` or `host` (uses ~/.ssh/config). */
  host: string;
  /** Optional override for the SSH port. Default 22. */
  port?: number;
  /** Optional path to a private key. Falls back to ~/.ssh/config / agent. */
  identityFile?: string;
  /** Base directory on the box. Convoy owns everything under this. */
  deployRoot: string;
}

export interface VpsExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface SshOpts {
  /** stdin to pipe to the remote command. */
  input?: string;
  /** Hard timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Per-line stream callback for live log capture. */
  onLog?: (line: string) => void;
}

/**
 * Run a command on the remote box. Wraps `ssh` so we keep the SSH config
 * (host aliases, key chain, jump hosts) the operator already trusts. We
 * never autofill credentials or skip host-key verification — if the
 * connection isn't ready, the operator sees the real ssh error.
 */
export async function sshExec(
  target: VpsTarget,
  remoteCommand: string,
  opts: SshOpts = {},
): Promise<VpsExecResult> {
  const args: string[] = [];
  if (target.port) args.push('-p', String(target.port));
  if (target.identityFile) args.push('-i', target.identityFile);
  args.push('-o', 'BatchMode=yes'); // never prompt — fail fast in non-interactive runs
  args.push(target.host, '--', 'bash', '-lc', remoteCommand);
  return spawnCapture('ssh', args, opts);
}

/**
 * rsync the source tree to the box. Excludes node_modules, .git, .next,
 * etc. — the same set the .dockerignore covers. The point is to upload
 * only what `docker build` actually reads.
 */
export async function rsyncSource(
  target: VpsTarget,
  localPath: string,
  remoteSubdir: string,
  opts: { onLog?: (line: string) => void; timeoutMs?: number } = {},
): Promise<VpsExecResult> {
  const sshCommand = ['ssh'];
  if (target.port) sshCommand.push('-p', String(target.port));
  if (target.identityFile) sshCommand.push('-i', target.identityFile);
  sshCommand.push('-o', 'BatchMode=yes');

  const remoteDest = `${target.host}:${target.deployRoot}/${remoteSubdir}`;

  const args = [
    '-az',
    '--delete',
    '-e', sshCommand.join(' '),
    '--exclude', 'node_modules/',
    '--exclude', '.git/',
    '--exclude', '.next/',
    '--exclude', '.nuxt/',
    '--exclude', '.svelte-kit/',
    '--exclude', '.turbo/',
    '--exclude', 'dist/',
    '--exclude', 'build/',
    '--exclude', '.env',
    '--exclude', '.env.*',
    `${localPath}/`,
    remoteDest,
  ];
  return spawnCapture('rsync', args, opts);
}

/**
 * Local check: does the operator's box have `ssh` available? Mirrors the
 * other adapters' *Available() preflight helpers.
 */
export async function sshAvailable(): Promise<boolean> {
  const result = await spawnCapture('ssh', ['-V'], { timeoutMs: 2000 });
  // ssh -V writes the banner to stderr and exits 0 on most systems; ENOENT
  // returns ok=false.
  return result.ok || (result.stderr + result.stdout).toLowerCase().includes('openssh');
}

export async function rsyncAvailable(): Promise<boolean> {
  const result = await spawnCapture('rsync', ['--version'], { timeoutMs: 2000 });
  return result.ok;
}

/**
 * Verify the box is reachable, has docker, and is willing to talk to us.
 * Returns a structured report instead of a single boolean — the caller
 * (preflight + the connection probe) wants to surface specific remedies.
 */
export interface RemoteReadiness {
  reachable: boolean;
  hasDocker: boolean;
  hasNginx: boolean;
  deployRootExists: boolean;
  diskFreeGb: number | null;
  user: string | null;
  rawError?: string;
}

export async function probeRemote(target: VpsTarget): Promise<RemoteReadiness> {
  // Compute the parent dir locally so we don't have to ship shell parameter
  // expansion through a TS template literal (which would clash with our own
  // interpolation). Falls back to "/" if deployRoot has no parent.
  const parentDir = target.deployRoot.replace(/\/[^/]*\/?$/, '') || '/';
  const probe = `set -e
echo "user=$(whoami)"
echo "docker=$(command -v docker >/dev/null 2>&1 && echo yes || echo no)"
echo "nginx=$(command -v nginx >/dev/null 2>&1 && echo yes || echo no)"
[ -d "${target.deployRoot}" ] && echo "deployroot=yes" || echo "deployroot=no"
echo "diskfree=$(df --output=avail -BG "${parentDir}" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
`;
  const result = await sshExec(target, probe, { timeoutMs: 8000 });
  if (!result.ok) {
    return {
      reachable: false,
      hasDocker: false,
      hasNginx: false,
      deployRootExists: false,
      diskFreeGb: null,
      user: null,
      rawError: result.stderr.trim().slice(0, 240),
    };
  }
  const out = result.stdout;
  const pick = (key: string): string => {
    const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  const diskRaw = pick('diskfree');
  const diskFreeGb = diskRaw.length > 0 ? Number(diskRaw) : null;
  return {
    reachable: true,
    hasDocker: pick('docker') === 'yes',
    hasNginx: pick('nginx') === 'yes',
    deployRootExists: pick('deployroot') === 'yes',
    diskFreeGb: Number.isFinite(diskFreeGb) ? diskFreeGb : null,
    user: pick('user') || null,
  };
}

/**
 * Idempotent provisioning of the deploy root directory tree. Called before
 * the first rsync. Does NOT install Docker — that's `convoy vps bootstrap`,
 * which is opt-in and only runs after explicit operator approval.
 */
export async function ensureDeployRoot(target: VpsTarget): Promise<VpsExecResult> {
  const cmd = `mkdir -p "${target.deployRoot}/source" "${target.deployRoot}/releases"
touch "${target.deployRoot}/env"
chmod 600 "${target.deployRoot}/env"
echo provisioned`;
  return sshExec(target, cmd, { timeoutMs: 5000 });
}

/**
 * Read the currently-active slot, blue or green. Convoy keeps a marker
 * file so blue/green stays sticky across deploys without us having to
 * inspect Docker labels.
 */
export async function readActiveSlot(target: VpsTarget): Promise<'blue' | 'green' | null> {
  const result = await sshExec(target, `cat "${target.deployRoot}/active-slot" 2>/dev/null || echo none`);
  const value = result.stdout.trim();
  if (value === 'blue' || value === 'green') return value;
  return null;
}

export async function writeActiveSlot(target: VpsTarget, slot: 'blue' | 'green'): Promise<VpsExecResult> {
  return sshExec(target, `echo ${slot} > "${target.deployRoot}/active-slot"`);
}

/**
 * Run the Convoy deploy script on the box. Streams output to onLog so the
 * orchestrator can render it live. The script itself is authored by Convoy
 * (see draftVpsFiles in src/planner/author.ts) — this just kicks it off.
 */
export async function executeDeploy(
  target: VpsTarget,
  release: string,
  slot: 'blue' | 'green',
  opts: { onLog?: (line: string) => void; timeoutMs?: number } = {},
): Promise<VpsExecResult> {
  const command = [
    `export CONVOY_RELEASE="${release}"`,
    `export CONVOY_SLOT="${slot}"`,
    `export CONVOY_DEPLOY_ROOT="${target.deployRoot}"`,
    `bash "${target.deployRoot}/source/.convoy/vps-deploy.sh"`,
  ].join(' && ');
  return sshExec(target, command, opts);
}

/**
 * Atomically swap the nginx upstream weighting between blue/green.
 * Only runs when the operator has opted into Convoy-managed nginx; if
 * they manage their own, this never gets called.
 */
export async function swapNginxUpstream(
  target: VpsTarget,
  appName: string,
  newSlot: 'blue' | 'green',
): Promise<VpsExecResult> {
  const upstream = newSlot === 'blue'
    ? `server 127.0.0.1:18081;`
    : `server 127.0.0.1:18082;`;
  const cmd = `cat > /etc/nginx/conf.d/convoy-${appName}.upstream.conf <<'EOF'
upstream convoy_${appName} {
  ${upstream}
}
EOF
nginx -t && nginx -s reload`;
  return sshExec(target, `sudo bash -c '${cmd.replace(/'/g, "'\\''")}'`, { timeoutMs: 8000 });
}

/**
 * Roll back to the previous slot. Pre-staged reverse: the previous
 * container is still running (we don't stop it until observe passes),
 * so rollback is a single nginx upstream swap.
 */
export async function rollbackSlot(
  target: VpsTarget,
  appName: string,
  previousSlot: 'blue' | 'green',
  manageNginx: boolean,
): Promise<VpsExecResult> {
  if (manageNginx) {
    return swapNginxUpstream(target, appName, previousSlot);
  }
  // Operator-managed nginx: we can't reload theirs. Best we can do is
  // make the previous slot's container the canonical one and let their
  // upstream config (which we assume routes to the slot they marked
  // active) take over.
  return writeActiveSlot(target, previousSlot);
}

/**
 * Tail docker logs for the active slot's container. AsyncIterable shape
 * matches Adapter.readLogs(). Bounded by --tail to avoid a 10-day backlog
 * landing in the timeline.
 */
export async function* streamLogs(
  target: VpsTarget,
  slot: 'blue' | 'green',
  tailLines = 200,
): AsyncIterable<string> {
  const cmd = `docker logs --tail ${tailLines} --timestamps convoy-${slot}-current 2>&1`;
  const result = await sshExec(target, cmd, { timeoutMs: 10000 });
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    yield line;
  }
}

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<VpsExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onChunk = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text; else stderr += text;
      if (opts.onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line.length === 0) continue;
          opts.onLog(line);
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
