import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import type {
  ConvoyPlan,
  PlanAuthoredFile,
  PlanRisk,
  PlanShipStep,
} from '../core/plan.js';
import type { ScanResult } from './scanner.js';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4000;
const CACHE_VERSION = 'v2';

const SYSTEM_PROMPT = `You are a senior platform engineer drafting a Convoy deployment plan for a specific repository.

Convoy ships user code to Fly.io, Railway, Vercel, or Cloud Run. Convoy never modifies developer source code. It authors only deployment-surface files (Dockerfile, .dockerignore, platform manifests, CI config, .env.schema) and then rehearses on an ephemeral twin before any production traffic.

Your job: given the repo scan and a deterministic draft plan, return JSON that sounds like YOU are the deploying engineer explaining what you're going to do.

Rules:
- Speak in first person ("I'll..."). Not documentation voice.
- Be specific to THIS repo. Cite real filenames, deps, commands.
- Don't invent facts. If the scan doesn't support it, don't say it.
- For authoredFiles: if you return a file that's in the draft, your contentPreview REPLACES the draft's. Your content must be deployable on the chosen platform. Respect the package manager, framework, and data layer in the scan. For Next.js, prefer standalone output. For Prisma, include \`npx prisma generate\` at the right build stage.
- Never suggest modifying developer-authored code. You only author deployment files.

Return ONLY a JSON object inside <json>...</json> tags. Shape:
{
  "summary": "2-3 sentence first-person narrative — what the repo is, where I'll ship it, why.",
  "platformReason": "1-2 first-person sentences. Cite concrete evidence from the scan.",
  "risks": [
    { "level": "info"|"warn"|"block", "message": "Specific to this repo. Evidence-based. Add only if non-obvious." }
  ],
  "shipNarrative": [
    { "step": 1, "kind": "approval"|"action", "text": "First-person. One sentence.", "details": ["optional sub-bullets, first-person"] }
  ],
  "authoredFiles": [
    { "path": "Dockerfile", "contentPreview": "<full file>", "summary": "<one-line purpose>" }
  ]
}
Empty arrays are fine for risks and authoredFiles. Keep shipNarrative to 5-7 steps. Keep details tight (5 max per step).`;

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
  shipNarrative?: PlanShipStep[];
  authoredFiles?: PlanAuthoredFile[];
}

export type EnrichmentSource = 'ai' | 'cache' | 'skipped-no-key' | 'skipped-flag' | 'error';

export async function enrichPlan(
  scan: ScanResult,
  plan: ConvoyPlan,
  opts: EnrichmentOptions = {},
): Promise<{ plan: ConvoyPlan; source: EnrichmentSource }> {
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
    if (!enrichment) return { plan, source: 'error' };

    saveCache(cacheDir, key, enrichment);
    return { plan: applyEnrichment(plan, enrichment), source: 'ai' };
  } catch {
    return { plan, source: 'error' };
  }
}

function enrichmentKey(scan: ScanResult, plan: ConvoyPlan): string {
  const seed = {
    v: CACHE_VERSION,
    ecosystem: scan.ecosystem,
    framework: scan.framework,
    topology: scan.topology,
    dataLayer: scan.dataLayer,
    topLevelFiles: scan.topLevelFiles,
    topLevelDirs: scan.topLevelDirs,
    packageManager: scan.packageManager,
    buildCommand: scan.buildCommand,
    startCommand: scan.startCommand,
    testCommand: scan.testCommand,
    port: scan.port,
    platform: plan.platform.chosen,
    deployability: plan.deployability.verdict,
    authoredFilePaths: plan.author.convoyAuthoredFiles.map((f) => f.path),
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
    topLevelFiles: scan.topLevelFiles.slice(0, 50),
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
    target: plan.target,
    platformChosen: plan.platform.chosen,
    platformSource: plan.platform.source,
    candidates: plan.platform.candidates,
    rehearsal: plan.rehearsal,
    promotion: plan.promotion,
    rollback: plan.rollback,
    authoredFilesToWrite: plan.author.convoyAuthoredFiles.map((f) => ({
      path: f.path,
      purpose: f.summary,
      fallbackContentLength: f.contentPreview.length,
    })),
  };

  const fileInstructions = plan.author.convoyAuthoredFiles
    .map((f) => `- ${f.path} (purpose: ${f.summary})`)
    .join('\n');

  return `<scan>
${JSON.stringify(scanSummary, null, 2)}
</scan>

<plan>
${JSON.stringify(planSummary, null, 2)}
</plan>

<files-to-author>
${fileInstructions || '(none)'}
</files-to-author>

Produce the JSON. For authoredFiles, prioritize the Dockerfile if one is requested — tailor it to the framework, package manager, Prisma (if present), and port. Platform manifests (fly.toml, vercel.json, railway.toml, cloudbuild.yaml) and .dockerignore can be omitted from authoredFiles — the deterministic drafts are well-known conventions and don't benefit from per-repo tailoring. Always include shipNarrative. Return only the JSON inside <json> tags.`;
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
      out.risks = parseRisks(obj['risks']);
    }
    if (Array.isArray(obj['shipNarrative'])) {
      out.shipNarrative = parseNarrative(obj['shipNarrative']);
    }
    if (Array.isArray(obj['authoredFiles'])) {
      out.authoredFiles = parseAuthoredFiles(obj['authoredFiles']);
    }
    return out;
  } catch {
    return null;
  }
}

function parseRisks(input: unknown[]): PlanRisk[] {
  const out: PlanRisk[] = [];
  for (const r of input) {
    if (r && typeof r === 'object') {
      const rr = r as Record<string, unknown>;
      const level = rr['level'];
      const message = rr['message'];
      if (
        (level === 'info' || level === 'warn' || level === 'block') &&
        typeof message === 'string'
      ) {
        out.push({ level, message: message.trim() });
      }
    }
  }
  return out;
}

function parseNarrative(input: unknown[]): PlanShipStep[] {
  const out: PlanShipStep[] = [];
  for (const s of input) {
    if (s && typeof s === 'object') {
      const ss = s as Record<string, unknown>;
      const step = ss['step'];
      const kind = ss['kind'];
      const text = ss['text'];
      const details = ss['details'];
      if (
        typeof step === 'number' &&
        (kind === 'action' || kind === 'approval') &&
        typeof text === 'string'
      ) {
        const entry: PlanShipStep = { step, kind, text: text.trim() };
        if (Array.isArray(details)) {
          entry.details = details.filter((d): d is string => typeof d === 'string').map((d) => d.trim());
        }
        out.push(entry);
      }
    }
  }
  return out;
}

function parseAuthoredFiles(input: unknown[]): PlanAuthoredFile[] {
  const out: PlanAuthoredFile[] = [];
  for (const f of input) {
    if (f && typeof f === 'object') {
      const ff = f as Record<string, unknown>;
      const path = ff['path'];
      const contentPreview = ff['contentPreview'];
      const summary = ff['summary'];
      if (typeof path === 'string' && typeof contentPreview === 'string') {
        const content = contentPreview.replace(/\r\n/g, '\n');
        out.push({
          path: path.trim(),
          contentPreview: content,
          lines: content.split('\n').length,
          summary: typeof summary === 'string' ? summary.trim() : '',
        });
      }
    }
  }
  return out;
}

function applyEnrichment(plan: ConvoyPlan, enrichment: Enrichment): ConvoyPlan {
  const mergedFiles: PlanAuthoredFile[] = plan.author.convoyAuthoredFiles.map((existing) => {
    const replacement = enrichment.authoredFiles?.find((f) => f.path === existing.path);
    if (!replacement) return existing;
    return {
      ...existing,
      contentPreview: replacement.contentPreview,
      lines: replacement.lines,
      summary: replacement.summary || existing.summary,
    };
  });

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
    shipNarrative:
      enrichment.shipNarrative && enrichment.shipNarrative.length > 0
        ? enrichment.shipNarrative
        : plan.shipNarrative,
    author: { ...plan.author, convoyAuthoredFiles: mergedFiles },
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
