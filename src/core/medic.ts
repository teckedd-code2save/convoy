import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 1800;

const SYSTEM_PROMPT = `You are the Convoy medic — a diagnostic subagent. A rehearsal or canary just failed. Your job is to read the logs and failure context and produce a structured diagnosis.

Critical rules:
1. **Never propose modifying files outside the provided \`convoyAuthoredFiles\` list.** Anything in \`src/\`, \`app/\`, \`lib/\`, tests, or application dependencies is developer-owned. You produce a *diagnosis card* for those — reading material for the developer, not a patch.
2. If the root cause is in a Convoy-authored file (Dockerfile, platform manifest, CI workflow, .env.schema), classification=\"config\" and you may describe a patch.
3. If the root cause is in developer code, classification=\"code\" and the suggestedFix field describes the fix conceptually but \`owned\` must be \"developer\".
4. Never claim certainty you don't have. If the signal is ambiguous, confidence=\"low\" and say what additional diagnostic you'd want.
5. Speak in first person ("I see...", "I think..."). You are the medic reporting a diagnosis.

Respond ONLY with JSON inside <json>...</json> tags. Shape:
{
  "rootCause": "One sentence. Specific. Cites the evidence.",
  "classification": "config" | "code" | "infrastructure" | "unknown",
  "confidence": "high" | "medium" | "low",
  "location": { "file": "src/routes/orders.ts", "line": 44 } | null,
  "reproduction": "Shell command or URL the developer can use to reproduce, or null.",
  "suggestedFix": {
    "file": "<path>",
    "owned": "convoy" | "developer",
    "description": "Plain-language fix description.",
    "patch": "<optional unified diff or replacement content, only if owned=convoy>"
  } | null,
  "narrative": "2-3 sentences, first person, what I observed and concluded."
}`;

export interface DiagnosisInput {
  stage: string;
  phase: string;
  repoPath: string;
  convoyAuthoredFiles: string[];
  logs: string[];
  metrics?: Record<string, unknown>;
  errorMessage?: string;
  scanContext?: Record<string, unknown>;
}

export interface DiagnosisFix {
  file: string;
  owned: 'convoy' | 'developer';
  description: string;
  patch?: string;
}

export interface Diagnosis {
  rootCause: string;
  classification: 'config' | 'code' | 'infrastructure' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  location?: { file: string; line?: number };
  reproduction?: string;
  suggestedFix?: DiagnosisFix;
  narrative: string;
  source: 'ai' | 'skipped-no-key' | 'error';
}

export async function diagnose(
  input: DiagnosisInput,
  opts: { apiKey?: string; model?: string } = {},
): Promise<Diagnosis> {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return fallbackDiagnosis(input, 'skipped-no-key');
  }
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: opts.model ?? MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = parseDiagnosis(text);
    if (!parsed) return fallbackDiagnosis(input, 'error');
    return { ...parsed, source: 'ai' };
  } catch {
    return fallbackDiagnosis(input, 'error');
  }
}

function buildPrompt(input: DiagnosisInput): string {
  const logsExcerpt = input.logs.slice(-80).join('\n'); // last 80 lines
  return `<failure>
stage: ${input.stage}
phase: ${input.phase}
${input.errorMessage ? `error: ${input.errorMessage}` : ''}
</failure>

<metrics>
${input.metrics ? JSON.stringify(input.metrics, null, 2) : '(none)'}
</metrics>

<logs>
${logsExcerpt || '(no logs)'}
</logs>

<scan-context>
${input.scanContext ? JSON.stringify(input.scanContext, null, 2) : '(none)'}
</scan-context>

<convoy-authored-files>
${input.convoyAuthoredFiles.join('\n') || '(none)'}
</convoy-authored-files>

<repo-path>${input.repoPath}</repo-path>

Produce the diagnosis JSON. If the root cause is in a file NOT in convoy-authored-files, set suggestedFix.owned="developer" and do not include a patch — just describe the fix.`;
}

function parseDiagnosis(text: string): Omit<Diagnosis, 'source'> | null {
  const match = text.match(/<json>([\s\S]*?)<\/json>/);
  const raw = match?.[1]?.trim() ?? text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['rootCause'] !== 'string') return null;
    if (typeof obj['narrative'] !== 'string') return null;

    const classification = obj['classification'];
    if (classification !== 'config' && classification !== 'code' && classification !== 'infrastructure' && classification !== 'unknown') {
      return null;
    }
    const confidence = obj['confidence'];
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
      return null;
    }

    const out: Omit<Diagnosis, 'source'> = {
      rootCause: obj['rootCause'].trim(),
      classification,
      confidence,
      narrative: obj['narrative'].trim(),
    };

    const location = obj['location'];
    if (location && typeof location === 'object') {
      const l = location as Record<string, unknown>;
      if (typeof l['file'] === 'string') {
        out.location = {
          file: l['file'].trim(),
          ...(typeof l['line'] === 'number' && { line: l['line'] }),
        };
      }
    }

    if (typeof obj['reproduction'] === 'string') {
      out.reproduction = obj['reproduction'].trim();
    }

    const fix = obj['suggestedFix'];
    if (fix && typeof fix === 'object') {
      const f = fix as Record<string, unknown>;
      const file = f['file'];
      const owned = f['owned'];
      const description = f['description'];
      if (
        typeof file === 'string' &&
        (owned === 'convoy' || owned === 'developer') &&
        typeof description === 'string'
      ) {
        out.suggestedFix = {
          file: file.trim(),
          owned,
          description: description.trim(),
          ...(typeof f['patch'] === 'string' && { patch: f['patch'] }),
        };
      }
    }

    return out;
  } catch {
    return null;
  }
}

function fallbackDiagnosis(input: DiagnosisInput, source: 'skipped-no-key' | 'error'): Diagnosis {
  return {
    rootCause: input.errorMessage ?? `${input.stage} ${input.phase} reported a failure`,
    classification: 'unknown',
    confidence: 'low',
    narrative:
      source === 'skipped-no-key'
        ? `I don't have an API key wired up, so I can only surface the raw failure. Set ANTHROPIC_API_KEY to get a real diagnosis.`
        : `I hit an error while diagnosing. The raw failure context is preserved in the run events.`,
    source,
  };
}
