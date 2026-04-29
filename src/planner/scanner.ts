import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import type { Platform } from '../core/types.js';

export type Ecosystem =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'swift'
  | 'kotlin-android'
  | 'java-jvm'
  | 'ruby'
  | 'php'
  | 'dotnet'
  | 'elixir'
  | 'dart-flutter'
  | 'static'
  | 'mixed'
  | 'unknown';

export type Deployability =
  | 'deployable-web-service'
  | 'deployable-static-site'
  | 'not-cloud-deployable'
  | 'ambiguous';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'cargo'
  | 'go-mod'
  | 'gem'
  | 'composer'
  | 'nuget'
  | 'mix'
  | 'pub'
  | null;

export type MonorepoTool = 'turbo' | 'nx' | 'pnpm-workspaces' | 'lerna' | 'yarn-workspaces' | null;

export interface ScanRisk {
  level: 'info' | 'warn' | 'block';
  message: string;
  evidence?: string;
}

export interface SubService {
  name: string;
  path: string;
  ecosystem: Ecosystem;
  framework: string | null;
  manifest: string;
}

export interface ScanResult {
  localPath: string;
  scanRoot: string;
  ecosystem: Ecosystem;
  language: string | null;
  runtime: string | null;
  framework: string | null;
  topology: 'web' | 'web+worker' | 'worker' | 'static' | 'api' | 'unknown';
  dataLayer: string[];
  existingPlatform: Platform | null;
  hasDockerfile: boolean;
  hasDockerignore: boolean;
  dockerfileBase: string | null;
  hasCi: boolean;
  packageManager: PackageManager;
  startCommand: string | null;
  buildCommand: string | null;
  devCommand: string | null;
  testCommand: string | null;
  healthPath: string | null;
  port: number | null;
  scripts: Record<string, string>;
  topLevelDirs: string[];
  topLevelFiles: string[];
  sourceDirs: string[];
  testDirs: string[];
  isMonorepo: boolean;
  monorepoTool: MonorepoTool;
  workspaces: string[];
  subServices: SubService[];
  readmeTitle: string | null;
  readmeFirstPara: string | null;
  deployability: Deployability;
  deployabilityReason: string;
  evidence: string[];
  risks: ScanRisk[];
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.vercel',
  '.svelte-kit',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.DerivedData',
  'DerivedData',
  '.build',
  'Pods',
  '.next',
  '.cache',
]);

export interface ScanOptions {
  workspace?: string;
}

export interface PlatformHints {
  existingPlatform: Platform | null;
  hasDockerfile: boolean;
  hasCi: boolean;
  packageManager: PackageManager;
}

export interface AuthHints {
  requiresProjectBinding: boolean;
  candidateClis: string[];
  configFiles: string[];
}

export interface SecretsHints {
  expectedKeys: string[];
  sources: string[];
}

export interface ServiceNode {
  id: string;
  name: string;
  path: string;
  role: 'infra' | 'backend' | 'worker' | 'frontend';
  ecosystem: Ecosystem;
  framework: string | null;
  topology: ScanResult['topology'];
  dataLayer: string[];
  buildCommand: string | null;
  startCommand: string | null;
  testCommand: string | null;
  healthPath: string | null;
  port: number | null;
  existingPlatform: Platform | null;
  evidence: string[];
  risks: ScanRisk[];
  dependsOn: string[];
  platformHints: PlatformHints;
  authHints: AuthHints;
  secretsHints: SecretsHints;
  scan: ScanResult;
}

export interface ServiceGraph {
  localPath: string;
  scanRoot: string;
  workspace: string | null;
  isMonorepo: boolean;
  monorepoTool: MonorepoTool;
  readmeTitle: string | null;
  readmeFirstPara: string | null;
  topLevelDirs: string[];
  topLevelFiles: string[];
  evidence: string[];
  risks: ScanRisk[];
  nodes: ServiceNode[];
}

export function scanRepository(localPath: string, opts: ScanOptions = {}): ScanResult {
  if (!existsSync(localPath)) {
    throw new Error(`Path does not exist: ${localPath}`);
  }
  const stat = statSync(localPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${localPath}`);
  }

  const rootPath = localPath;
  const scanPath = opts.workspace ? join(localPath, opts.workspace) : localPath;
  if (opts.workspace && !existsSync(scanPath)) {
    throw new Error(`Workspace path does not exist: ${scanPath}`);
  }

  const topEntries = readTopLevel(scanPath);
  const { topLevelDirs, topLevelFiles } = topEntries;
  const allFiles = listFiles(scanPath, scanPath, 0, 4);
  const evidence: string[] = [];
  const risks: ScanRisk[] = [];

  const packageJson = tryReadJson(scanPath, 'package.json');
  const scripts: Record<string, string> =
    packageJson && typeof packageJson['scripts'] === 'object' && packageJson['scripts']
      ? Object.fromEntries(
          Object.entries(packageJson['scripts'] as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string',
          ) as [string, string][],
        )
      : {};

  let ecosystem = detectEcosystem(topLevelFiles, topLevelDirs, allFiles, evidence);

  // Always probe for sub-services when the root looks like a workspace holder
  // (pnpm-workspace.yaml / turbo.json / nx.json / lerna.json / package.json
  // with workspaces[] or apps|packages|services dirs). Also run when
  // ecosystem came back unknown so we can promote a child's ecosystem.
  const hasWorkspaceMarker =
    topLevelFiles.includes('pnpm-workspace.yaml') ||
    topLevelFiles.includes('turbo.json') ||
    topLevelFiles.includes('nx.json') ||
    topLevelFiles.includes('lerna.json') ||
    (packageJson && Array.isArray(packageJson['workspaces'])) ||
    topLevelDirs.includes('apps') ||
    topLevelDirs.includes('packages') ||
    topLevelDirs.includes('services');

  const subServices = hasWorkspaceMarker || ecosystem === 'unknown'
    ? detectSubServices(scanPath, topLevelDirs, evidence)
    : [];

  // If root has no ecosystem but child dirs do, promote the first child's
  // ecosystem so the plan isn't useless. Record a monorepo/multi-service
  // risk so the picker can warn.
  if (ecosystem === 'unknown' && subServices.length > 0) {
    ecosystem = subServices[0]!.ecosystem;
    evidence.push(`inferred ecosystem from ${subServices[0]!.path}/${subServices[0]!.manifest}`);
  }

  const { language, runtime } = detectLanguageAndRuntime(ecosystem, packageJson);
  const framework = detectFramework(ecosystem, packageJson, topLevelFiles, allFiles) ??
    (subServices[0]?.framework ?? null);
  const packageManager = detectPackageManager(ecosystem, topLevelFiles);
  const { isMonorepo, monorepoTool, workspaces } = detectMonorepo(topLevelFiles, packageJson, subServices);

  const existingPlatform = detectExistingPlatform(topLevelFiles, evidence);
  const hasDockerfile = topLevelFiles.includes('Dockerfile');
  const hasDockerignore = topLevelFiles.includes('.dockerignore');
  const dockerfileBase = hasDockerfile ? readDockerfileBase(scanPath) : null;
  const hasCi = topLevelDirs.includes('.github') && allFiles.some((f) => f.startsWith('.github/workflows/'));

  const topology = inferTopology(ecosystem, framework, allFiles, packageJson);
  const dataLayer = detectDataLayer(scanPath, allFiles, packageJson, evidence);
  const sourceDirs = detectSourceDirs(ecosystem, topLevelDirs);
  const testDirs = detectTestDirs(topLevelDirs, allFiles);

  const startCommand = scripts['start'] ?? scripts['serve'] ?? null;
  const buildCommand = scripts['build'] ?? null;
  const devCommand = scripts['dev'] ?? scripts['develop'] ?? null;
  const testCommand = scripts['test'] ?? null;

  const healthPath = detectHealthPath(scanPath, allFiles);
  const port = detectPort(packageJson, scripts, scanPath, allFiles);

  const readme = readReadmeExcerpt(scanPath, topLevelFiles);

  const { deployability, deployabilityReason } = determineDeployability(
    ecosystem,
    topology,
    framework,
    topLevelFiles,
    isMonorepo,
  );

  collectRisks(
    risks,
    ecosystem,
    framework,
    dataLayer,
    hasDockerfile,
    healthPath,
    testDirs,
    scripts,
    isMonorepo,
  );
  if (subServices.length > 1 && !opts.workspace) {
    risks.push({
      level: 'warn',
      message: `Multi-service repo detected: ${subServices.map((s) => s.path).join(', ')}. ` +
        `Convoy will build coordinated lanes for each detected service. Re-run with \`--workspace=<path>\` to narrow to one lane.`,
    });
  }

  if (readme.title) evidence.push(`README title "${readme.title}"`);
  if (packageJson?.['name']) evidence.push(`package.json name=${String(packageJson['name'])}`);
  if (framework) evidence.push(`framework=${framework}`);
  if (dockerfileBase) evidence.push(`Dockerfile base=${dockerfileBase}`);

  return {
    localPath: rootPath,
    scanRoot: scanPath,
    ecosystem,
    language,
    runtime,
    framework,
    topology,
    dataLayer,
    existingPlatform,
    hasDockerfile,
    hasDockerignore,
    dockerfileBase,
    hasCi,
    packageManager,
    startCommand,
    buildCommand,
    devCommand,
    testCommand,
    healthPath,
    port,
    scripts,
    topLevelDirs,
    topLevelFiles,
    sourceDirs,
    testDirs,
    isMonorepo,
    monorepoTool,
    workspaces,
    subServices,
    readmeTitle: readme.title,
    readmeFirstPara: readme.firstPara,
    deployability,
    deployabilityReason,
    evidence,
    risks,
  };
}

export function scanServiceGraph(localPath: string, opts: ScanOptions = {}): ServiceGraph {
  const rootScan = scanRepository(localPath, opts);
  const topLevelDirs = rootScan.topLevelDirs;
  const nodePaths = new Set<string>();

  if (opts.workspace) {
    nodePaths.add(opts.workspace);
  } else {
    for (const service of rootScan.subServices) {
      nodePaths.add(service.path);
    }
    if (topLevelDirs.includes('infra')) {
      nodePaths.add('infra');
    }
    if (nodePaths.size === 0) {
      nodePaths.add('.');
    }
  }

  const nodes = [...nodePaths]
    .map((servicePath) => buildServiceNode(localPath, servicePath, opts.workspace ?? null))
    .filter((node): node is ServiceNode => node !== null);

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.dependsOn = inferDependencies(node, nodesById);
  }

  return {
    localPath,
    scanRoot: rootScan.scanRoot,
    workspace: opts.workspace ?? null,
    isMonorepo: rootScan.isMonorepo || nodes.length > 1,
    monorepoTool: rootScan.monorepoTool,
    readmeTitle: rootScan.readmeTitle,
    readmeFirstPara: rootScan.readmeFirstPara,
    topLevelDirs: rootScan.topLevelDirs,
    topLevelFiles: rootScan.topLevelFiles,
    evidence: rootScan.evidence,
    risks: rootScan.risks,
    nodes,
  };
}

function readTopLevel(dir: string): { topLevelDirs: string[]; topLevelFiles: string[] } {
  const topLevelDirs: string[] = [];
  const topLevelFiles: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { topLevelDirs, topLevelFiles };
  }
  for (const entry of entries) {
    if (entry === '.DS_Store') continue;
    let st;
    try {
      st = statSync(join(dir, entry));
    } catch {
      continue;
    }
    if (st.isDirectory()) topLevelDirs.push(entry);
    else topLevelFiles.push(entry);
  }
  topLevelDirs.sort();
  topLevelFiles.sort();
  return { topLevelDirs, topLevelFiles };
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
    if (entry === '.DS_Store') continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listFiles(base, abs, depth + 1, maxDepth));
    } else {
      out.push(relative(base, abs).split('\\').join('/'));
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

function tryReadFile(base: string, relPath: string): string | null {
  try {
    return readFileSync(join(base, relPath), 'utf8');
  } catch {
    return null;
  }
}

function detectEcosystem(
  topLevelFiles: string[],
  topLevelDirs: string[],
  allFiles: string[],
  evidence: string[],
): Ecosystem {
  if (topLevelFiles.some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) {
    evidence.push('xcode project detected');
    return 'swift';
  }
  if (
    topLevelDirs.some((d) => d.endsWith('.xcodeproj') || d.endsWith('.xcworkspace')) ||
    topLevelFiles.includes('Package.swift') ||
    topLevelFiles.includes('Podfile')
  ) {
    evidence.push('swift/ios project markers');
    return 'swift';
  }
  if (
    topLevelFiles.includes('build.gradle.kts') ||
    topLevelFiles.includes('settings.gradle.kts') ||
    allFiles.some((f) => f.endsWith('/AndroidManifest.xml'))
  ) {
    evidence.push('gradle kotlin / android project');
    return 'kotlin-android';
  }
  if (topLevelFiles.includes('pom.xml') || topLevelFiles.includes('build.gradle')) {
    evidence.push('java/jvm project');
    return 'java-jvm';
  }
  if (topLevelFiles.includes('package.json')) {
    evidence.push('package.json present');
    return 'node';
  }
  if (
    topLevelFiles.includes('pyproject.toml') ||
    topLevelFiles.includes('requirements.txt') ||
    topLevelFiles.includes('Pipfile') ||
    topLevelFiles.includes('setup.py')
  ) {
    evidence.push('python project markers');
    return 'python';
  }
  if (topLevelFiles.includes('go.mod')) {
    evidence.push('go.mod present');
    return 'go';
  }
  if (topLevelFiles.includes('Cargo.toml')) {
    evidence.push('Cargo.toml present');
    return 'rust';
  }
  if (topLevelFiles.includes('Gemfile')) {
    evidence.push('Gemfile present');
    return 'ruby';
  }
  if (topLevelFiles.includes('composer.json')) {
    evidence.push('composer.json present');
    return 'php';
  }
  if (topLevelFiles.some((f) => f.endsWith('.csproj') || f.endsWith('.sln')) ||
      topLevelDirs.includes('bin')) {
    evidence.push('.NET project markers');
    return 'dotnet';
  }
  if (topLevelFiles.includes('mix.exs')) {
    evidence.push('Elixir mix project');
    return 'elixir';
  }
  if (topLevelFiles.includes('pubspec.yaml')) {
    evidence.push('Flutter/Dart project');
    return 'dart-flutter';
  }
  if (topLevelFiles.includes('index.html') && topLevelFiles.length < 12) {
    evidence.push('static html site');
    return 'static';
  }
  return 'unknown';
}

function detectLanguageAndRuntime(
  eco: Ecosystem,
  pkg: Record<string, any> | null,
): { language: string | null; runtime: string | null } {
  switch (eco) {
    case 'node': {
      const engines = pkg?.['engines'];
      const rawNode = typeof engines?.node === 'string' ? engines.node : '';
      const major = rawNode.match(/\d+/)?.[0] ?? '20';
      return { language: 'typescript-or-javascript', runtime: `node-${major}` };
    }
    case 'python':
      return { language: 'python', runtime: 'python-3' };
    case 'go':
      return { language: 'go', runtime: 'go' };
    case 'rust':
      return { language: 'rust', runtime: 'rust' };
    case 'swift':
      return { language: 'swift', runtime: null };
    case 'kotlin-android':
      return { language: 'kotlin', runtime: null };
    case 'java-jvm':
      return { language: 'java', runtime: 'jvm' };
    case 'ruby':
      return { language: 'ruby', runtime: 'ruby' };
    case 'php':
      return { language: 'php', runtime: 'php' };
    case 'dotnet':
      return { language: 'csharp', runtime: 'dotnet' };
    case 'elixir':
      return { language: 'elixir', runtime: 'beam' };
    case 'dart-flutter':
      return { language: 'dart', runtime: null };
    case 'static':
      return { language: 'html', runtime: null };
    default:
      return { language: null, runtime: null };
  }
}

function detectFramework(
  eco: Ecosystem,
  pkg: Record<string, any> | null,
  topLevelFiles: string[],
  allFiles: string[],
): string | null {
  if (eco === 'node' && pkg) {
    const deps: Record<string, unknown> = {
      ...(pkg['dependencies'] ?? {}),
      ...(pkg['devDependencies'] ?? {}),
    };
    if (deps['next']) return 'next.js';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@remix-run/node'] || deps['@remix-run/serve']) return 'remix';
    if (deps['astro']) return 'astro';
    if (deps['@nestjs/core']) return 'nest.js';
    if (deps['fastify']) return 'fastify';
    if (deps['express']) return 'express';
    if (deps['hono']) return 'hono';
    if (deps['svelte']) return 'sveltekit';
    if (deps['vite']) return 'vite';
  }
  if (eco === 'python') {
    if (allFiles.some((f) => /fastapi/i.test(f))) return 'fastapi';
    if (allFiles.some((f) => /django/i.test(f) || f.endsWith('/manage.py'))) return 'django';
    if (topLevelFiles.includes('manage.py')) return 'django';
    if (allFiles.some((f) => /flask/i.test(f))) return 'flask';
  }
  if (eco === 'go') {
    // Look for common frameworks
    const mod = topLevelFiles.includes('go.mod');
    if (mod) return 'go (stdlib or gin/echo)';
  }
  if (eco === 'ruby') {
    if (allFiles.some((f) => f === 'config.ru' || f.includes('app/controllers/'))) return 'rails';
  }
  return null;
}

function detectPackageManager(eco: Ecosystem, files: string[]): PackageManager {
  if (eco === 'node') {
    if (files.includes('pnpm-lock.yaml')) return 'pnpm';
    if (files.includes('yarn.lock')) return 'yarn';
    if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
    if (files.includes('package-lock.json')) return 'npm';
  }
  if (eco === 'python') {
    if (files.includes('uv.lock')) return 'uv';
    if (files.includes('poetry.lock')) return 'poetry';
    return 'pip';
  }
  if (eco === 'rust') return 'cargo';
  if (eco === 'go') return 'go-mod';
  if (eco === 'ruby') return 'gem';
  if (eco === 'php') return 'composer';
  if (eco === 'dotnet') return 'nuget';
  if (eco === 'elixir') return 'mix';
  if (eco === 'dart-flutter') return 'pub';
  return null;
}

function detectMonorepo(
  files: string[],
  pkg: Record<string, any> | null,
  subServices: SubService[] = [],
): { isMonorepo: boolean; monorepoTool: MonorepoTool; workspaces: string[] } {
  if (files.includes('turbo.json')) return { isMonorepo: true, monorepoTool: 'turbo', workspaces: pkgWorkspaces(pkg) };
  if (files.includes('nx.json')) return { isMonorepo: true, monorepoTool: 'nx', workspaces: [] };
  if (files.includes('pnpm-workspace.yaml')) return { isMonorepo: true, monorepoTool: 'pnpm-workspaces', workspaces: [] };
  if (files.includes('lerna.json')) return { isMonorepo: true, monorepoTool: 'lerna', workspaces: pkgWorkspaces(pkg) };
  if (pkg && Array.isArray(pkg['workspaces'])) return { isMonorepo: true, monorepoTool: 'yarn-workspaces', workspaces: pkgWorkspaces(pkg) };
  if (subServices.length >= 2) {
    return { isMonorepo: true, monorepoTool: null, workspaces: subServices.map((s) => s.path) };
  }
  return { isMonorepo: false, monorepoTool: null, workspaces: [] };
}

/**
 * When the root has no recognized manifest, look one level deep for common
 * sub-service directory conventions (backend, frontend, api, server, client,
 * apps/*, packages/*, services/*) and sniff their ecosystems.
 */
function detectSubServices(
  scanPath: string,
  topLevelDirs: string[],
  evidence: string[],
): SubService[] {
  const CANDIDATES = new Set([
    'backend', 'frontend', 'api', 'server', 'client', 'web', 'app',
    'service', 'services', 'apps', 'packages',
  ]);

  const out: SubService[] = [];
  for (const dir of topLevelDirs) {
    if (SKIP_DIRS.has(dir)) continue;
    if (!CANDIDATES.has(dir.toLowerCase())) continue;
    const absChild = join(scanPath, dir);

    // For apps/ packages/ services/ — peek one more level and collect each child.
    if (dir === 'apps' || dir === 'packages' || dir === 'services') {
      let entries: string[];
      try {
        entries = readdirSync(absChild);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const grandPath = join(absChild, entry);
        const sniffed = sniffSubService(grandPath, `${dir}/${entry}`);
        if (sniffed) out.push(sniffed);
      }
      continue;
    }

    const sniffed = sniffSubService(absChild, dir);
    if (sniffed) out.push(sniffed);
  }

  if (out.length > 0) {
    evidence.push(`detected ${out.length} sub-service${out.length === 1 ? '' : 's'}: ${out.map((s) => s.path).join(', ')}`);
  }
  return out;
}

function sniffSubService(absPath: string, relPath: string): SubService | null {
  let entries: string[];
  try {
    entries = readdirSync(absPath);
  } catch {
    return null;
  }
  const has = (name: string): boolean => entries.includes(name);

  if (has('package.json')) {
    const pkg = tryReadJson(absPath, 'package.json');
    const framework = pkg ? detectJsFramework(pkg) : null;
    return { name: relPath, path: relPath, ecosystem: 'node', framework, manifest: 'package.json' };
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) {
    const manifest = has('pyproject.toml') ? 'pyproject.toml' : has('requirements.txt') ? 'requirements.txt' : 'Pipfile';
    return { name: relPath, path: relPath, ecosystem: 'python', framework: null, manifest };
  }
  if (has('go.mod')) {
    return { name: relPath, path: relPath, ecosystem: 'go', framework: null, manifest: 'go.mod' };
  }
  if (has('Cargo.toml')) {
    return { name: relPath, path: relPath, ecosystem: 'rust', framework: null, manifest: 'Cargo.toml' };
  }
  if (has('Gemfile')) {
    return { name: relPath, path: relPath, ecosystem: 'ruby', framework: null, manifest: 'Gemfile' };
  }
  if (has('composer.json')) {
    return { name: relPath, path: relPath, ecosystem: 'php', framework: null, manifest: 'composer.json' };
  }
  if (has('pom.xml') || has('build.gradle')) {
    const manifest = has('pom.xml') ? 'pom.xml' : 'build.gradle';
    return { name: relPath, path: relPath, ecosystem: 'java-jvm', framework: null, manifest };
  }
  return null;
}

// JS framework detection needed from sniffSubService too; pull out helper.
function detectJsFramework(pkg: Record<string, any>): string | null {
  const deps: Record<string, unknown> = {
    ...(pkg['dependencies'] ?? {}),
    ...(pkg['devDependencies'] ?? {}),
  };
  if (deps['next']) return 'next.js';
  if (deps['nuxt']) return 'nuxt';
  if (deps['@remix-run/node'] || deps['@remix-run/serve']) return 'remix';
  if (deps['astro']) return 'astro';
  if (deps['@nestjs/core']) return 'nest.js';
  if (deps['fastify']) return 'fastify';
  if (deps['express']) return 'express';
  if (deps['hono']) return 'hono';
  if (deps['svelte']) return 'sveltekit';
  if (deps['vite']) return 'vite';
  return null;
}

function pkgWorkspaces(pkg: Record<string, any> | null): string[] {
  const ws = pkg?.['workspaces'];
  if (Array.isArray(ws)) return ws as string[];
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) return ws.packages as string[];
  return [];
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

function readDockerfileBase(localPath: string): string | null {
  const raw = tryReadFile(localPath, 'Dockerfile');
  if (!raw) return null;
  const fromLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^FROM\s+/i.test(line));
  if (!fromLine) return null;
  const image = fromLine.replace(/^FROM\s+/i, '').split(' ')[0];
  return image ?? null;
}

function inferTopology(
  eco: Ecosystem,
  framework: string | null,
  allFiles: string[],
  pkg: Record<string, any> | null,
): ScanResult['topology'] {
  const deps = pkg
    ? { ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}) }
    : {};
  const hasWorker =
    allFiles.some((f) => /\b(worker|queue|job)s?\b/i.test(f)) ||
    'bullmq' in deps ||
    'bee-queue' in deps ||
    'celery' in deps;

  if (eco === 'static') return 'static';
  if (framework === 'next.js' || framework === 'nuxt' || framework === 'sveltekit' || framework === 'remix') {
    return hasWorker ? 'web+worker' : 'web';
  }
  if (framework === 'astro' || framework === 'vite') return 'static';
  if (framework === 'fastapi' || framework === 'django' || framework === 'flask') return hasWorker ? 'web+worker' : 'web';
  if (framework === 'express' || framework === 'fastify' || framework === 'hono' || framework === 'nest.js') {
    return hasWorker ? 'web+worker' : 'api';
  }
  if (eco === 'node' && pkg) return hasWorker ? 'web+worker' : 'web';
  if (eco === 'rust' || eco === 'go' || eco === 'java-jvm') return 'api';
  if (eco === 'swift' || eco === 'kotlin-android' || eco === 'dart-flutter') return 'unknown';
  return hasWorker ? 'web+worker' : 'unknown';
}

function detectDataLayer(
  localPath: string,
  files: string[],
  pkg: Record<string, any> | null,
  evidence: string[],
): string[] {
  const found = new Set<string>();
  const deps: Record<string, unknown> = pkg
    ? { ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}) }
    : {};

  if ('prisma' in deps || '@prisma/client' in deps) {
    found.add('postgres-via-prisma');
    evidence.push('prisma detected');
  }
  if ('pg' in deps || 'postgres' in deps) found.add('postgres');
  if ('mysql' in deps || 'mysql2' in deps) found.add('mysql');
  if ('mongodb' in deps || 'mongoose' in deps) found.add('mongodb');
  if ('redis' in deps || 'ioredis' in deps) found.add('redis');
  if ('@elastic/elasticsearch' in deps) found.add('elasticsearch');
  if ('sqlite3' in deps || 'better-sqlite3' in deps) found.add('sqlite');

  for (const cf of ['docker-compose.yml', 'docker-compose.yaml']) {
    if (files.includes(cf)) {
      const raw = tryReadFile(localPath, cf) ?? '';
      if (/postgres/i.test(raw)) found.add('postgres');
      if (/redis/i.test(raw)) found.add('redis');
      if (/mongo/i.test(raw)) found.add('mongodb');
      if (/elasticsearch|opensearch/i.test(raw)) found.add('elasticsearch');
      if (/mysql/i.test(raw)) found.add('mysql');
      evidence.push(`docker-compose references: ${[...found].join(', ') || 'none'}`);
    }
  }
  return [...found];
}

function detectSourceDirs(eco: Ecosystem, topLevelDirs: string[]): string[] {
  const common = ['src', 'app', 'lib', 'pages', 'components', 'server', 'api', 'routes', 'handlers'];
  const swift = ['Sources', 'Tests', 'App', 'Shared'];
  const python = ['src', 'app', 'api', 'backend'];
  const rust = ['src', 'crates'];
  const pool = eco === 'swift' ? swift : eco === 'python' ? python : eco === 'rust' ? rust : common;
  return topLevelDirs.filter((d) => pool.includes(d));
}

function detectTestDirs(topLevelDirs: string[], allFiles: string[]): string[] {
  const found = new Set<string>();
  const patterns = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'integration'];
  for (const d of topLevelDirs) {
    if (patterns.includes(d)) found.add(d);
  }
  if (allFiles.some((f) => /\.test\.(t|j)sx?$/.test(f) || /\.spec\.(t|j)sx?$/.test(f))) {
    found.add('co-located *.test/*.spec files');
  }
  return [...found];
}

function detectHealthPath(localPath: string, allFiles: string[]): string | null {
  // Next.js API-route pattern — the URL is structural, derived from the file
  // location under app/api or pages/api, not from the file body.
  const nextCandidates = [
    'app/api/health/route.ts',
    'app/api/health/route.js',
    'pages/api/health.ts',
    'pages/api/health.js',
  ];
  for (const c of nextCandidates) {
    if (allFiles.includes(c)) return '/api/health';
  }
  // Express/Fastify-style: the URL is registered inside the file body. Prefer
  // what the source declares (`router.get('/health', ...)`); fall back to
  // `/health` when the body is unreadable. Previously the scanner lumped
  // `src/routes/health.ts` into the Next.js bucket and returned `/api/health`
  // for plain Express apps — wrong for the bundled demo app and any repo
  // where the health router is mounted at `/` rather than `/api`.
  const expressCandidates = [
    'src/routes/health.ts',
    'src/routes/health.js',
    'src/health.ts',
    'src/health.js',
    'routes/health.ts',
    'routes/health.js',
  ];
  for (const c of expressCandidates) {
    if (!allFiles.includes(c)) continue;
    const raw = tryReadFile(localPath, c);
    if (raw && /['"`]\/api\/health['"`]/.test(raw)) return '/api/health';
    return '/health';
  }
  if (allFiles.some((f) => f.endsWith('health.ts') || f.endsWith('health.js'))) {
    return '/health';
  }
  // Last-ditch: grep a small set of likely files
  const routeFiles = allFiles.filter((f) => /routes?\.(t|j)sx?$|server\.(t|j)sx?$|main\.(t|j)sx?$/.test(f)).slice(0, 5);
  for (const rf of routeFiles) {
    const raw = tryReadFile(localPath, rf);
    if (raw && /['"`]\/api\/health['"`]/.test(raw)) return '/api/health';
    if (raw && /['"`]\/health['"`]/.test(raw)) return '/health';
  }
  return null;
}

function detectPort(
  pkg: Record<string, any> | null,
  scripts: Record<string, string>,
  localPath: string,
  allFiles: string[],
): number | null {
  for (const [, cmd] of Object.entries(scripts)) {
    const m = cmd.match(/--port[= ](\d+)/);
    if (m && m[1]) return Number(m[1]);
  }
  if (pkg?.['name'] === 'convoy') return null;
  const dockerfile = tryReadFile(localPath, 'Dockerfile');
  if (dockerfile) {
    const m = dockerfile.match(/EXPOSE\s+(\d+)/);
    if (m && m[1]) return Number(m[1]);
  }
  for (const f of allFiles.slice(0, 40)) {
    if (/\.(t|j)sx?$/.test(f) && /(server|index|main)/i.test(f)) {
      const raw = tryReadFile(localPath, f);
      if (!raw) continue;
      const m = raw.match(/listen\(\s*(\d+)/);
      if (m && m[1]) return Number(m[1]);
    }
  }
  return null;
}

function readReadmeExcerpt(
  localPath: string,
  topLevelFiles: string[],
): { title: string | null; firstPara: string | null } {
  const readmeName = topLevelFiles.find((f) => /^readme(\.md|\.markdown)?$/i.test(f));
  if (!readmeName) return { title: null, firstPara: null };
  const raw = tryReadFile(localPath, readmeName);
  if (!raw) return { title: null, firstPara: null };
  const lines = raw.split('\n').map((l) => l.trim());
  const titleLine = lines.find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.slice(2).trim() : null;
  const paraLines: string[] = [];
  let started = false;
  for (const l of lines) {
    if (!started && l.startsWith('# ')) continue;
    if (!started && l === '') continue;
    if (l.startsWith('#')) break;
    if (l === '' && paraLines.length > 0) break;
    if (l !== '') {
      paraLines.push(l);
      started = true;
    }
  }
  const firstPara = paraLines.join(' ').slice(0, 240) || null;
  return { title, firstPara };
}

function determineDeployability(
  eco: Ecosystem,
  topology: ScanResult['topology'],
  framework: string | null,
  topLevelFiles: string[],
  isMonorepo: boolean,
): { deployability: Deployability; deployabilityReason: string } {
  if (eco === 'swift' || eco === 'kotlin-android' || eco === 'dart-flutter') {
    return {
      deployability: 'not-cloud-deployable',
      deployabilityReason:
        'This looks like a mobile or desktop app target. Convoy ships web services and static sites; app stores (App Store / Play Store / TestFlight / Firebase Distribution) are the right channel.',
    };
  }
  if (eco === 'static') {
    return {
      deployability: 'deployable-static-site',
      deployabilityReason: 'Static site — Convoy will deploy it to a CDN-backed platform.',
    };
  }
  if (framework === 'astro' || framework === 'vite') {
    return {
      deployability: 'deployable-static-site',
      deployabilityReason: `${framework} output is predominantly static; Convoy will treat it as a static site with server components where applicable.`,
    };
  }
  if (topology === 'unknown' && !framework && !topLevelFiles.includes('Dockerfile')) {
    return {
      deployability: 'ambiguous',
      deployabilityReason:
        'Convoy could not confirm this is a deployable web service. No web framework, no Dockerfile, no obvious entry point. Override with --platform and add a Dockerfile if you intend to deploy this.',
    };
  }
  if (isMonorepo) {
    return {
      deployability: 'deployable-web-service',
      deployabilityReason:
        'Detected a monorepo. Convoy will plan coordinated deployment lanes across the detected services; pass --workspace=<pkg> to narrow to one service.',
    };
  }
  return {
    deployability: 'deployable-web-service',
    deployabilityReason: 'Deployable web service.',
  };
}

function collectRisks(
  risks: ScanRisk[],
  eco: Ecosystem,
  framework: string | null,
  dataLayer: string[],
  hasDockerfile: boolean,
  healthPath: string | null,
  testDirs: string[],
  scripts: Record<string, string>,
  isMonorepo: boolean,
): void {
  if (dataLayer.some((d) => d.includes('postgres') || d.includes('mysql'))) {
    risks.push({
      level: 'info',
      message: 'Relational DB detected. Rehearsal will run a migration dry-run against scratch data before applying.',
    });
  }
  if (!healthPath && framework) {
    risks.push({
      level: 'warn',
      message: `No explicit health endpoint detected. Convoy will target /health; consider adding a real route or the platform's health check will rely on TCP only.`,
    });
  }
  if (testDirs.length === 0 && !scripts['test']) {
    risks.push({
      level: 'info',
      message: 'No test suite detected. Rehearsal will skip automated smoke tests and rely on health probes + synthetic load.',
    });
  }
  if (hasDockerfile) {
    risks.push({
      level: 'info',
      message: 'Existing Dockerfile detected. Convoy will use it as-is (developer-authored); it will not be rewritten.',
    });
  }
  if (isMonorepo) {
    risks.push({
      level: 'warn',
      message: 'Monorepo detected. Convoy will coordinate detected lanes from one run; use --workspace to narrow to one service when needed.',
    });
  }
  if (eco === 'unknown') {
    risks.push({
      level: 'block',
      message: 'Ecosystem could not be identified. Convoy will not proceed to apply without a recognized project manifest (package.json, pyproject.toml, go.mod, Cargo.toml, etc.).',
    });
  }
}

export function repoName(localPath: string): string {
  return basename(localPath).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'convoy-app';
}

function buildServiceNode(
  localPath: string,
  servicePath: string,
  workspace: string | null,
): ServiceNode | null {
  const scan = servicePath === '.'
    ? scanRepository(localPath, workspace ? { workspace } : {})
    : scanRepository(localPath, { workspace: servicePath });
  const normalizedPath = servicePath === '.' ? '.' : servicePath.replace(/\\/g, '/');
  const role = detectLaneRole(normalizedPath, scan);
  const id = buildLaneId(normalizedPath, role);
  const secretsHints = detectSecretsHints(localPath, normalizedPath, scan);

  return {
    id,
    name: normalizedPath === '.' ? repoName(localPath) : basename(normalizedPath),
    path: normalizedPath,
    role,
    ecosystem: scan.ecosystem,
    framework: scan.framework,
    topology: scan.topology,
    dataLayer: scan.dataLayer,
    buildCommand: scan.buildCommand,
    startCommand: scan.startCommand,
    testCommand: scan.testCommand,
    healthPath: scan.healthPath,
    port: scan.port,
    existingPlatform: scan.existingPlatform,
    evidence: scan.evidence,
    risks: scan.risks,
    dependsOn: [],
    platformHints: {
      existingPlatform: scan.existingPlatform,
      hasDockerfile: scan.hasDockerfile,
      hasCi: scan.hasCi,
      packageManager: scan.packageManager,
    },
    authHints: detectAuthHints(scan),
    secretsHints,
    scan,
  };
}

function buildLaneId(servicePath: string, role: ServiceNode['role']): string {
  const base = servicePath === '.'
    ? 'root'
    : servicePath.toLowerCase().replace(/[^a-z0-9/.-]+/g, '-').replace(/[/.]+/g, '-');
  return `${role}-${base.replace(/^-+|-+$/g, '') || 'root'}`;
}

function detectLaneRole(servicePath: string, scan: ScanResult): ServiceNode['role'] {
  const lowerPath = servicePath.toLowerCase();
  if (lowerPath === 'infra' || lowerPath.startsWith('infra/')) return 'infra';
  if (scan.framework === 'next.js' || scan.framework === 'astro' || scan.framework === 'vite' || scan.topology === 'static') {
    return 'frontend';
  }
  if (scan.topology === 'worker' || /\b(worker|queue|job)s?\b/.test(lowerPath)) {
    return 'worker';
  }
  return 'backend';
}

function detectAuthHints(scan: ScanResult): AuthHints {
  const configFiles: string[] = [];
  const candidateClis = new Set<string>();
  if (scan.existingPlatform === 'fly') {
    candidateClis.add('flyctl');
    configFiles.push('fly.toml');
  }
  if (scan.existingPlatform === 'vercel' || scan.framework === 'next.js') {
    candidateClis.add('vercel');
    configFiles.push('vercel.json', '.vercel/project.json');
  }
  if (scan.existingPlatform === 'railway') {
    candidateClis.add('railway');
    configFiles.push('railway.toml', 'railway.json');
  }
  if (scan.existingPlatform === 'cloudrun') {
    candidateClis.add('gcloud');
    configFiles.push('cloudbuild.yaml', 'cloudbuild.yml');
  }
  if (candidateClis.size === 0) {
    candidateClis.add('gh');
  }
  return {
    requiresProjectBinding: scan.existingPlatform === 'vercel' || scan.framework === 'next.js',
    candidateClis: [...candidateClis],
    configFiles: [...new Set(configFiles)],
  };
}

function detectSecretsHints(
  localPath: string,
  servicePath: string,
  scan: ScanResult,
): SecretsHints {
  const expected = new Set<string>();
  const sources: string[] = [];
  const serviceRoot = servicePath === '.' ? localPath : join(localPath, servicePath);
  for (const candidate of ['.env.schema', '.env.example', '.env.local.example']) {
    const raw = tryReadFile(serviceRoot, candidate) ?? tryReadFile(localPath, candidate);
    if (!raw) continue;
    const keys = extractEnvKeys(raw);
    if (keys.length === 0) continue;
    keys.forEach((key) => expected.add(key));
    sources.push(candidate);
  }
  if (scan.dataLayer.some((layer) => layer.includes('postgres'))) expected.add('DATABASE_URL');
  if (scan.dataLayer.includes('redis')) expected.add('REDIS_URL');
  return {
    expectedKeys: [...expected].sort(),
    sources,
  };
}

function extractEnvKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) out.push(key);
  }
  return out;
}

function inferDependencies(
  node: ServiceNode,
  nodesById: Map<string, ServiceNode>,
): string[] {
  const deps = new Set<string>();
  if (node.role === 'backend' || node.role === 'worker' || node.role === 'frontend') {
    for (const other of nodesById.values()) {
      if (other.role === 'infra') deps.add(other.id);
    }
  }
  if (node.role === 'frontend') {
    for (const other of nodesById.values()) {
      if (other.role === 'backend' || other.role === 'worker') deps.add(other.id);
    }
  }
  return [...deps];
}
