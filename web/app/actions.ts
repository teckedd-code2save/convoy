'use server';

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { revalidatePath } from 'next/cache';

import { appendChatTurn, listChatTurns } from '@/lib/medic-chat';
import {
  appendAlreadySet,
  appendSecret,
  unstageKey,
  writeRecurringPref,
} from '@/lib/plan-env';
import { getPlan } from '@/lib/plans';
import { decideApproval as decide, listEvents } from '@/lib/runs';

const MEDIC_MODEL = 'claude-opus-4-7';
const CHAT_MAX_TOKENS = 900;

export async function decideApproval(
  runId: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<{ ok: boolean; reason?: string }> {
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, reason: 'invalid decision' };
  }
  if (!runId || typeof runId !== 'string') {
    return { ok: false, reason: 'invalid runId' };
  }
  if (!approvalId || typeof approvalId !== 'string') {
    return { ok: false, reason: 'invalid approvalId' };
  }
  const updated = decide(runId, approvalId, decision);
  if (!updated) {
    return { ok: false, reason: 'approval already decided, not found, or does not belong to this run' };
  }
  revalidatePath(`/runs/${runId}`);
  return { ok: true };
}

/**
 * Continue the medic's conversation about a specific run's diagnosis. The
 * agent already ran its tool loop and emitted a verdict; this lets the
 * operator ask follow-up questions (why, what about X, explain line 44,
 * etc.) without re-spawning the whole investigation.
 *
 * Context passed to Claude:
 * - the original diagnosis card (rootCause, narrative, etc.)
 * - the tool calls the agent made during investigation
 * - prior chat turns for this run
 * - the operator's new question
 *
 * No tools in the chat loop — this is a Q&A over evidence the agent has
 * already gathered. If the operator needs fresh investigation, they
 * re-run the pipeline. Keeps latency tight and context bounded.
 */
export async function askMedic(
  runId: string,
  question: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!runId || typeof runId !== 'string') {
    return { ok: false, reason: 'invalid runId' };
  }
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty question' };
  }
  if (trimmed.length > 4000) {
    return { ok: false, reason: 'question too long (max 4000 chars)' };
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    appendChatTurn(runId, 'user', trimmed);
    appendChatTurn(
      runId,
      'assistant',
      "I don't have an API key wired up in the web server's env, so I can only answer from the static diagnosis. Set ANTHROPIC_API_KEY in the env of the process running `next dev` and ask again.",
    );
    revalidatePath(`/runs/${runId}`);
    return { ok: true };
  }

  const events = listEvents(runId);
  const diagnosisEvent = [...events].reverse().find((e) => e.kind === 'diagnosis');
  if (!diagnosisEvent) {
    return { ok: false, reason: 'no diagnosis found for this run' };
  }

  const diagnosis = diagnosisEvent.payload as Record<string, unknown> | null;
  const toolCalls = events.filter((e) => {
    if (e.kind !== 'progress') return false;
    const p = e.payload as Record<string, unknown> | null;
    return p !== null && p['phase'] === 'medic.tool_use';
  });
  const priorTurns = listChatTurns(runId);

  const systemPrompt = `You are the Convoy medic. You already investigated a rehearsal breach for this run and emitted a structured diagnosis. The operator is now asking follow-up questions.

Rules:
- Answer from the evidence you already gathered. You do not have tools in this chat — you cannot re-read files, re-grep, or run commands. If the question needs fresh investigation, say so and recommend re-running the pipeline. If the question needs the fix to be APPLIED, tell the operator to use the "Hand off to Claude Code" button on the diagnosis card (that Claude Code session has file-edit + shell tools; you don't).
- When the operator asks "how do I fix this", "what commands do I run", or similar: respond with a short explanation plus a fenced shell block containing the exact commands (including the resume command: \`npm run convoy -- apply <plan-id>\`). The diagnosis payload already includes a resume command in its fix-actions block — point the operator at the commands block on the card rather than making up your own resume command.
- Be concise. 1-3 short paragraphs, plain text. No XML, HTML, or tool-use markup inside your response. Fenced \`\`\`...\`\`\` code blocks are fine and encouraged for shell commands.
- Stay in first person, consistent with the original diagnosis.
- Never suggest modifying developer-owned code (src/, app/, lib/, tests) yourself — Convoy's rule is you diagnose; the developer (or Claude Code via handoff) applies the fix.
- If the operator pushes on your confidence or conclusions, acknowledge uncertainty honestly.`;

  const diagnosisSummary = JSON.stringify(
    {
      rootCause: diagnosis?.['rootCause'],
      classification: diagnosis?.['classification'],
      confidence: diagnosis?.['confidence'],
      location: diagnosis?.['location'],
      narrative: diagnosis?.['narrative'],
      suggestedFix: diagnosis?.['suggestedFix'],
      reproduction: diagnosis?.['reproduction'],
    },
    null,
    2,
  );

  const toolCallSummary = toolCalls
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return `- ${p['tool']}: ${JSON.stringify(p['input'])}`;
    })
    .join('\n');

  const investigationContext = `Original diagnosis card for this run:
${diagnosisSummary}

Tool calls I made during investigation (${toolCalls.length} total):
${toolCallSummary || '(none recorded)'}`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: investigationContext },
    {
      role: 'assistant',
      content:
        "That's the full investigation. What would you like me to clarify or expand on?",
    },
  ];

  for (const turn of priorTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: trimmed });

  // Persist the user's turn BEFORE the API call so it's not lost if the
  // call fails partway through. The assistant turn only lands on success.
  appendChatTurn(runId, 'user', trimmed);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MEDIC_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system: systemPrompt,
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (text.length === 0) {
      appendChatTurn(
        runId,
        'assistant',
        "I didn't produce a response — something went wrong with the model call. Try asking again.",
      );
    } else {
      // Strip the same XML-style leakage we guard against in the main
      // diagnosis path. Follow-up responses are plain text, no markup.
      const cleaned = text.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s+[^>]*)?\/?>/g, '');
      appendChatTurn(runId, 'assistant', cleaned);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendChatTurn(
      runId,
      'assistant',
      `The model call failed: ${message.slice(0, 200)}. The operator's question is logged; retry after addressing the error.`,
    );
  }

  revalidatePath(`/runs/${runId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Config-confirmation panel actions (plan page).
//
// All actions are filesystem-local. Nothing here queries the deploy target.
// The operator is the source of truth for what's set on the platform; we
// record declarations and stage values locally so `convoy apply` can honor
// them. See memory/feedback_no_autonomous_probing.md.
// ---------------------------------------------------------------------------

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_PLATFORMS_LIST = ['fly', 'railway', 'vercel', 'cloudrun'];

/**
 * Stage a KEY=value pair into the plan's .env.convoy-secrets file. If the
 * key was previously marked already-set, this supersedes that declaration.
 */
export async function stageEnvVar(
  planId: string,
  key: string,
  value: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!planId || typeof planId !== 'string') return { ok: false, reason: 'invalid planId' };
  if (!key || !VALID_ENV_KEY.test(key)) return { ok: false, reason: 'invalid env key' };
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'value cannot be empty' };
  }
  if (value.length > 8192) return { ok: false, reason: 'value too long (max 8192 chars)' };
  if (value.includes('\n')) return { ok: false, reason: 'value cannot contain newlines' };

  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan not found' };

  unstageKey(plan, key);
  appendSecret(plan, key, value);
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

/**
 * Declare a key is already set on the platform. Convoy does not query the
 * platform to verify — the operator is vouching. Written to
 * .env.convoy-already-set which the CLI reads on apply (no flag needed).
 */
export async function markEnvVarAlreadySet(
  planId: string,
  key: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!planId || typeof planId !== 'string') return { ok: false, reason: 'invalid planId' };
  if (!key || !VALID_ENV_KEY.test(key)) return { ok: false, reason: 'invalid env key' };

  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan not found' };

  unstageKey(plan, key);
  appendAlreadySet(plan, key);
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function unstageEnvVar(
  planId: string,
  key: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!planId || typeof planId !== 'string') return { ok: false, reason: 'invalid planId' };
  if (!key || !VALID_ENV_KEY.test(key)) return { ok: false, reason: 'invalid env key' };

  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan not found' };

  unstageKey(plan, key);
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function setRecurring(
  planId: string,
  recurring: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  if (!planId || typeof planId !== 'string') return { ok: false, reason: 'invalid planId' };
  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan not found' };
  writeRecurringPref(plan, recurring === true);
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

/**
 * Re-plan the same target with a different platform, saving a new plan and
 * returning its id so the client can redirect.
 *
 * Shells out to the CLI rather than importing buildPlan across the
 * web/core boundary. Keeps web isolated from planner internals.
 */
export async function changePlanPlatform(
  planId: string,
  platform: string,
): Promise<{ ok: boolean; newPlanId?: string; reason?: string }> {
  if (!planId || typeof planId !== 'string') return { ok: false, reason: 'invalid planId' };
  if (!SUPPORTED_PLATFORMS_LIST.includes(platform)) {
    return { ok: false, reason: `platform must be one of ${SUPPORTED_PLATFORMS_LIST.join(', ')}` };
  }
  const plan = getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan not found' };

  const convoyHome = resolve(process.cwd(), '..');
  const args = [
    'run',
    'convoy',
    '--',
    'plan',
    plan.target.localPath,
    '--save',
    '--no-ai',
    `--platform=${platform}`,
  ];
  if (plan.target.repoUrl) {
    args.push(`--repo-url=${plan.target.repoUrl}`);
  }

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise<number>((resolveExit) => {
    const proc = spawn('npm', args, {
      cwd: convoyHome,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('close', (code) => resolveExit(code ?? 1));
    proc.on('error', () => resolveExit(1));
  });

  if (exitCode !== 0) {
    const last = (stderr || stdout).split('\n').slice(-6).join(' ').slice(0, 300);
    return { ok: false, reason: `plan command exited ${exitCode}: ${last}` };
  }

  const match = stdout.match(/plans\/([0-9a-f-]{36})\.json/);
  if (!match || !match[1]) {
    return { ok: false, reason: 'plan saved but could not parse new plan id from CLI output' };
  }

  revalidatePath('/');
  return { ok: true, newPlanId: match[1] };
}
