import type { PlanAuthorSection, PlanAuthoredFile } from '../core/plan.js';
import type { Platform } from '../core/types.js';

import { repoName, type ScanResult } from './scanner.js';

/**
 * The deterministic author produces a skeleton of what Convoy intends to write,
 * with sensible fallback content for each file. The enricher can replace the
 * contentPreview with AI-generated content tailored to the specific repo —
 * particularly for Dockerfiles where the dimensionality of choices is too high
 * to express as deterministic templates.
 */
export function draftAuthorSection(scan: ScanResult, platform: Platform): PlanAuthorSection {
  const files: PlanAuthoredFile[] = [];

  // Vercel builds natively from source. A Dockerfile there is confusing noise.
  const containerBased = platform !== 'vercel';
  if (containerBased && !scan.hasDockerfile) {
    files.push(draftDockerfile(scan, platform));
    // A Dockerfile without a .dockerignore means `COPY . .` pulls
    // node_modules, .next, .git, .env*, build caches, IDE state — everything.
    // The build context balloons, the upload to Depot/buildkit takes minutes
    // to tens of minutes, and the auth token expires before the builder
    // finishes. We learned this from a 45-minute Fly build that died on
    // "Invalid token". Author them as a pair, always.
    if (!scan.hasDockerignore) {
      files.push(draftDockerignore(scan));
    }
  }

  if (platform === 'fly' && scan.existingPlatform !== 'fly') files.push(draftFlyToml(scan));
  if (platform === 'railway' && scan.existingPlatform !== 'railway') files.push(draftRailwayToml(scan));
  if (platform === 'vercel' && scan.existingPlatform !== 'vercel') files.push(draftVercelJson(scan));
  if (platform === 'cloudrun' && scan.existingPlatform !== 'cloudrun') files.push(draftCloudBuild(scan));

  files.push(draftEnvSchema(scan));
  files.push(draftConvoyManifest(files));

  return { convoyAuthoredFiles: files };
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
 * Deliberately simple fallback. One template per ecosystem. When ANTHROPIC_API_KEY
 * is set, the enricher overwrites this with a Dockerfile tailored to the actual
 * repo (framework, package manager, prisma, port, startup, etc.).
 */
function fallbackDockerfile(scan: ScanResult): string {
  switch (scan.ecosystem) {
    case 'python':
      return `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt || pip install --no-cache-dir .
EXPOSE 8080
CMD ["python", "main.py"]
`;
    case 'go':
      return `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./...

FROM alpine:3.19
COPY --from=build /out/app /app
EXPOSE 8080
CMD ["/app"]
`;
    case 'rust':
      return `FROM rust:1.83-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/* /app
EXPOSE 8080
CMD ["/app"]
`;
    case 'ruby':
      return `FROM ruby:3.3-slim
WORKDIR /app
COPY . .
RUN bundle install --without development test
EXPOSE 8080
CMD ["bundle", "exec", "rackup", "-p", "8080", "-o", "0.0.0.0"]
`;
    case 'java-jvm':
      return `FROM eclipse-temurin:21 AS build
WORKDIR /src
COPY . .
RUN ./gradlew bootJar || ./mvnw package -DskipTests

FROM eclipse-temurin:21-jre
COPY --from=build /src/build/libs/*.jar /app/app.jar
EXPOSE 8080
CMD ["java", "-jar", "/app/app.jar"]
`;
    case 'static':
      return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
    default:
      return `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci
EXPOSE 8080
CMD ["npm", "start"]
`;
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
    if (data.includes('postgres') || data.includes('mysql')) vars.push('DATABASE_URL=');
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
