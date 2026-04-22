import type { PlanAuthorSection, PlanAuthoredFile, PlanReadOnlyFile } from '../core/plan.js';
import type { Platform } from '../core/types.js';
import type { ScanResult } from './scanner.js';

export function draftAuthorSection(scan: ScanResult, platform: Platform): PlanAuthorSection {
  const files: PlanAuthoredFile[] = [];

  if (!scan.hasDockerfile) {
    files.push(draftDockerfile(scan));
  }
  if (platform === 'fly' && scan.existingPlatform !== 'fly') {
    files.push(draftFlyToml(scan));
  }
  if (platform === 'railway' && scan.existingPlatform !== 'railway') {
    files.push(draftRailwayToml(scan));
  }
  if (platform === 'vercel' && scan.existingPlatform !== 'vercel') {
    files.push(draftVercelJson(scan));
  }
  if (platform === 'cloudrun' && scan.existingPlatform !== 'cloudrun') {
    files.push(draftCloudBuild(scan));
  }

  files.push(draftEnvSchema(scan));
  files.push(draftConvoyManifest(files));

  const readOnlyFiles: PlanReadOnlyFile[] = [
    { pattern: 'src/**/*', note: 'developer code — Convoy will not touch' },
    { pattern: 'app/**/*', note: 'developer code — Convoy will not touch' },
    { pattern: 'lib/**/*', note: 'developer code — Convoy will not touch' },
    { pattern: 'tests/**/*', note: 'developer code — Convoy will not touch' },
    { pattern: 'package.json', note: 'dependencies managed by the developer' },
  ];

  return { convoyAuthoredFiles: files, readOnlyFiles };
}

function draftDockerfile(scan: ScanResult): PlanAuthoredFile {
  const nodeVersion = (scan.runtime?.startsWith('node-') ? scan.runtime.slice(5) : '20').split('.')[0] ?? '20';
  const content = scan.language === 'python'
    ? pythonDockerfile()
    : scan.language === 'go'
      ? goDockerfile()
      : scan.language === 'rust'
        ? rustDockerfile()
        : nodeDockerfile(nodeVersion, scan.packageManager ?? 'npm');
  return {
    path: 'Dockerfile',
    lines: content.split('\n').length,
    summary: summarizeDockerfile(scan),
    contentPreview: content,
  };
}

function nodeDockerfile(nodeMajor: string, pm: 'npm' | 'pnpm' | 'yarn'): string {
  const install =
    pm === 'pnpm'
      ? 'RUN corepack enable && pnpm install --frozen-lockfile'
      : pm === 'yarn'
        ? 'RUN corepack enable && yarn install --frozen-lockfile'
        : 'RUN npm ci';
  return `FROM node:${nodeMajor}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json pnpm-lock.yaml* yarn.lock* ./
${install}

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build || true

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
CMD ["npm", "start"]
`;
}

function pythonDockerfile(): string {
  return `FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt pyproject.toml* ./
RUN pip install --no-cache-dir -r requirements.txt || pip install --no-cache-dir .
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

function goDockerfile(): string {
  return `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./...

FROM alpine:3.19
COPY --from=build /out/app /app
EXPOSE 8080
CMD ["/app"]
`;
}

function rustDockerfile(): string {
  return `FROM rust:1.83-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/* /app
EXPOSE 8080
CMD ["/app"]
`;
}

function summarizeDockerfile(scan: ScanResult): string {
  const base =
    scan.language === 'python'
      ? 'python-3.12-slim'
      : scan.language === 'go'
        ? 'golang-1.23-alpine → alpine'
        : scan.language === 'rust'
          ? 'rust-1.83 → debian-bookworm'
          : `node-${scan.runtime?.replace('node-', '') ?? '20'}-alpine multi-stage`;
  return base;
}

function draftFlyToml(scan: ScanResult): PlanAuthoredFile {
  const app = suggestAppName(scan);
  const content = `app = "${app}"
primary_region = "iad"

[build]

[env]
PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "15s"
    method = "get"
    timeout = "5s"
    path = "/health"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`;
  return {
    path: 'fly.toml',
    lines: content.split('\n').length,
    summary: `fly app ${app} · iad · auto-stop · health /health`,
    contentPreview: content,
  };
}

function draftRailwayToml(scan: ScanResult): PlanAuthoredFile {
  const content = `[build]
builder = "dockerfile"

[deploy]
startCommand = "${scan.startCommand ?? 'npm start'}"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
`;
  return {
    path: 'railway.toml',
    lines: content.split('\n').length,
    summary: 'railway via Dockerfile · health /health',
    contentPreview: content,
  };
}

function draftVercelJson(_scan: ScanResult): PlanAuthoredFile {
  const content = `{
  "framework": "nextjs",
  "regions": ["iad1"]
}
`;
  return {
    path: 'vercel.json',
    lines: content.split('\n').length,
    summary: 'vercel · framework pinned · region iad1',
    contentPreview: content,
  };
}

function draftCloudBuild(_scan: ScanResult): PlanAuthoredFile {
  const content = `steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/app:$SHORT_SHA', '.']
  - name: gcr.io/cloud-builders/docker
    args: ['push', 'gcr.io/$PROJECT_ID/app:$SHORT_SHA']
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - app
      - --image=gcr.io/$PROJECT_ID/app:$SHORT_SHA
      - --region=us-central1
      - --platform=managed
      - --allow-unauthenticated
`;
  return {
    path: 'cloudbuild.yaml',
    lines: content.split('\n').length,
    summary: 'cloud build · docker push · cloud run deploy',
    contentPreview: content,
  };
}

function draftEnvSchema(scan: ScanResult): PlanAuthoredFile {
  const vars: string[] = ['PORT=8080'];
  for (const data of scan.dataLayer) {
    if (data.includes('postgres')) vars.push('DATABASE_URL=');
    if (data.includes('redis')) vars.push('REDIS_URL=');
    if (data.includes('mongo')) vars.push('MONGODB_URL=');
  }
  const content = `# Convoy drafted this schema from scanner evidence.
# Values are provided at deploy time — nothing sensitive is written here.
${vars.join('\n')}
`;
  return {
    path: '.env.schema',
    lines: content.split('\n').length,
    summary: `${vars.length} required variables`,
    contentPreview: content,
  };
}

function draftConvoyManifest(files: PlanAuthoredFile[]): PlanAuthoredFile {
  const entries = files
    .filter((f) => f.path !== '.convoy/manifest.yaml')
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
    path: '.convoy/manifest.yaml',
    lines: content.split('\n').length,
    summary: `${files.length - 0} files tracked`,
    contentPreview: content,
  };
}

function suggestAppName(scan: ScanResult): string {
  const leaf = scan.localPath.split('/').filter(Boolean).pop() ?? 'convoy-app';
  return leaf
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'convoy-app';
}
