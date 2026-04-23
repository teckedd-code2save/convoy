'use server';

import Anthropic from '@anthropic-ai/sdk';
import { revalidatePath } from 'next/cache';

import { appendChatTurn, listChatTurns } from '@/lib/medic-chat';
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
- Answer from the evidence you already gathered. You do not have tools in this chat — you cannot re-read files or re-grep. If the question needs fresh investigation, say so explicitly and recommend re-running the pipeline.
- Be concise. 1-3 short paragraphs, plain text. No XML, HTML, or tool-use markup inside your response.
- Stay in first person, consistent with the original diagnosis.
- Never suggest modifying developer-owned code (src/, app/, lib/, tests). Convoy's rule is you diagnose; the developer fixes.
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
