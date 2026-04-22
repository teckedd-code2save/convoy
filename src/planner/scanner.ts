import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Platform } from '../core/types.js';

export interface ScanResult {
  localPath: string;
  language: string | null;
  runtime: string | null;
  framework: string | null;
  topology: 'web' | 'web+worker' | 'worker' | 'static' | 'api' | 'unknown';
  dataLayer: string[];
  existingPlatform: Platform | null;
  hasDockerfile: boolean;
  hasCi: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | null;
  startCommand: string | null;
  healthPath: string | null;
  evidence: string[];
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

/**
 * Walk a local repository and emit a structured ScanResult. Reads only —
 * never mutates the target directory.
 */
export function scanRepository(localPath: string): ScanResult {
  if (!existsSync(localPath)) {
    throw new Error(`Path does not exist: ${localPath}`);
  }
  const stat = statSync(localPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${localPath}`);
  }

  const files = listFiles(localPath, localPath, 0, 3);
  const evidence: string[] = [];

  const result: ScanResult = {
    localPath,
    language: null,
    runtime: null,
    framework: null,
    topology: 'unknown',
    dataLayer: [],
    existingPlatform: detectExistingPlatform(files, evidence),
    hasDockerfile: files.includes('Dockerfile'),
    hasCi: files.some((f) => f.startsWith('.github/workflows/')),
    packageManager: null,
    startCommand: null,
    healthPath: null,
    evidence,
  };

  const packageJson = tryReadJson(localPath, 'package.json');
  if (packageJson) {
    result.language = 'typescript-or-javascript';
    result.runtime = detectNodeVersion(packageJson) ?? 'node';
    result.framework = detectJsFramework(packageJson);
    result.packageManager = detectPackageManager(files);
    result.startCommand = typeof packageJson['scripts']?.start === 'string' ? packageJson['scripts'].start : null;
    evidence.push(`package.json · name=${String(packageJson['name'] ?? 'unknown')}`);
  }

  if (files.includes('pyproject.toml') || files.includes('requirements.txt')) {
    result.language = 'python';
    result.runtime = 'python';
    if (files.includes('pyproject.toml')) evidence.push('pyproject.toml');
    if (files.includes('requirements.txt')) evidence.push('requirements.txt');
  }

  if (files.includes('go.mod')) {
    result.language = 'go';
    result.runtime = 'go';
    evidence.push('go.mod');
  }

  if (files.includes('Cargo.toml')) {
    result.language = 'rust';
    result.runtime = 'rust';
    evidence.push('Cargo.toml');
  }

  result.topology = inferTopology(files, packageJson, evidence);
  result.dataLayer = detectDataLayer(files, packageJson, evidence);

  if (result.hasDockerfile) evidence.push('Dockerfile present');
  if (result.hasCi) evidence.push('.github/workflows present');

  return result;
}

function listFiles(base: string, dir: string, depth: number, maxDepth: number): string[] {
  const out: string[] = [];
  if (depth > maxDepth) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(base, abs);
    if (st.isDirectory()) {
      out.push(...listFiles(base, abs, depth + 1, maxDepth));
    } else {
      out.push(rel.split('\\').join('/'));
    }
  }
  return out;
}

function tryReadJson(base: string, relPath: string): Record<string, any> | null {
  try {
    const raw = readFileSync(join(base, relPath), 'utf8');
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return null;
  }
}

function detectNodeVersion(pkg: Record<string, any>): string | null {
  const engines = pkg['engines'];
  if (engines && typeof engines === 'object' && typeof engines.node === 'string') {
    return `node-${engines.node.replace(/[^\d.]/g, '')}`;
  }
  return null;
}

function detectJsFramework(pkg: Record<string, any>): string | null {
  const deps: Record<string, unknown> = {
    ...(pkg['dependencies'] ?? {}),
    ...(pkg['devDependencies'] ?? {}),
  };
  if (deps['next']) return 'next.js';
  if (deps['nuxt']) return 'nuxt';
  if (deps['@remix-run/node']) return 'remix';
  if (deps['express']) return 'express';
  if (deps['fastify']) return 'fastify';
  if (deps['@nestjs/core']) return 'nest.js';
  if (deps['svelte']) return 'svelte';
  if (deps['astro']) return 'astro';
  return null;
}

function detectPackageManager(files: string[]): 'npm' | 'pnpm' | 'yarn' | null {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json')) return 'npm';
  return null;
}

function detectExistingPlatform(files: string[], evidence: string[]): Platform | null {
  if (files.includes('fly.toml')) {
    evidence.push('fly.toml present');
    return 'fly';
  }
  if (files.includes('railway.toml') || files.includes('railway.json')) {
    evidence.push('railway config present');
    return 'railway';
  }
  if (files.includes('vercel.json')) {
    evidence.push('vercel.json present');
    return 'vercel';
  }
  if (files.includes('cloudbuild.yaml') || files.includes('cloudbuild.yml')) {
    evidence.push('cloudbuild present');
    return 'cloudrun';
  }
  return null;
}

function inferTopology(
  files: string[],
  pkg: Record<string, any> | null,
  evidence: string[],
): ScanResult['topology'] {
  const hasWorker =
    files.some((f) => /worker|queue|job/i.test(f)) ||
    (pkg ? 'bullmq' in (pkg['dependencies'] ?? {}) : false);

  if (pkg && ('next' in (pkg['dependencies'] ?? {}))) {
    if (hasWorker) {
      evidence.push('next.js + worker signal');
      return 'web+worker';
    }
    evidence.push('next.js → web');
    return 'web';
  }

  if (files.includes('index.html') && !pkg) {
    evidence.push('static site (index.html, no package.json)');
    return 'static';
  }

  if (hasWorker) return 'web+worker';
  if (pkg) return 'web';
  return 'unknown';
}

function detectDataLayer(
  files: string[],
  pkg: Record<string, any> | null,
  evidence: string[],
): string[] {
  const found: string[] = [];
  const deps: Record<string, unknown> = pkg
    ? { ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}) }
    : {};

  if ('prisma' in deps || '@prisma/client' in deps) {
    found.push('postgres-via-prisma');
    evidence.push('prisma detected');
  }
  if ('pg' in deps) found.push('postgres');
  if ('mysql' in deps || 'mysql2' in deps) found.push('mysql');
  if ('mongodb' in deps || 'mongoose' in deps) found.push('mongodb');
  if ('redis' in deps || 'ioredis' in deps) found.push('redis');
  if (files.includes('docker-compose.yml') || files.includes('docker-compose.yaml')) {
    const raw = (() => {
      try {
        return readFileSync(join(files[0] ?? '', 'docker-compose.yml'), 'utf8');
      } catch {
        return '';
      }
    })();
    if (/postgres/i.test(raw) && !found.includes('postgres')) found.push('postgres');
    if (/redis/i.test(raw) && !found.includes('redis')) found.push('redis');
  }
  return Array.from(new Set(found));
}
