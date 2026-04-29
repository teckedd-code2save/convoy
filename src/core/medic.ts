import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import type { DeveloperHandoffPacket, LaneRole, Platform } from './types.js';

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 2000;
// Agent loop cap: enough for ~3 evidence-gathering tool calls plus finalize.
// Raising this linearly raises cost; 6 has been enough in practice.
const MAX_TURNS = 6;

/**
 * Convoy's medic is a Claude agent loop — not a single-shot enrichment call.
 * When rehearsal breaches, we hand the failure context to Opus 4.7 along with
 * four scoped tools:
 *   - read_log_tail: last N lines of the captured subprocess output
 *   - read_file: slice of any file under the repo root (path-safety enforced)
 *   - grep_repo: ripgrep/grep over the repo with an optional subpath scope
 *   - finalize_diagnosis: the "I'm done" tool that emits the structured card
 *
 * Each tool call is streamed to the caller via `onToolCall` so the CLI and
 * web UI can show "the medic is reading src/routes/orders.ts:42-86" live.
 *
 * This is the intuitive use of Claude as a managed agent the README leads
 * with: scoped tools, bounded loop, evidence → hypothesis → patch proposal.
 */
const SYSTEM_PROMPT = `You are the Convoy medic — a diagnostic agent. A rehearsal or canary just breached. Your job: use your tools to gather evidence, then call finalize_diagnosis with a structured verdict.

Protocol:
1. Start by calling read_log_tail to see what the subprocess actually printed. You only get what rehearsal captured; there is nothing else.
2. Form a hypothesis. Use read_file and grep_repo to verify it. Read before you conclude — no ungrounded guesses.
3. Stop investigating once you have enough evidence. Call finalize_diagnosis and end the loop.

Hard rules:
- **Never propose modifying files outside the provided convoyAuthoredFiles list.** Anything in src/, app/, lib/, tests, or application dependencies is developer-owned. For those, you produce a diagnosis card with owned="developer" and NO patch — just a plain-language description.
- If the root cause is in a Convoy-authored file (Dockerfile, platform manifest, CI workflow, .env.schema), classification="config" and you MAY describe a patch.
- Never claim certainty you don't have. Ambiguous signal → confidence="low".
- Speak in first person ("I see...", "I checked..."). You are the medic reporting what you found.

Output format — critical:
- The narrative, reproduction, and suggestedFix.description fields are rendered as plain text in a CLI + web UI.
- Do NOT embed XML, HTML, or tool-use markup inside those strings. No </narrative>, <parameter name="...">, or similar. Just sentences.
- Do NOT quote the raw JSON schema back in prose. You are writing for a human operator reading the card.
- Keep narrative to 2-3 sentences. Keep description to one short paragraph. Reproduction is a single shell command or URL.

You have at most ${MAX_TURNS} turns. Budget them: evidence first, finalize once you're confident.`;

/**
 * Strips tool-use-style XML leakage (</narrative>, <parameter name="...">,
 * <json>...</json>) that the model sometimes embeds inside string-typed
 * tool inputs. Safe for plain prose — real sentences don't contain angle
 * brackets around lowercase identifiers.
 */
function sanitizeProse(value: string): string {
  return value
    // open + close tags like <narrative>, </narrative>, <parameter name="x">
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s+[^>]*)?\/?>/g, '')
    // stray fenced blocks
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/```\s*$/, '')
    // collapse whitespace the stripping left behind
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface DiagnosisInput {
  stage: string;
  phase: string;
  laneId?: string;
  laneRole?: LaneRole;
  servicePath?: string;
  platform?: Platform;
  connectionState?: string;
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
  handoff?: DeveloperHandoffPacket;
  source: 'ai' | 'skipped-no-key' | 'error';
  /**
   * Each tool the agent invoked during the loop, in order. Surfaced to the
   * web UI so operators can replay the medic's reasoning.
   */
  toolCalls?: AgentToolCall[];
}

export interface AgentToolCall {
  name: string;
  input: unknown;
  /** Truncated tool-result preview (first 400 chars) for UI display. */
  resultPreview?: string;
}

export interface DiagnoseOptions {
  apiKey?: string;
  model?: string;
  /**
   * Called once per tool invocation the agent makes. Fires before the tool
   * executes; `resultPreview` on the returned AgentToolCall comes from the
   * executed result. Use this to emit run events so the web UI streams the
   * medic's investigation live.
   */
  onToolCall?: (call: AgentToolCall) => void;
}

export async function diagnose(
  input: DiagnosisInput,
  opts: DiagnoseOptions = {},
): Promise<Diagnosis> {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return fallbackDiagnosis(input, 'skipped-no-key');
  }

  const client = new Anthropic({ apiKey });
  const tools = buildTools();
  const toolCallsRecord: AgentToolCall[] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialPrompt(input) },
  ];

  let finalDiagnosis: Omit<Diagnosis, 'source' | 'toolCalls'> | null = null;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response = await client.messages.create({
        model: opts.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        // Model stopped without calling finalize. Treat any text as narrative.
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const record: AgentToolCall = { name: tu.name, input: tu.input };
        opts.onToolCall?.(record);

        if (tu.name === 'finalize_diagnosis') {
          finalDiagnosis = parseFinalize(tu.input);
          record.resultPreview = finalDiagnosis
            ? `finalized: ${finalDiagnosis.rootCause.slice(0, 120)}`
            : 'finalize_diagnosis rejected — missing required fields';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: finalDiagnosis ? 'diagnosis recorded' : 'invalid diagnosis shape; try again',
            is_error: finalDiagnosis ? false : true,
          });
        } else {
          const result = await executeTool(tu.name, tu.input, input);
          record.resultPreview = result.slice(0, 400);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result,
          });
        }
        toolCallsRecord.push(record);
      }

      if (finalDiagnosis) break;

      messages.push({ role: 'user', content: toolResults });

      if (response.stop_reason === 'end_turn') break;
    }

    if (!finalDiagnosis) {
      return withHandoff({
        ...fallbackDiagnosis(input, 'error'),
        toolCalls: toolCallsRecord,
      }, input);
    }
    return withHandoff({
      ...finalDiagnosis,
      source: 'ai',
      toolCalls: toolCallsRecord,
    }, input);
  } catch {
    return withHandoff({
      ...fallbackDiagnosis(input, 'error'),
      toolCalls: toolCallsRecord,
    }, input);
  }
}

function buildInitialPrompt(input: DiagnosisInput): string {
  return `A ${input.stage} stage breach just occurred.

<failure>
stage: ${input.stage}
phase: ${input.phase}
${input.errorMessage ? `error: ${input.errorMessage}` : ''}
</failure>

<metrics>
${input.metrics ? JSON.stringify(input.metrics, null, 2) : '(none)'}
</metrics>

<scan-context>
${input.scanContext ? JSON.stringify(input.scanContext, null, 2) : '(none)'}
</scan-context>

<convoy-authored-files>
${input.convoyAuthoredFiles.join('\n') || '(none)'}
</convoy-authored-files>

repo root: ${input.repoPath}
captured log lines: ${input.logs.length}

Start by reading the log tail. Then use read_file / grep_repo to check anything the logs point at. Call finalize_diagnosis as soon as you have a root cause.`;
}

function buildTools(): Anthropic.Tool[] {
  return [
    {
      name: 'read_log_tail',
      description:
        'Return the last N lines of the subprocess output captured during rehearsal. These are the only logs available — there is no other log source to query.',
      input_schema: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
            description: 'Number of tail lines to return (1..500).',
          },
        },
        required: ['n'],
      },
    },
    {
      name: 'read_file',
      description:
        'Read a file from the repo under a line range. Path is relative to repo root (e.g. "src/routes/orders.ts"). Paths escaping the repo root are refused.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path from repo root.',
          },
          start_line: {
            type: 'number',
            description: 'Optional start line (1-indexed, inclusive).',
          },
          end_line: {
            type: 'number',
            description: 'Optional end line (inclusive). Defaults to start+200 or EOF.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'grep_repo',
      description:
        'Grep a regex across the repo, returning matches as `path:line: content`. Capped at 80 matches. Use `path` to scope to a subdirectory.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Extended regex pattern.',
          },
          path: {
            type: 'string',
            description: 'Optional subdirectory (relative to repo root) to scope the grep.',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'finalize_diagnosis',
      description:
        'Record your final diagnosis and end the investigation. Call this exactly once, when you have enough evidence.',
      input_schema: {
        type: 'object',
        properties: {
          rootCause: {
            type: 'string',
            description: 'One sentence. Specific. Cites the evidence you gathered.',
          },
          classification: {
            type: 'string',
            enum: ['config', 'code', 'infrastructure', 'unknown'],
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          location: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['file'],
          },
          reproduction: {
            type: 'string',
            description: 'Optional shell command or URL the developer can use to reproduce.',
          },
          suggestedFix: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              owned: {
                type: 'string',
                enum: ['convoy', 'developer'],
              },
              description: { type: 'string' },
              patch: {
                type: 'string',
                description: 'Optional replacement content or unified diff. Only include when owned=convoy.',
              },
            },
            required: ['file', 'owned', 'description'],
          },
          narrative: {
            type: 'string',
            description: '2-3 first-person sentences describing what you observed and concluded.',
          },
        },
        required: ['rootCause', 'classification', 'confidence', 'narrative'],
      },
    },
  ];
}

async function executeTool(
  name: string,
  input: unknown,
  ctx: DiagnosisInput,
): Promise<string> {
  try {
    if (name === 'read_log_tail') {
      const { n } = (input ?? {}) as { n?: number };
      const take = Math.max(1, Math.min(500, Math.floor(Number(n) || 80)));
      const lines = ctx.logs.slice(-take);
      return lines.length > 0 ? lines.join('\n') : '(no log lines captured)';
    }

    if (name === 'read_file') {
      const { path: p, start_line, end_line } = (input ?? {}) as {
        path?: string;
        start_line?: number;
        end_line?: number;
      };
      if (typeof p !== 'string' || p.length === 0) return 'ERROR: missing path';
      const abs = resolveUnderRoot(ctx.repoPath, p);
      if (!abs) return 'ERROR: path escapes repo root';
      if (!existsSync(abs)) return `ERROR: file not found: ${p}`;
      const stat = statSync(abs);
      if (stat.isDirectory()) return `ERROR: ${p} is a directory, not a file`;
      if (stat.size > 2_000_000) return `ERROR: file too large (${stat.size} bytes)`;
      const content = readFileSync(abs, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, Math.floor(Number(start_line) || 1));
      const maxEnd = typeof end_line === 'number' ? Math.floor(end_line) : start + 200;
      const end = Math.max(start, Math.min(lines.length, maxEnd));
      const slice = lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}: ${l}`)
        .join('\n');
      return `${p} [lines ${start}-${end} of ${lines.length}]\n${slice}`;
    }

    if (name === 'grep_repo') {
      const { pattern, path: p } = (input ?? {}) as { pattern?: string; path?: string };
      if (typeof pattern !== 'string' || pattern.length === 0) return 'ERROR: missing pattern';
      const scope = typeof p === 'string' && p.length > 0
        ? resolveUnderRoot(ctx.repoPath, p)
        : resolve(ctx.repoPath);
      if (!scope) return 'ERROR: path escapes repo root';
      return await grepFiles(scope, pattern);
    }

    return `ERROR: unknown tool ${name}`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function resolveUnderRoot(root: string, rel: string): string | null {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  // Path-traversal guard — the agent's tools must never escape the repo root.
  if (abs !== rootAbs && !abs.startsWith(`${rootAbs}/`)) return null;
  return abs;
}

async function grepFiles(scope: string, pattern: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const MAX_MATCHES = 80;
    const TIMEOUT_MS = 4000;
    // -rEn = recursive, extended regex, line numbers
    // --binary-files=without-match skips binary files cleanly
    // Exclude common noise directories that would bloat output.
    const proc = spawn(
      'grep',
      [
        '-rEn',
        '--binary-files=without-match',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=dist',
        '--exclude-dir=build',
        '--exclude-dir=.next',
        '--exclude-dir=.convoy',
        '--exclude-dir=.venv',
        '-m',
        String(MAX_MATCHES),
        '--',
        pattern,
        scope,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > 16_000) {
        out = `${out.slice(0, 16_000)}\n... (truncated)`;
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (out.length === 0 && code !== 0 && err.length > 0) {
        resolvePromise(`(no matches; grep: ${err.trim().split('\n')[0]})`);
      } else if (out.length === 0) {
        resolvePromise('(no matches)');
      } else {
        // Strip the repo-root prefix from each line so paths stay relative.
        const relScope = scope.endsWith('/') ? scope : `${scope}/`;
        resolvePromise(
          out
            .split('\n')
            .map((l) => l.replace(relScope, ''))
            .join('\n'),
        );
      }
    });
  });
}

function parseFinalize(input: unknown): Omit<Diagnosis, 'source' | 'toolCalls'> | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  const rootCause =
    typeof obj['rootCause'] === 'string' ? sanitizeProse(obj['rootCause']) : null;
  const narrative =
    typeof obj['narrative'] === 'string' ? sanitizeProse(obj['narrative']) : null;
  const classification = obj['classification'];
  const confidence = obj['confidence'];

  if (!rootCause || !narrative) return null;
  if (
    classification !== 'config' &&
    classification !== 'code' &&
    classification !== 'infrastructure' &&
    classification !== 'unknown'
  ) {
    return null;
  }
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null;

  const out: Omit<Diagnosis, 'source' | 'toolCalls'> = {
    rootCause,
    classification,
    confidence,
    narrative,
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
    out.reproduction = sanitizeProse(obj['reproduction']);
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
        description: sanitizeProse(description),
        ...(typeof f['patch'] === 'string' && { patch: f['patch'] }),
      };
    }
  }

  return out;
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

function withHandoff(diagnosis: Diagnosis, input: DiagnosisInput): Diagnosis {
  const ownedByDeveloper =
    diagnosis.suggestedFix?.owned === 'developer' || diagnosis.classification === 'code';
  if (!ownedByDeveloper || !input.laneId || !input.servicePath || !input.platform) {
    return diagnosis;
  }
  return {
    ...diagnosis,
    handoff: {
      laneId: input.laneId,
      laneRole: input.laneRole ?? 'backend',
      servicePath: input.servicePath,
      platform: input.platform,
      connectionState: input.connectionState ?? 'unknown',
      rootCause: diagnosis.rootCause,
      evidence: diagnosis.location?.file ? [diagnosis.location.file] : [],
      reproduction: diagnosis.reproduction,
      suggestedFix: diagnosis.suggestedFix?.description,
      resumeInstructions:
        `Fix the developer-owned issue in ${input.servicePath}, then rerun \`convoy resume\` to continue the same multi-lane run.`,
    },
  };
}
