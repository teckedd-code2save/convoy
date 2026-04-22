import type { PlanAuthorSection, PlanAuthoredFile, PlanReadOnlyEntry } from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { repoName, type PackageManager, type ScanResult } from './scanner.js';

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

  const readOnlyPaths = readOnlyFromScan(scan);
  const note = readOnlyPaths.length === 0
    ? 'Repo appears empty of obvious developer code at the root; Convoy will only create the files above.'
    : 'The paths above are whatever Convoy observed at your repo root. Convoy will read them for context and never modify them.';

  return { convoyAuthoredFiles: files, readOnlyPaths, note };
}

function readOnlyFromScan(scan: ScanResult): PlanReadOnlyEntry[] {
  const entries: PlanReadOnlyEntry[] = [];
  const seen = new Set<string>();

  for (const dir of scan.sourceDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    entries.push({
      path: `${dir}/`,
      kind: 'source-dir',
      note: `developer code — Convoy reads, never writes`,
    });
  }
  for (const dir of scan.testDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    entries.push({
      path: dir.includes(' ') ? dir : `${dir}/`,
      kind: 'test-dir',
      note: 'developer tests — Convoy reads for rehearsal validation, never writes',
    });
  }

  const manifestFiles: { name: string; note: string }[] = [
    { name: 'package.json', note: 'dependencies managed by the developer' },
    { name: 'pnpm-lock.yaml', note: 'lockfile — developer-authored' },
    { name: 'yarn.lock', note: 'lockfile — developer-authored' },
    { name: 'package-lock.json', note: 'lockfile — developer-authored' },
    { name: 'pyproject.toml', note: 'Python project manifest — developer-authored' },
    { name: 'requirements.txt', note: 'Python requirements — developer-authored' },
    { name: 'Pipfile', note: 'Python env manifest — developer-authored' },
    { name: 'go.mod', note: 'Go module manifest — developer-authored' },
    { name: 'go.sum', note: 'Go checksum file — developer-authored' },
    { name: 'Cargo.toml', note: 'Rust manifest — developer-authored' },
    { name: 'Cargo.lock', note: 'Rust lockfile — developer-authored' },
    { name: 'Gemfile', note: 'Ruby manifest — developer-authored' },
    { name: 'Gemfile.lock', note: 'Ruby lockfile — developer-authored' },
    { name: 'composer.json', note: 'PHP manifest — developer-authored' },
    { name: 'mix.exs', note: 'Elixir manifest — developer-authored' },
    { name: 'pubspec.yaml', note: 'Dart manifest — developer-authored' },
    { name: 'pom.xml', note: 'Maven manifest — developer-authored' },
    { name: 'build.gradle', note: 'Gradle manifest — developer-authored' },
    { name: 'build.gradle.kts', note: 'Gradle Kotlin manifest — developer-authored' },
    { name: 'tsconfig.json', note: 'TypeScript config — developer-authored' },
    { name: '.eslintrc.json', note: 'ESLint config — developer-authored' },
    { name: '.prettierrc', note: 'Prettier config — developer-authored' },
  ];
  for (const { name, note } of manifestFiles) {
    if (scan.topLevelFiles.includes(name)) {
      entries.push({ path: name, kind: 'manifest', note });
    }
  }

  if (scan.hasDockerfile) {
    entries.push({ path: 'Dockerfile', kind: 'config', note: 'developer-authored — Convoy will use it as-is' });
  }

  if (scan.topLevelFiles.some((f) => /^readme/i.test(f))) {
    const readme = scan.topLevelFiles.find((f) => /^readme/i.test(f))!;
    entries.push({ path: readme, kind: 'other', note: 'Convoy reads it to understand the project' });
  }

  if (scan.topLevelFiles.includes('docker-compose.yml') || scan.topLevelFiles.includes('docker-compose.yaml')) {
    const name = scan.topLevelFiles.find((f) => f === 'docker-compose.yml' || f === 'docker-compose.yaml')!;
    entries.push({
      path: name,
      kind: 'config',
      note: 'local dev orchestration — Convoy reads for data-layer hints, never writes',
    });
  }

  const commonRead = ['prisma', 'migrations', 'db', 'config', 'public', 'static', 'assets'];
  for (const dir of scan.topLevelDirs) {
    if (seen.has(dir)) continue;
    if (commonRead.includes(dir)) {
      seen.add(dir);
      entries.push({
        path: `${dir}/`,
        kind: 'other',
        note: 'supporting asset directory — read-only',
      });
    }
  }

  return entries;
}

function draftDockerfile(scan: ScanResult): PlanAuthoredFile {
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
                : nodeDockerfile(nodeMajorFromRuntime(scan.runtime), scan.packageManager ?? 'npm', scan.port ?? 8080, scan.buildCommand, scan.startCommand);
  return {
    path: 'Dockerfile',
    lines: content.split('\n').length,
    summary: summarizeDockerfile(scan),
    contentPreview: content,
  };
}

function nodeMajorFromRuntime(runtime: string | null): string {
  if (!runtime || !runtime.startsWith('node-')) return '20';
  const match = runtime.match(/\d+/);
  return match?.[0] ?? '20';
}

function nodeDockerfile(
  nodeMajor: string,
  pm: PackageManager,
  port: number,
  build: string | null,
  start: string | null,
): string {
  const install =
    pm === 'pnpm'
      ? 'RUN corepack enable && pnpm install --frozen-lockfile'
      : pm === 'yarn'
        ? 'RUN corepack enable && yarn install --frozen-lockfile'
        : pm === 'bun'
          ? 'RUN npm i -g bun && bun install'
          : 'RUN npm ci';
  const buildLine = build ? `RUN ${pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun' : 'npm'} run build` : '# no build script detected';
  const startLine = start
    ? `CMD ["${pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun' : 'npm'}", "start"]`
    : `CMD ["node", "dist/index.js"]`;
  return `FROM node:${nodeMajor}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json pnpm-lock.yaml* yarn.lock* bun.lockb* ./
${install}

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${buildLine}

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /app ./
EXPOSE ${port}
${startLine}
`;
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
      return `node:${major}-alpine · ${scan.packageManager ?? 'npm'} · multi-stage`;
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
