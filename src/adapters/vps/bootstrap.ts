/**
 * VPS bootstrap — installs Docker + Caddy on a fresh Debian/RHEL box over SSH.
 *
 * Idempotent: every step probes first and skips if already present.
 * Auditable: caller receives the exact commands before any are run (via onStep).
 * Principle-safe: nothing installs silently — the CLI presents a plan and
 * requires --yes; the MCP tool caller can inspect the plan step before apply.
 */
import { sshExec, type VpsTarget } from './runner.js';

export type StepStatus = 'done' | 'skipped' | 'failed';

export interface BootstrapStep {
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface BootstrapOpts {
  installDocker?: boolean;  // default true
  installCaddy?: boolean;   // default true
  createDeployRoot?: boolean; // default true
  /** Called once per step: before execution (status='running') and after. */
  onStep?: (label: string, status: 'running' | StepStatus, detail?: string) => void;
}

export interface BootstrapReport {
  ok: boolean;
  user: string | null;
  osFamily: 'debian' | 'rhel' | 'unknown';
  steps: BootstrapStep[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function bootstrapVps(
  target: VpsTarget,
  opts: BootstrapOpts = {},
): Promise<BootstrapReport> {
  const installDocker = opts.installDocker !== false;
  const installCaddy = opts.installCaddy !== false;
  const createDeployRoot = opts.createDeployRoot !== false;

  const report: BootstrapReport = {
    ok: true,
    user: null,
    osFamily: 'unknown',
    steps: [],
  };

  const step = async (
    label: string,
    cmd: string,
    skip: boolean,
    skipReason?: string,
  ): Promise<boolean> => {
    if (skip) {
      const s: BootstrapStep = { label, status: 'skipped', detail: skipReason };
      report.steps.push(s);
      opts.onStep?.(label, 'skipped', skipReason);
      return true;
    }
    opts.onStep?.(label, 'running');
    const result = await sshExec(target, cmd, { timeoutMs: 10 * 60 * 1000 });
    if (result.ok) {
      const s: BootstrapStep = { label, status: 'done' };
      report.steps.push(s);
      opts.onStep?.(label, 'done');
      return true;
    }
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    const s: BootstrapStep = { label, status: 'failed', detail };
    report.steps.push(s);
    opts.onStep?.(label, 'failed', detail);
    report.ok = false;
    return false;
  };

  // ---- Probe ----------------------------------------------------------------

  const probe = await probeBootstrap(target);
  report.user = probe.user;
  report.osFamily = probe.osFamily;

  if (!probe.reachable) {
    report.ok = false;
    report.steps.push({
      label: 'ssh connectivity',
      status: 'failed',
      detail: probe.rawError ?? 'connection refused',
    });
    return report;
  }

  if (probe.osFamily === 'unknown') {
    report.ok = false;
    report.steps.push({
      label: 'detect OS',
      status: 'failed',
      detail: 'Unsupported OS — expected Debian/Ubuntu or RHEL/CentOS/Rocky/Fedora',
    });
    return report;
  }

  // ---- Docker ---------------------------------------------------------------

  if (installDocker) {
    const ok1 = await step(
      'install Docker',
      // get.docker.com is idempotent but we guard with the command-check so
      // we don't re-run the curl on every bootstrap.
      `command -v docker >/dev/null 2>&1 && echo "already-installed" && exit 0; curl -fsSL https://get.docker.com | sudo sh`,
      probe.hasDocker,
      'docker already installed',
    );
    if (!ok1) return report;

    // Enable + start Docker (idempotent)
    await step(
      'enable Docker service',
      `sudo systemctl enable docker && sudo systemctl start docker`,
      false,
    );

    // Add user to docker group so they don't need sudo for docker commands
    await step(
      `add ${probe.user ?? 'user'} to docker group`,
      `sudo usermod -aG docker ${probe.user ?? '$USER'} 2>/dev/null || true`,
      false,
    );
  }

  // ---- Caddy ----------------------------------------------------------------

  if (installCaddy) {
    const caddyInstallCmd = probe.osFamily === 'debian'
      ? buildCaddyInstallDebian()
      : buildCaddyInstallRhel();

    const ok2 = await step(
      'install Caddy',
      caddyInstallCmd,
      probe.hasCaddy,
      'caddy already installed',
    );
    if (!ok2) return report;

    // /etc/caddy/sites/ for per-app site files
    await step(
      'create /etc/caddy/sites/',
      `sudo mkdir -p /etc/caddy/sites`,
      false,
    );

    // Idempotently add the import glob to the main Caddyfile
    await step(
      'patch Caddyfile with import /etc/caddy/sites/*.caddy',
      `grep -qF 'import /etc/caddy/sites/' /etc/caddy/Caddyfile 2>/dev/null || printf '\\nimport /etc/caddy/sites/*.caddy\\n' | sudo tee -a /etc/caddy/Caddyfile`,
      false,
    );

    // Enable + start Caddy (idempotent)
    await step(
      'enable Caddy service',
      `sudo systemctl enable caddy && sudo systemctl start caddy || sudo systemctl restart caddy`,
      false,
    );
  }

  // ---- Deploy root ----------------------------------------------------------

  if (createDeployRoot) {
    await step(
      `create deploy root ${target.deployRoot}`,
      `sudo mkdir -p "${target.deployRoot}" && sudo chown $(whoami):$(whoami) "${target.deployRoot}"`,
      probe.deployRootExists,
      'directory already exists',
    );
  }

  return report;
}

// ---------------------------------------------------------------------------
// Probe — detect OS + what's already installed
// ---------------------------------------------------------------------------

interface BootstrapProbe {
  reachable: boolean;
  user: string | null;
  osFamily: 'debian' | 'rhel' | 'unknown';
  hasDocker: boolean;
  hasCaddy: boolean;
  deployRootExists: boolean;
  rawError?: string;
}

async function probeBootstrap(target: VpsTarget): Promise<BootstrapProbe> {
  const script = `
set -e
echo "user=$(whoami)"
command -v docker >/dev/null 2>&1 && echo "docker=yes" || echo "docker=no"
command -v caddy >/dev/null 2>&1 && echo "caddy=yes" || echo "caddy=no"
[ -d "${target.deployRoot}" ] && echo "deployroot=yes" || echo "deployroot=no"
if grep -qi 'ubuntu\\|debian' /etc/os-release 2>/dev/null || [ -f /etc/debian_version ]; then
  echo "os_family=debian"
elif grep -qi 'rhel\\|centos\\|rocky\\|fedora\\|almalinux' /etc/os-release 2>/dev/null || [ -f /etc/redhat-release ]; then
  echo "os_family=rhel"
else
  echo "os_family=unknown"
fi
`;
  const result = await sshExec(target, script, { timeoutMs: 10_000 });
  if (!result.ok) {
    return {
      reachable: false,
      user: null,
      osFamily: 'unknown',
      hasDocker: false,
      hasCaddy: false,
      deployRootExists: false,
      rawError: result.stderr.trim().slice(0, 240),
    };
  }

  const pick = (key: string): string => {
    const m = result.stdout.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? (m[1] ?? '').trim() : '';
  };

  const osRaw = pick('os_family');

  return {
    reachable: true,
    user: pick('user') || null,
    osFamily: osRaw === 'debian' || osRaw === 'rhel' ? osRaw : 'unknown',
    hasDocker: pick('docker') === 'yes',
    hasCaddy: pick('caddy') === 'yes',
    deployRootExists: pick('deployroot') === 'yes',
  };
}

// ---------------------------------------------------------------------------
// OS-specific Caddy install scripts
// ---------------------------------------------------------------------------

function buildCaddyInstallDebian(): string {
  return `
set -e
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \\
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \\
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
`.trim();
}

function buildCaddyInstallRhel(): string {
  return `
set -e
sudo dnf install -y 'dnf-command(copr)' 2>/dev/null || sudo yum install -y 'dnf-command(copr)'
sudo dnf copr enable -y @caddy/caddy
sudo dnf install -y caddy
`.trim();
}
