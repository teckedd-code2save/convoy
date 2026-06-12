import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanServiceGraph, type ServiceGraph } from '../planner/scanner.js';

export interface CiWorkflow {
  file: string;
  triggers: string[];
  deploySteps: string[];
  secretsReferenced: string[];
}

export interface OrientResult {
  graph: ServiceGraph;
  ciWorkflows: CiWorkflow[];
  secretsManager: string | null;
  observability: string[];
  summary: string;
}

export async function orientRepo(localPath: string, opts: { ai?: boolean; apiKey?: string } = {}): Promise<OrientResult> {
  const graph = scanServiceGraph(localPath);
  const ciWorkflows = parseCiWorkflows(localPath);
  const secretsManager = detectSecretsManager(localPath, graph);
  const observability = detectObservability(localPath, graph);
  const summary = buildSummary(graph, ciWorkflows, secretsManager, observability);
  return { graph, ciWorkflows, secretsManager, observability, summary };
}

function parseCiWorkflows(localPath: string): CiWorkflow[] {
  const workflowsDir = join(localPath, '.github', 'workflows');
  if (!existsSync(workflowsDir)) return [];
  const out: CiWorkflow[] = [];
  let files: string[];
  try { files = readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')); }
  catch { return []; }
  for (const file of files) {
    const raw = tryRead(join(workflowsDir, file));
    if (!raw) continue;
    const triggers = extractYamlTriggers(raw);
    const deploySteps = extractDeploySteps(raw);
    const secretsReferenced = extractSecretsRefs(raw);
    out.push({ file: `.github/workflows/${file}`, triggers, deploySteps, secretsReferenced });
  }
  return out;
}

function extractYamlTriggers(raw: string): string[] {
  const triggers: string[] = [];
  const onMatch = raw.match(/^on:\s*\n((?:[ \t]+.*\n)*)/m);
  if (!onMatch) {
    // inline: on: push
    const inline = raw.match(/^on:\s+(.+)/m);
    if (inline?.[1]) triggers.push(inline[1].trim());
    return triggers;
  }
  const block = onMatch[1] ?? '';
  for (const line of block.split('\n')) {
    const m = line.match(/^\s+(\w+):/);
    if (m?.[1]) triggers.push(m[1]);
  }
  return triggers;
}

function extractDeploySteps(raw: string): string[] {
  const steps: string[] = [];
  const deployPatterns = [/fly\s+deploy/, /vercel\s+--prod/, /railway\s+up/, /gcloud\s+run\s+deploy/, /docker\s+push/, /kubectl\s+apply/];
  for (const line of raw.split('\n')) {
    if (deployPatterns.some(p => p.test(line))) {
      steps.push(line.trim().slice(0, 80));
    }
  }
  return steps;
}

function extractSecretsRefs(raw: string): string[] {
  const refs = new Set<string>();
  const re = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1]) refs.add(m[1]);
  }
  return [...refs];
}

function detectSecretsManager(localPath: string, graph: ServiceGraph): string | null {
  const allFiles = [...graph.topLevelFiles];
  if (allFiles.includes('.doppler.yaml') || allFiles.includes('doppler.yaml')) return 'doppler';
  if (allFiles.includes('.infisical.json')) return 'infisical';
  // grep package.json deps
  const pkg = tryReadJson(localPath, 'package.json');
  const deps = { ...(pkg?.['dependencies'] ?? {}), ...(pkg?.['devDependencies'] ?? {}) };
  if ('doppler-env' in deps || '@dopplerhq/node-sdk' in deps) return 'doppler';
  if ('@infisical/sdk' in deps) return 'infisical';
  if ('node-vault' in deps || 'vault' in deps) return 'vault';
  if ('@aws-sdk/client-secrets-manager' in deps) return 'aws-secrets-manager';
  return null;
}

function detectObservability(localPath: string, graph: ServiceGraph): string[] {
  const found: string[] = [];
  const pkg = tryReadJson(localPath, 'package.json');
  const deps = { ...(pkg?.['dependencies'] ?? {}), ...(pkg?.['devDependencies'] ?? {}) };
  if ('@sentry/node' in deps || '@sentry/nextjs' in deps) found.push('sentry');
  if ('dd-trace' in deps || 'datadog-metrics' in deps) found.push('datadog');
  if ('newrelic' in deps) found.push('newrelic');
  if ('pino' in deps || 'winston' in deps || 'bunyan' in deps) found.push('structured-logging');
  return found;
}

function buildSummary(
  graph: ServiceGraph,
  workflows: CiWorkflow[],
  secretsManager: string | null,
  observability: string[],
): string {
  const serviceCount = graph.nodes.length;
  const platforms = [...new Set(graph.nodes.map(n => n.existingPlatform).filter(Boolean))];
  const hasCI = workflows.length > 0;
  const allSecrets = [...new Set(workflows.flatMap(w => w.secretsReferenced))];

  const lines: string[] = [];
  lines.push(`${serviceCount} service${serviceCount === 1 ? '' : 's'} detected`);
  if (platforms.length > 0) lines.push(`existing platform: ${platforms.join(', ')}`);
  if (hasCI) lines.push(`CI: ${workflows.map(w => w.file).join(', ')}`);
  if (secretsManager) lines.push(`secrets manager: ${secretsManager}`);
  if (observability.length > 0) lines.push(`observability: ${observability.join(', ')}`);
  if (allSecrets.length > 0) lines.push(`secrets referenced in CI: ${allSecrets.join(', ')}`);
  return lines.join(' · ');
}

function tryRead(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function tryReadJson(base: string, rel: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(join(base, rel), 'utf8')) as Record<string, unknown>; } catch { return null; }
}
