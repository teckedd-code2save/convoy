import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import type { ConvoyPlan, PlanRisk } from '../core/plan.js';
import type { ScanResult } from './scanner.js';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 1200;

const SYSTEM_PROMPT = `You are a senior platform engineer reviewing a Convoy deployment plan.
Convoy is a deployment agent that ships user code to Fly.io, Railway, Vercel, or Cloud Run.
Convoy never modifies developer source code — it only authors Dockerfile, platform manifests,
CI workflow, .env.schema. It rehearses on an ephemeral twin, promotes through canary, and
auto-rolls back on SLO breach.

Your job: read the scan evidence and the deterministic plan, then rewrite three fields so they
read like a careful human's analysis, not a template. Be terse, concrete, and specific to
what's actually in this repo. Cite evidence. Do not invent facts. Do not claim Convoy will
modify developer code. Do not promise features Convoy doesn't have.

Respond ONLY with a JSON object inside <json>...</json> tags. No other text. Shape:
{
  "summary": "One-paragraph narrative. What the repo is, what stands out, where Convoy will ship it. 2-3 sentences max.",
  "platformReason": "One or two sentences explaining the chosen platform based on concrete evidence from the scan.",
  "risks": [
    { "level": "info"|"warn"|"block", "message": "Specific to this repo, not generic. Cite evidence." }
  ]
}
Return only risks that are evidence-based and add value beyond the default callouts; empty array is fine.`;

export interface EnrichmentOptions {
  apiKey?: string;
  cacheDir?: string;
  model?: string;
  disable?: boolean;
}

interface Enrichment {
  summary?: string;
  platformReason?: string;
  risks?: PlanRisk[];
}

export async function enrichPlan(
  scan: ScanResult,
  plan: ConvoyPlan,
  opts: EnrichmentOptions = {},
): Promise<{ plan: ConvoyPlan; source: 'ai' | 'cache' | 'skipped-no-key' | 'skipped-flag' | 'error' }> {
  if (opts.disable) return { plan, source: 'skipped-flag' };

  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return { plan, source: 'skipped-no-key' };

  const cacheDir = opts.cacheDir ?? '.convoy/cache';
  const key = enrichmentKey(scan, plan);
  const cached = loadCache(cacheDir, key);
  if (cached) {
    return { plan: applyEnrichment(plan, cached), source: 'cache' };
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: opts.model ?? MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(scan, plan) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const enrichment = parseEnrichment(text);
    if (!enrichment) {
      return { plan, source: 'error' };
    }

    saveCache(cacheDir, key, enrichment);
    return { plan: applyEnrichment(plan, enrichment), source: 'ai' };
  } catch {
    return { plan, source: 'error' };
  }
}

function enrichmentKey(scan: ScanResult, plan: ConvoyPlan): string {
  const seed = {
    ecosystem: scan.ecosystem,
    framework: scan.framework,
    topology: scan.topology,
    dataLayer: scan.dataLayer,
    topLevelFiles: scan.topLevelFiles,
    topLevelDirs: scan.topLevelDirs,
    platform: plan.platform.chosen,
    deployability: plan.deployability.verdict,
  };
  return createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 16);
}

function loadCache(dir: string, key: string): Enrichment | null {
  const path = join(dir, `enrich-${key}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Enrichment;
  } catch {
    return null;
  }
}

function saveCache(dir: string, key: string, value: Enrichment): void {
  mkdirSync(dirname(join(dir, 'x')), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `enrich-${key}.json`), JSON.stringify(value, null, 2), 'utf8');
}

function buildUserPrompt(scan: ScanResult, plan: ConvoyPlan): string {
  const scanSummary = {
    localPath: scan.localPath,
    ecosystem: scan.ecosystem,
    language: scan.language,
    runtime: scan.runtime,
    framework: scan.framework,
    topology: scan.topology,
    dataLayer: scan.dataLayer,
    existingPlatform: scan.existingPlatform,
    hasDockerfile: scan.hasDockerfile,
    dockerfileBase: scan.dockerfileBase,
    hasCi: scan.hasCi,
    packageManager: scan.packageManager,
    startCommand: scan.startCommand,
    buildCommand: scan.buildCommand,
    devCommand: scan.devCommand,
    testCommand: scan.testCommand,
    healthPath: scan.healthPath,
    port: scan.port,
    topLevelDirs: scan.topLevelDirs,
    topLevelFiles: scan.topLevelFiles.slice(0, 40),
    sourceDirs: scan.sourceDirs,
    testDirs: scan.testDirs,
    isMonorepo: scan.isMonorepo,
    monorepoTool: scan.monorepoTool,
    workspaces: scan.workspaces,
    readmeTitle: scan.readmeTitle,
    readmeFirstPara: scan.readmeFirstPara,
    evidence: scan.evidence,
    deterministicRisks: scan.risks,
  };
  const planSummary = {
    platformChosen: plan.platform.chosen,
    platformSource: plan.platform.source,
    deterministicReason: plan.platform.reason,
    candidates: plan.platform.candidates,
    deterministicSummary: plan.summary,
    deployability: plan.deployability,
  };
  return `<scan>
${JSON.stringify(scanSummary, null, 2)}
</scan>

<plan>
${JSON.stringify(planSummary, null, 2)}
</plan>

Rewrite summary, platformReason, and (if evidence-based) risks. Return ONLY the JSON inside <json> tags.`;
}

function parseEnrichment(text: string): Enrichment | null {
  const match = text.match(/<json>([\s\S]*?)<\/json>/);
  const raw = match?.[1]?.trim() ?? text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const out: Enrichment = {};
    if (typeof obj['summary'] === 'string') out.summary = obj['summary'].trim();
    if (typeof obj['platformReason'] === 'string') out.platformReason = obj['platformReason'].trim();
    if (Array.isArray(obj['risks'])) {
      const risks: PlanRisk[] = [];
      for (const r of obj['risks'] as unknown[]) {
        if (r && typeof r === 'object') {
          const rr = r as Record<string, unknown>;
          const level = rr['level'];
          const message = rr['message'];
          if (
            (level === 'info' || level === 'warn' || level === 'block') &&
            typeof message === 'string'
          ) {
            risks.push({ level, message: message.trim() });
          }
        }
      }
      out.risks = risks;
    }
    return out;
  } catch {
    return null;
  }
}

function applyEnrichment(plan: ConvoyPlan, enrichment: Enrichment): ConvoyPlan {
  return {
    ...plan,
    summary: enrichment.summary ?? plan.summary,
    platform: {
      ...plan.platform,
      reason: enrichment.platformReason ?? plan.platform.reason,
    },
    risks:
      enrichment.risks && enrichment.risks.length > 0
        ? dedupeRisks([...plan.risks, ...enrichment.risks])
        : plan.risks,
  };
}

function dedupeRisks(risks: PlanRisk[]): PlanRisk[] {
  const seen = new Set<string>();
  const out: PlanRisk[] = [];
  for (const r of risks) {
    const key = `${r.level}::${r.message.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
