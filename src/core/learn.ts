import Anthropic from '@anthropic-ai/sdk';

import type { ConvoyPlan } from './plan.js';
import type { ConvoyMemory } from './memory.js';
import type { Run, RunEvent } from './types.js';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 1200;

const SYSTEM_PROMPT = `You are the Convoy learning agent. After every deployment run you read the evidence and extract what this run teaches future plans.

Your job:
1. Extract a one-sentence lesson — not "the run succeeded" but WHY, or what was surprising.
2. Identify 1–3 persistent facts that future plans for this repo should know. Facts must be grounded in the evidence.
3. If a repeatable pattern worth saving as a procedure emerged (a fix that worked, a configuration that succeeded reliably, a medic finding that recurred), describe it in 2–4 sentences as a reusable skill.

Rules:
- Assert only what the events prove. No speculation.
- Facts land in the team's persistent knowledge base and influence future enricher prompts — be precise.
- Confidence 0.9–1.0: strongly evidenced. 0.6–0.9: probable. Below 0.6: skip the fact.
- Skills should be phrased as procedures: "When <condition>, do <action> because <reason>."
- If nothing novel happened, return empty facts and skills arrays.

Return ONLY a JSON object inside <json>...</json> tags:
{
  "lesson": "one sentence",
  "facts": [
    { "key": "short_snake_case_identifier", "value": "concrete value string", "confidence": 0.0–1.0 }
  ],
  "skills": [
    { "title": "short title", "body": "2–4 sentence procedure", "tags": ["tag"] }
  ]
}`;

export interface LearnOptions {
  apiKey?: string;
  disable?: boolean;
}

interface LearnResult {
  lesson: string;
  facts: { key: string; value: string; confidence: number }[];
  skills: { title: string; body: string; tags: string[] }[];
}

/**
 * Post-run learning pass. Calls Opus to extract a lesson, persistent facts,
 * and reusable skill docs from the run evidence, then writes them to memory.
 *
 * This is the closed loop: runs produce evidence → Opus extracts patterns →
 * memory stores them → future enricher prompts load them → better plans.
 *
 * Never throws — a failed learn pass must not fail the run.
 */
export async function learnFromRun(
  run: Run,
  events: RunEvent[],
  plan: ConvoyPlan | null,
  memory: ConvoyMemory,
  opts: LearnOptions = {},
): Promise<void> {
  if (opts.disable) return;

  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return;

  const targetPath = plan?.target.localPath ?? run.repoUrl;

  // Summarize the last 40 events (enough context without token bloat)
  const eventLines = events
    .slice(-40)
    .map(
      (e) =>
        `[${e.stage}/${e.kind}${e.laneId ? `/${e.laneId}` : ''}] ${JSON.stringify(e.payload).slice(0, 240)}`,
    )
    .join('\n');

  const context = {
    runId: run.id,
    status: run.status,
    platform: run.platform,
    repoUrl: run.repoUrl,
    outcomeReason: run.outcomeReason ?? null,
    stagesReached: [...new Set(events.map((e) => e.stage))],
    plan: plan
      ? {
          ecosystem: plan.target.ecosystem,
          framework: plan.target.framework,
          platform: plan.platform.chosen,
          risks: plan.risks.map((r) => `[${r.level}] ${r.message}`),
        }
      : null,
  };

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<run-context>\n${JSON.stringify(context, null, 2)}\n</run-context>\n\n<run-events>\n${eventLines}\n</run-events>\n\nExtract lessons, facts, and skills from this run.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const result = parseLearnResult(text);
    if (!result) return;

    // Record the compressed outcome
    memory.recordOutcome({
      runId: run.id,
      targetPath,
      platform: run.platform,
      status: run.status,
      p99Ms: extractMetric(events, ['p99', 'p99Ms', 'p99_ms']),
      errorRate: extractMetric(events, ['errorRate', 'error_rate']),
      stageReached: events.length > 0 ? (events[events.length - 1]?.stage ?? null) : null,
      medicClassification: extractMedicClass(events),
      lesson: result.lesson || null,
    });

    // Persist facts
    for (const f of result.facts) {
      if (f.confidence >= 0.6) {
        memory.setFact(f.key, f.value, targetPath, f.confidence, run.id);
      }
    }

    // Persist skills
    for (const s of result.skills) {
      memory.saveSkill({ targetPath, title: s.title, body: s.body, tags: s.tags });
    }
  } catch {
    // Learning failures are advisory — never propagate
  }
}

function parseLearnResult(text: string): LearnResult | null {
  const match = text.match(/<json>([\s\S]*?)<\/json>/);
  const raw = match?.[1]?.trim() ?? text.trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const lesson = typeof obj['lesson'] === 'string' ? obj['lesson'].trim() : '';
    const facts = Array.isArray(obj['facts'])
      ? (obj['facts'] as unknown[]).flatMap((f) => {
          if (
            f &&
            typeof f === 'object' &&
            typeof (f as Record<string, unknown>)['key'] === 'string' &&
            typeof (f as Record<string, unknown>)['value'] === 'string' &&
            typeof (f as Record<string, unknown>)['confidence'] === 'number'
          ) {
            const ff = f as { key: string; value: string; confidence: number };
            return [{ key: ff.key.trim(), value: ff.value.trim(), confidence: ff.confidence }];
          }
          return [];
        })
      : [];
    const skills = Array.isArray(obj['skills'])
      ? (obj['skills'] as unknown[]).flatMap((s) => {
          if (
            s &&
            typeof s === 'object' &&
            typeof (s as Record<string, unknown>)['title'] === 'string' &&
            typeof (s as Record<string, unknown>)['body'] === 'string'
          ) {
            const ss = s as { title: string; body: string; tags?: unknown };
            const tags = Array.isArray(ss.tags)
              ? (ss.tags as unknown[]).filter((t): t is string => typeof t === 'string')
              : [];
            return [{ title: ss.title.trim(), body: ss.body.trim(), tags }];
          }
          return [];
        })
      : [];
    return { lesson, facts, skills };
  } catch {
    return null;
  }
}

function extractMetric(events: RunEvent[], keys: string[]): number | null {
  // Walk backwards to find the most recent event carrying one of the metric keys
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    for (const k of keys) {
      if (typeof p[k] === 'number') return p[k] as number;
    }
  }
  return null;
}

function extractMedicClass(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // medic events are appended under the stage that triggered them (e.g. 'rehearse');
    // check the payload for a classification field regardless of stage name.
    if (e?.kind === 'finished') {
      const p = e.payload as Record<string, unknown> | null;
      if (p && typeof p['classification'] === 'string') return p['classification'];
    }
  }
  return null;
}
