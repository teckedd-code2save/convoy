import type { PlanAuthorSection, PlanAuthoredFile } from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { repoName, type ScanResult } from './scanner.js';

/**
 * The deterministic author produces a skeleton of what Convoy intends to write,
 * with sensible fallback content for each file. The enricher can replace the
 * contentPreview with AI-generated content tailored to the specific repo —
 * particularly for Dockerfiles where the dimensionality of choices is too high
 * to express as deterministic templates.
 *
 * @param servicePath - path of this service relative to the repo root, e.g.
 *   "apps/api". Pass "." (or omit) for single-service repos. Used to prefix
 *   authored file paths so multi-service monorepos don't collide (Dockerfile
 *   becomes apps/api/Dockerfile instead of overwriting the root Dockerfile).
 */
export function draftAuthorSection(
  scan: ScanResult,
  platform: Platform,
  servicePath = '.',
): PlanAuthorSection {
  const prefix = (p: string) =>
    servicePath === '.' || servicePath === '' ? p : `${servicePath}/${p}`;

  const files: PlanAuthoredFile[] = [];
  const profile = authoringProfile(platform);

  if (profile.needsDockerfile && !scan.hasDockerfile) {
    files.push(prefixFile(draftDockerfile(scan, platform), prefix));
    // A Dockerfile without a .dockerignore means `COPY . .` pulls
    // node_modules, .next, .git, .env*, build caches, IDE state — everything.
    // The build context balloons, the upload to Depot/buildkit takes minutes
    // to tens of minutes, and the auth token expires before the builder
    // finishes. We learned this from a 45-minute Fly build that died on
    // "Invalid token". Author them as a pair, always.
    if (!scan.hasDockerignore) {
      files.push(prefixFile(draftDockerignore(scan), prefix));
    }
  }

  if (scan.existingPlatform !== platform) {
    const platformConfig = profile.platformConfigFile?.(scan);
    if (platformConfig) files.push(prefixFile(platformConfig, prefix));
  }
  // Extra files some platforms need beyond their main config (e.g. VPS
  // ships a deploy.sh + optional nginx snippet alongside the Dockerfile).
  if (profile.extraFiles) {
    for (const f of profile.extraFiles(scan)) files.push(prefixFile(f, prefix));
  }

  const envSchema = draftEnvSchema(scan, platform);
  if (envSchema) files.push(prefixFile(envSchema, prefix));
  if (files.length > 0) files.push(draftConvoyManifest(files, prefix));

  return { convoyAuthoredFiles: files };
}

function prefixFile(file: PlanAuthoredFile, prefix: (p: string) => string): PlanAuthoredFile {
  return { ...file, path: prefix(file.path) };
}

/**
 * Per-platform authoring contract. The point of this seam is that "what
 * does Convoy author for this platform?" lives in one record per platform
 * instead of growing if/else branches across draftAuthorSection. Adding a
 * new platform is one entry, not one diff per file type.
 *
 * Properties:
 *   - needsDockerfile: true if the platform deploys a container image and
 *     therefore needs the repo to ship a Dockerfile (Vercel auto-detects;
 *     it doesn't).
 *   - managesPort: true if the platform injects $PORT at runtime (Fly /
 *     Vercel / Cloud Run / Railway). Drives both .env.schema authoring
 *     and preflight expectation filtering — never demand from the operator
 *     a value the platform sets itself.
 *   - platformConfigFile: the single platform-specific config file, if any
 *     (fly.toml / railway.toml / vercel.json / cloudbuild.yaml).
 *   - extraFiles: anything beyond the standard set. Used by VPS for the
 *     deploy script. Keep small — most platforms have none.
 */
interface AuthoringProfile {
  needsDockerfile: boolean;
  managesPort: boolean;
  platformConfigFile?: (scan: ScanResult) => PlanAuthoredFile | null;
  extraFiles?: (scan: ScanResult) => PlanAuthoredFile[];
}

function authoringProfile(platform: Platform): AuthoringProfile {
  switch (platform) {
    case 'fly':
      return {
        needsDockerfile: true,
        managesPort: true,
        platformConfigFile: draftFlyToml,
      };
    case 'railway':
      return {
        needsDockerfile: true,
        managesPort: true,
        platformConfigFile: draftRailwayToml,
      };
    case 'vercel':
      // Vercel builds natively from source. A Dockerfile there is confusing noise.
      return {
        needsDockerfile: false,
        managesPort: true,
        platformConfigFile: draftVercelJson,
      };
    case 'cloudrun':
      return {
        needsDockerfile: true,
        managesPort: true,
        platformConfigFile: draftCloudBuild,
      };
    case 'vps':
      // VPS deploys are container-based (Convoy runs `docker run` over SSH);
      // PORT is the operator's choice — they pick what their Docker run
      // binds and what nginx (if managed) routes to. So we *do* declare PORT
      // in .env.schema for VPS, unlike the managed PaaSes.
      return {
        needsDockerfile: true,
        managesPort: false,
        extraFiles: draftVpsFiles,
      };
  }
}

function platformManagesPort(platform: Platform): boolean {
  return authoringProfile(platform).managesPort;
}

function draftDockerfile(scan: ScanResult, platform: Platform): PlanAuthoredFile {
  const content = fallbackDockerfile(scan);
  return {
    path: 'Dockerfile',
    lines: content.split('\n').length,
    summary: `starter image for ${scan.ecosystem} on ${platform} — the AI pass tailors this to your repo when enabled`,
    contentPreview: content,
  };
}

/**
 * Signal-aware fallback. Uses every scan field that's relevant for a
 * production-quality Dockerfile: port, package manager, build command,
 * start command, framework (Next.js standalone), and data layer (Prisma
 * generate). When ANTHROPIC_API_KEY is set the enricher overwrites this
 * with a Dockerfile further tailored to the specific repo, but this
 * fallback is now good enough to deploy without enrichment for common stacks.
 */
function fallbackDockerfile(scan: ScanResult): string {
  const port = scan.port ?? 8080;

  switch (scan.ecosystem) {
    case 'python': {
      const hasDeps = scan.topLevelFiles.includes('requirements.txt') ||
        scan.topLevelFiles.includes('pyproject.toml');
      const installCmd = scan.packageManager === 'poetry'
        ? 'pip install poetry && poetry install --no-dev'
        : scan.packageManager === 'uv'
          ? 'pip install uv && uv sync --no-dev'
          : 'pip install --no-cache-dir -r requirements.txt || pip install --no-cache-dir .';
      const startCmd = scan.startCommand
        ?? (scan.framework === 'fastapi' ? `uvicorn main:app --host 0.0.0.0 --port ${port}`
          : scan.framework === 'django' ? `gunicorn --bind 0.0.0.0:${port} wsgi:application`
          : `python main.py`);
      return [
        `FROM python:3.12-slim`,
        `WORKDIR /app`,
        hasDeps ? `COPY ${scan.packageManager === 'poetry' ? 'pyproject.toml poetry.lock' : scan.packageManager === 'uv' ? 'pyproject.toml uv.lock' : 'requirements.txt'} ./` : `COPY . .`,
        hasDeps ? `RUN ${installCmd}` : null,
        hasDeps ? `COPY . .` : null,
        `EXPOSE ${port}`,
        `CMD ["sh", "-c", "${startCmd}"]`,
      ].filter(Boolean).join('\n') + '\n';
    }

    case 'go':
      return `FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./...

FROM alpine:3.21
COPY --from=build /out/app /app
EXPOSE ${port}
CMD ["/app"]
`;

    case 'rust':
      return `FROM rust:1.84-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release --bin $(basename $(cargo metadata --no-deps --format-version 1 | grep -o '"name":"[^"]*"' | head -1 | cut -d: -f2 | tr -d '"') 2>/dev/null || echo app)

FROM debian:bookworm-slim
COPY --from=build /src/target/release/* /usr/local/bin/
EXPOSE ${port}
CMD ["sh", "-c", "$(ls /usr/local/bin/ | head -1)"]
`;

    case 'ruby':
      return `FROM ruby:3.4-slim
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test
COPY . .
EXPOSE ${port}
CMD ["bundle", "exec", "rackup", "-p", "${port}", "-o", "0.0.0.0"]
`;

    case 'java-jvm':
      return `FROM eclipse-temurin:21 AS build
WORKDIR /src
COPY . .
RUN ./gradlew bootJar -x test 2>/dev/null || ./mvnw package -DskipTests

FROM eclipse-temurin:21-jre
COPY --from=build /src/build/libs/*.jar /app/app.jar
EXPOSE ${port}
CMD ["java", "-jar", "/app/app.jar"]
`;

    case 'static':
      return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;

    default: {
      // Node / JS — use every scan signal that's available.
      const installCmd = nodeInstallCmd(scan.packageManager);
      const hasPrisma = scan.dataLayer.some(d => d.toLowerCase().includes('prisma'));
      const isNext = scan.framework === 'next' || scan.framework === 'nextjs';
      const buildCmd = scan.buildCommand ?? (isNext ? 'npm run build' : null);
      const startCmd = scan.startCommand ?? 'npm start';

      if (isNext) {
        // Next.js standalone output — smallest possible production image.
        // The enricher can add output: 'standalone' to next.config if absent,
        // but this Dockerfile is already wired for it.
        return `FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ${scan.packageManager === 'pnpm' ? 'pnpm-lock.yaml .npmrc* ' : scan.packageManager === 'yarn' ? 'yarn.lock ' : scan.packageManager === 'bun' ? 'bun.lockb ' : ''}./
RUN ${installCmd}

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${hasPrisma ? 'RUN npx prisma generate' : ''}
RUN ${buildCmd}

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=${port}
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE ${port}
CMD ["node", "server.js"]
`;
      }

      const lines = [
        `FROM node:22-alpine`,
        `WORKDIR /app`,
        `COPY package*.json ${scan.packageManager === 'pnpm' ? 'pnpm-lock.yaml .npmrc* ' : scan.packageManager === 'yarn' ? 'yarn.lock ' : scan.packageManager === 'bun' ? 'bun.lockb ' : ''}./`,
        `RUN ${installCmd}`,
        hasPrisma ? `COPY prisma ./prisma` : null,
        hasPrisma ? `RUN npx prisma generate` : null,
        `COPY . .`,
        buildCmd ? `RUN ${buildCmd}` : null,
        `EXPOSE ${port}`,
        `CMD ["sh", "-c", "${startCmd}"]`,
      ];
      return lines.filter(Boolean).join('\n') + '\n';
    }
  }
}

function nodeInstallCmd(pm: ScanResult['packageManager']): string {
  switch (pm) {
    case 'pnpm': return 'corepack enable pnpm && pnpm install --frozen-lockfile';
    case 'yarn': return 'corepack enable yarn && yarn install --frozen-lockfile';
    case 'bun':  return 'npm i -g bun && bun install --frozen-lockfile';
    default:     return 'npm ci';
  }
}

function draftDockerignore(scan: ScanResult): PlanAuthoredFile {
  const content = fallbackDockerignore(scan);
  return {
    path: '.dockerignore',
    lines: content.split('\n').length,
    summary: `keeps the build context lean (excludes node_modules, build artifacts, .git, env files) — paired with the Dockerfile so \`docker build\` doesn't ship your entire repo to the builder`,
    contentPreview: content,
  };
}

/**
 * Per-ecosystem ignore lists. The base block (git, env, IDE, OS junk) is
 * universal; the ecosystem block adds language-specific build artifacts.
 * Keep the AI enricher hands-off here — these are well-known conventions
 * that don't benefit from per-repo tailoring, and getting them wrong (e.g.
 * accidentally ignoring src/) breaks the build silently.
 */
function fallbackDockerignore(scan: ScanResult): string {
  const base = `# Convoy-authored .dockerignore — keeps the build context lean.
# Anything matched here is NOT sent to the builder; without this file
# \`COPY . .\` pulls everything (node_modules, build caches, .git, .env*)
# and the build context upload takes orders of magnitude longer.

# Version control + GitHub
.git
.gitignore
.gitattributes
.github

# Editor + OS
.vscode
.idea
*.swp
*.swo
.DS_Store
Thumbs.db

# Convoy itself
.convoy

# Env + secrets — never bake into images
.env
.env.*
!.env.example
!.env.schema
.envrc

# Logs + temp
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
.cache
tmp
temp

# Dockerfile + this file (don't include in image)
Dockerfile
.dockerignore

# Test + coverage
coverage
.nyc_output
test-results

# Documentation that doesn't ship in the runtime
README.md
CHANGELOG.md
docs
*.md
`;
  switch (scan.ecosystem) {
    case 'python':
      return `${base}
# Python
__pycache__
*.py[cod]
*$py.class
*.egg-info
.pytest_cache
.mypy_cache
.ruff_cache
.tox
.venv
venv
env
build
dist
`;
    case 'go':
      return `${base}
# Go
vendor
`;
    case 'rust':
      return `${base}
# Rust
target
`;
    case 'ruby':
      return `${base}
# Ruby
.bundle
vendor/bundle
log
tmp/cache
`;
    case 'java-jvm':
      return `${base}
# JVM
target
build
.gradle
*.class
*.jar
*.war
`;
    case 'static':
      return `${base}
# Static
node_modules
dist
build
`;
    default:
      // node + node-detected (Next.js, Vite, etc.) — also the default fallback.
      return `${base}
# Node / JS
node_modules
.npm
.pnp
.pnp.*
.yarn

# Build artifacts (Next.js, Vite, Remix, SvelteKit, generic)
.next
.nuxt
.vercel
.netlify
.turbo
.svelte-kit
.cache
out
dist
build

# TypeScript
*.tsbuildinfo
`;
  }
}

function draftFlyToml(scan: ScanResult): PlanAuthoredFile {
  const app = repoName(scan.localPath);
  const port = scan.port ?? 8080;
  const health = scan.healthPath ?? '/health';
  const content = `app = "${app}"
primary_region = "iad"

[build]

[env]
  PORT = "${port}"

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "15s"
    method = "get"
    timeout = "5s"
    path = "${health}"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`;
  return {
    path: 'fly.toml',
    lines: content.split('\n').length,
    summary: `app=${app} · port ${port} · health ${health} · iad · auto-stop`,
    contentPreview: content,
  };
}

function draftRailwayToml(scan: ScanResult): PlanAuthoredFile {
  const start = scan.startCommand ?? 'npm start';
  const health = scan.healthPath ?? '/health';
  const content = `[build]
builder = "dockerfile"

[deploy]
startCommand = "${start}"
healthcheckPath = "${health}"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
`;
  return {
    path: 'railway.toml',
    lines: content.split('\n').length,
    summary: `builder=dockerfile · start="${start}" · health ${health}`,
    contentPreview: content,
  };
}

function draftVercelJson(scan: ScanResult): PlanAuthoredFile {
  const framework = vercelFrameworkSlug(scan.framework);
  const content = framework
    ? `{
  "framework": "${framework}",
  "regions": ["iad1"]
}
`
    : `{
  "regions": ["iad1"]
}
`;
  return {
    path: 'vercel.json',
    lines: content.split('\n').length,
    summary: `framework=${framework ?? 'auto-detect'} · regions=iad1`,
    contentPreview: content,
  };
}

function vercelFrameworkSlug(framework: string | null): string | null {
  switch (framework) {
    case 'next.js':
      return 'nextjs';
    case 'vite':
    case 'astro':
    case 'remix':
    case 'sveltekit':
      return framework;
    default:
      return null;
  }
}

function draftCloudBuild(scan: ScanResult): PlanAuthoredFile {
  const service = repoName(scan.localPath);
  const port = scan.port ?? 8080;
  const content = `steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/${service}:$SHORT_SHA', '.']
  - name: gcr.io/cloud-builders/docker
    args: ['push', 'gcr.io/$PROJECT_ID/${service}:$SHORT_SHA']
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - ${service}
      - --image=gcr.io/$PROJECT_ID/${service}:$SHORT_SHA
      - --region=us-central1
      - --port=${port}
      - --platform=managed
      - --allow-unauthenticated
`;
  return {
    path: 'cloudbuild.yaml',
    lines: content.split('\n').length,
    summary: `docker push · cloud run deploy ${service} · port ${port}`,
    contentPreview: content,
  };
}

/**
 * Files Convoy authors specifically for VPS deploys. The deploy script is
 * the centerpiece — it's idempotent, runs over SSH, and codifies the
 * blue/green slot swap. The optional nginx snippet is only emitted when
 * the operator opts into Convoy-managed nginx; without that opt-in the
 * operator's existing nginx config is left untouched (per the user's
 * direction: "if they have their nginx setup and its fine, dont touch").
 */
function draftVpsFiles(scan: ScanResult): PlanAuthoredFile[] {
  const port = scan.port ?? 8080;
  const health = scan.healthPath ?? '/health';
  const startCmd = scan.startCommand ?? 'npm start';

  // The deploy script is intentionally readable shell — the operator can
  // audit it before granting SSH access. It expects three env vars:
  //   $CONVOY_RELEASE   — short id for this release (slot dir name)
  //   $CONVOY_SLOT      — 'blue' or 'green' (the idle slot to deploy into)
  //   $CONVOY_DEPLOY_ROOT — base dir on the box (e.g. /srv/myapp)
  // It does not touch nginx; the slot swap is a separate runner step.
  const deployScript = `#!/usr/bin/env bash
set -euo pipefail

# Convoy VPS deploy script. Runs on the remote box over SSH at apply time.
# Idempotent. Reads source from \${CONVOY_DEPLOY_ROOT}/source (rsync'd by
# the runner before this script is invoked).

: "\${CONVOY_RELEASE:?missing}"
: "\${CONVOY_SLOT:?missing}"
: "\${CONVOY_DEPLOY_ROOT:?missing}"

cd "\${CONVOY_DEPLOY_ROOT}/source"

IMAGE="convoy-app:\${CONVOY_RELEASE}"
CONTAINER="convoy-\${CONVOY_SLOT}-\${CONVOY_RELEASE}"

# Build on the box — cheapest delivery (only the source diff transfers
# via rsync; subsequent layers reuse the local Docker cache).
docker build -t "\${IMAGE}" .

# Stop any prior container in this slot, then start the new one.
docker rm -f "convoy-\${CONVOY_SLOT}-prev" >/dev/null 2>&1 || true
docker rename "convoy-\${CONVOY_SLOT}-current" "convoy-\${CONVOY_SLOT}-prev" >/dev/null 2>&1 || true

# Slot port mapping: blue=18081, green=18082 (internal only; nginx routes).
SLOT_PORT="$( [ "\${CONVOY_SLOT}" = "blue" ] && echo 18081 || echo 18082 )"

docker run -d \\
  --name "\${CONTAINER}" \\
  --restart unless-stopped \\
  -p "127.0.0.1:\${SLOT_PORT}:${port}" \\
  --env-file "\${CONVOY_DEPLOY_ROOT}/env" \\
  "\${IMAGE}"

docker rename "\${CONTAINER}" "convoy-\${CONVOY_SLOT}-current"

# Health check before signaling success — Convoy waits on this output.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:\${SLOT_PORT}${health}" >/dev/null; then
    echo "convoy.health.ok slot=\${CONVOY_SLOT} release=\${CONVOY_RELEASE}"
    exit 0
  fi
  sleep 1
done
echo "convoy.health.fail slot=\${CONVOY_SLOT} release=\${CONVOY_RELEASE}" >&2
exit 1
`;

  // Optional Compose hint — emitted when the scanner finds a compose file.
  // We don't author one if absent because Compose is workload-specific and
  // a wrong one would be worse than none. Just leave a short README pointer.
  const readme = `# Convoy VPS deploy

Convoy ships your container to your box over SSH. To deploy:

    convoy apply <plan-id> --real-vps --vps-host=user@host --vps-deploy-root=/srv/${repoName(scan.localPath)}

By default Convoy:
  - Rsyncs the source tree to \`<deploy-root>/source\` (only the diff transfers)
  - Builds the image on the box (cheapest — no registry, no full image upload)
  - Runs blue/green: idle slot first, health-checks, then traffic swap
  - Keeps the previous slot running until observe passes (one-step rollback)

Convoy does not touch your nginx config unless you pass \`--vps-manage-nginx\`.
With that flag, Convoy writes \`/etc/nginx/conf.d/convoy-<app>.conf\` and
reloads nginx after each promote — atomic upstream swap, no proxy bounce.

Without it, Convoy assumes your nginx already routes to \`127.0.0.1:18081\`
(blue slot) and \`127.0.0.1:18082\` (green slot); you wire the upstream
weighting yourself.

The deploy script (\`.convoy/vps-deploy.sh\`) is auditable shell — read it
before granting Convoy SSH access.

Logs and metrics: Convoy streams \`docker logs\` for the active slot during
observe, and reads \`${health}\` for health.
`;

  return [
    {
      path: '.convoy/vps-deploy.sh',
      lines: deployScript.split('\n').length,
      summary: `idempotent deploy script — blue/green on slot ports 18081/18082`,
      contentPreview: deployScript,
    },
    {
      path: '.convoy/vps-README.md',
      lines: readme.split('\n').length,
      summary: 'how Convoy ships to your box (auditable, opt-in nginx)',
      contentPreview: readme,
    },
  ];
}

/**
 * Build the operator-facing env contract. Two rules:
 *
 *  1. PORT is included only when the deployment target genuinely needs the
 *     operator to set it. On Fly/Vercel/Cloud Run/Railway the platform injects
 *     PORT itself; surfacing it in .env.schema produces a false blocker at
 *     preflight ("Missing env var PORT") for a value the operator can't and
 *     shouldn't set. Static sites and pure workers don't bind a port at all.
 *  2. If no vars are needed, return null and skip authoring the file. An
 *     empty .env.schema is noise that nudges the operator toward staging
 *     things they don't need to stage.
 */
function draftEnvSchema(scan: ScanResult, platform: Platform): PlanAuthoredFile | null {
  const vars: string[] = [];

  const portBinds = scan.topology !== 'static' && scan.topology !== 'worker';
  if (portBinds && !platformManagesPort(platform)) {
    vars.push(`PORT=${scan.port ?? 8080}`);
  }

  for (const data of scan.dataLayer) {
    if (data.includes('postgres') || data.includes('mysql')) vars.push('DATABASE_URL=');
    if (data.includes('redis')) vars.push('REDIS_URL=');
    if (data.includes('mongo')) vars.push('MONGODB_URL=');
    if (data.includes('elasticsearch')) vars.push('ELASTICSEARCH_URL=');
  }

  if (vars.length === 0) return null;

  const content = `# Convoy drafted this schema from scanner evidence.
# Values are provided at deploy time — nothing sensitive is written here.
${vars.join('\n')}
`;
  return {
    path: '.env.schema',
    lines: content.split('\n').length,
    summary: `${vars.length} required variable${vars.length === 1 ? '' : 's'}`,
    contentPreview: content,
  };
}

function draftConvoyManifest(
  files: PlanAuthoredFile[],
  prefix: (p: string) => string = (p) => p,
): PlanAuthoredFile {
  const manifestPath = prefix('.convoy/manifest.yaml');
  const entries = files
    .filter((f) => f.path !== manifestPath)
    .map((f) => `  - path: ${f.path}\n    authored_by: convoy`)
    .join('\n');
  const content = `# Provenance record. Files here are Convoy-authored and may be
# iterated on autonomously during rehearsal and medic.
# If a developer edits any of these, provenance flips permanently.
version: 1
files:
${entries}
`;
  return {
    path: manifestPath,
    lines: content.split('\n').length,
    summary: `${files.length} files tracked`,
    contentPreview: content,
  };
}
