import type { PlanAuthorSection, PlanAuthoredFile } from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { repoName, type PackageManager, type ScanResult } from './scanner.js';

export function draftAuthorSection(scan: ScanResult, platform: Platform): PlanAuthorSection {
  const files: PlanAuthoredFile[] = [];

  // Vercel builds from source natively — a Dockerfile is misleading noise.
  // Everyone else needs a container image.
  const platformNeedsDockerfile = platform !== 'vercel';
  if (platformNeedsDockerfile && !scan.hasDockerfile) {
    files.push(draftDockerfile(scan, platform));
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

  return { convoyAuthoredFiles: files };
}

function usesPrisma(scan: ScanResult): boolean {
  return scan.dataLayer.some((d) => d.includes('prisma')) ||
    scan.topLevelDirs.includes('prisma') ||
    scan.topLevelFiles.includes('prisma.config.ts');
}

function draftDockerfile(scan: ScanResult, _platform: Platform): PlanAuthoredFile {
  const content =
    scan.ecosystem === 'python'
      ? pythonDockerfile(scan)
      : scan.ecosystem === 'go'
        ? goDockerfile()
        : scan.ecosystem === 'rust'
          ? rustDockerfile()
          : scan.ecosystem === 'ruby'
            ? rubyDockerfile()
            : scan.ecosystem === 'java-jvm'
              ? jvmDockerfile()
              : scan.ecosystem === 'static'
                ? staticDockerfile()
                : draftNodeDockerfile(scan);
  return {
    path: 'Dockerfile',
    lines: content.split('\n').length,
    summary: summarizeDockerfile(scan),
    contentPreview: content,
  };
}

function draftNodeDockerfile(scan: ScanResult): string {
  const nodeMajor = nodeMajorFromRuntime(scan.runtime);
  const pm = scan.packageManager ?? 'npm';
  const port = scan.port ?? 3000;
  const hasPrisma = usesPrisma(scan);

  if (scan.framework === 'next.js') {
    return nextjsStandaloneDockerfile(nodeMajor, pm, port, hasPrisma);
  }
  if (scan.framework === 'vite' || scan.framework === 'astro') {
    return staticBuildDockerfile(nodeMajor, pm, scan.buildCommand);
  }
  if (scan.framework === 'sveltekit' || scan.framework === 'nuxt' || scan.framework === 'remix') {
    return nextjsLikeDockerfile(nodeMajor, pm, port, scan.startCommand, hasPrisma);
  }
  return nodeServerDockerfile(nodeMajor, pm, port, scan.buildCommand, scan.startCommand, hasPrisma);
}

function pmRun(pm: PackageManager): string {
  return pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun' : 'npm';
}

function installStep(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'RUN corepack enable && pnpm install --frozen-lockfile';
    case 'yarn':
      return 'RUN corepack enable && yarn install --frozen-lockfile';
    case 'bun':
      return 'RUN npm i -g bun && bun install --frozen-lockfile';
    default:
      return 'RUN npm ci';
  }
}

function copyLockfiles(): string {
  return 'COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* bun.lockb* ./';
}

function nextjsStandaloneDockerfile(
  nodeMajor: string,
  pm: PackageManager,
  port: number,
  hasPrisma: boolean,
): string {
  const pmCmd = pmRun(pm);
  const prismaStep = hasPrisma ? `RUN npx prisma generate\n` : '';
  return `# Next.js standalone output — smallest runtime image.
# Requires \`output: 'standalone'\` in next.config.{js,mjs,ts}.
FROM node:${nodeMajor}-alpine AS deps
WORKDIR /app
${copyLockfiles()}
${installStep(pm)}

FROM node:${nodeMajor}-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prismaStep}RUN ${pmCmd} run build

FROM node:${nodeMajor}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE ${port}
CMD ["node", "server.js"]
`;
}

function nextjsLikeDockerfile(
  nodeMajor: string,
  pm: PackageManager,
  port: number,
  start: string | null,
  hasPrisma: boolean,
): string {
  const pmCmd = pmRun(pm);
  const prismaStep = hasPrisma ? `RUN npx prisma generate\n` : '';
  const cmd = start ? `CMD ["${pmCmd}", "start"]` : `CMD ["${pmCmd}", "run", "start"]`;
  return `FROM node:${nodeMajor}-alpine AS base
WORKDIR /app

FROM base AS deps
${copyLockfiles()}
${installStep(pm)}

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prismaStep}RUN ${pmCmd} run build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
${cmd}
`;
}

function staticBuildDockerfile(nodeMajor: string, pm: PackageManager, build: string | null): string {
  const pmCmd = pmRun(pm);
  const buildStep = build ? `RUN ${pmCmd} run build` : `RUN ${pmCmd} run build`;
  return `# Static build — served by nginx.
FROM node:${nodeMajor}-alpine AS build
WORKDIR /app
${copyLockfiles()}
${installStep(pm)}
COPY . .
${buildStep}

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
`;
}

function nodeServerDockerfile(
  nodeMajor: string,
  pm: PackageManager,
  port: number,
  build: string | null,
  start: string | null,
  hasPrisma: boolean,
): string {
  const pmCmd = pmRun(pm);
  const buildStep = build ? `RUN ${pmCmd} run build` : `# no build script detected`;
  const prismaStep = hasPrisma ? `RUN npx prisma generate\n` : '';
  const cmd = start
    ? `CMD ["${pmCmd}", "start"]`
    : build
      ? `CMD ["node", "dist/index.js"]`
      : `CMD ["node", "index.js"]`;
  return `FROM node:${nodeMajor}-alpine AS base
WORKDIR /app

FROM base AS deps
${copyLockfiles()}
${installStep(pm)}

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prismaStep}${buildStep}

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
${cmd}
`;
}

function nodeMajorFromRuntime(runtime: string | null): string {
  if (!runtime || !runtime.startsWith('node-')) return '20';
  const match = runtime.match(/\d+/);
  return match?.[0] ?? '20';
}


function pythonDockerfile(scan: ScanResult): string {
  const startFromScripts = scan.scripts['start'] ?? null;
  const cmd = startFromScripts
    ? `CMD ["sh", "-c", "${startFromScripts.replace(/"/g, '\\"')}"]`
    : scan.framework === 'fastapi'
      ? 'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]'
      : scan.framework === 'django'
        ? 'CMD ["gunicorn", "--bind", "0.0.0.0:8080", "app.wsgi"]'
        : 'CMD ["python", "main.py"]';
  const install = scan.packageManager === 'poetry'
    ? 'RUN pip install poetry && poetry install --no-root --only main'
    : scan.packageManager === 'uv'
      ? 'RUN pip install uv && uv sync --frozen'
      : 'RUN pip install --no-cache-dir -r requirements.txt || pip install --no-cache-dir .';
  return `FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml* requirements*.txt Pipfile* poetry.lock* uv.lock* ./
${install}
COPY . .
ENV PORT=8080
EXPOSE 8080
${cmd}
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

function rubyDockerfile(): string {
  return `FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["bundle", "exec", "rails", "server", "-p", "8080", "-b", "0.0.0.0"]
`;
}

function jvmDockerfile(): string {
  return `FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
RUN ./gradlew bootJar || ./mvnw package -DskipTests

FROM eclipse-temurin:21-jre
COPY --from=build /src/build/libs/*.jar /app/app.jar
EXPOSE 8080
CMD ["java", "-jar", "/app/app.jar"]
`;
}

function staticDockerfile(): string {
  return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
}

function summarizeDockerfile(scan: ScanResult): string {
  switch (scan.ecosystem) {
    case 'python':
      return `python:3.12-slim · ${scan.packageManager ?? 'pip'} install · ${scan.framework ?? 'generic'}`;
    case 'go':
      return 'golang:1.23-alpine → alpine (scratch-style)';
    case 'rust':
      return 'rust:1.83-slim → debian-bookworm';
    case 'ruby':
      return 'ruby:3.3-slim · bundle · rails server';
    case 'java-jvm':
      return 'eclipse-temurin 21 · gradle/maven build';
    case 'static':
      return 'nginx:alpine serving static assets';
    default: {
      const major = nodeMajorFromRuntime(scan.runtime);
      const pm = scan.packageManager ?? 'npm';
      if (scan.framework === 'next.js') {
        return `node:${major}-alpine · ${pm} · Next.js standalone${usesPrisma(scan) ? ' + prisma generate' : ''}`;
      }
      if (scan.framework === 'vite' || scan.framework === 'astro') {
        return `node:${major}-alpine build → nginx:alpine static serve`;
      }
      if (scan.framework) {
        return `node:${major}-alpine · ${pm} · ${scan.framework}${usesPrisma(scan) ? ' + prisma generate' : ''}`;
      }
      return `node:${major}-alpine · ${pm} · server (no framework detected)`;
    }
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
  const content = `{
  "framework": "${scan.framework === 'next.js' ? 'nextjs' : 'auto'}",
  "regions": ["iad1"]
}
`;
  return {
    path: 'vercel.json',
    lines: content.split('\n').length,
    summary: `framework=${scan.framework ?? 'auto'} · regions=iad1`,
    contentPreview: content,
  };
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

function draftEnvSchema(scan: ScanResult): PlanAuthoredFile {
  const vars: string[] = [`PORT=${scan.port ?? 8080}`];
  for (const data of scan.dataLayer) {
    if (data.includes('postgres')) vars.push('DATABASE_URL=');
    if (data.includes('mysql')) vars.push('DATABASE_URL=');
    if (data.includes('redis')) vars.push('REDIS_URL=');
    if (data.includes('mongo')) vars.push('MONGODB_URL=');
    if (data.includes('elasticsearch')) vars.push('ELASTICSEARCH_URL=');
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
    summary: `${files.length} files tracked`,
    contentPreview: content,
  };
}
