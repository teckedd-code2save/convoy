import Anthropic from '@anthropic-ai/sdk';

import type { RunEvent } from './types.js';

const COMPRESS_MODEL = 'claude-opus-4-7';

/**
 * Mid-loop compression fires when accumulated message history exceeds this.
 * ~3 000 tokens — enough for one verbose log tail plus two file reads.
 */
const MEDIC_THRESHOLD_CHARS = 12_000;

/**
 * Event compression fires when the serialized event log exceeds this.
 * ~8 000 tokens — a long multi-lane run before the learn pass truncated.
 */
const EVENT_THRESHOLD_CHARS = 32_000;

// ── Medic loop compression ────────────────────────────────────────────────

function estimateMessageChars(messages: Anthropic.MessageParam[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') {
        total += block.text.length;
      } else if (block.type === 'tool_use') {
        total += JSON.stringify(block.input).length;
      } else if (block.type === 'tool_result') {
        const c = block.content;
        if (typeof c === 'string') total += c.length;
        else if (Array.isArray(c)) {
          for (const sub of c) {
            if (sub.type === 'text') total += sub.text.length;
          }
        }
      }
    }
  }
  return total;
}

/**
 * Compress the medic agent's message history when it gets large mid-loop.
 *
 * Hermes fires this at ~50% context usage. Here we trigger when accumulated
 * message chars exceed MEDIC_THRESHOLD_CHARS (roughly 3 000 tokens).
 *
 * Strategy: Opus reads all the tool results gathered so far and produces a
 * compact "findings so far" paragraph. The detailed message chain is replaced
 * with:
 *   [initial_user_prompt]  +  [compressed_findings]  +  [last_assistant_turn]
 *
 * The last assistant turn is kept so the model knows where it left off.
 * Falls back to the original messages on any error.
 */
export async function compressMessageHistory(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  model: string,
): Promise<{ messages: Anthropic.MessageParam[]; compressed: boolean }> {
  if (messages.length < 4 || estimateMessageChars(messages) < MEDIC_THRESHOLD_CHARS) {
    return { messages, compressed: false };
  }

  // Collect all tool-result content blocks (the verbose parts)
  const evidenceParts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue;
      const c = block.content;
      if (typeof c === 'string') {
        evidenceParts.push(c.slice(0, 2_000));
      } else if (Array.isArray(c)) {
        for (const sub of c) {
          if (sub.type === 'text') evidenceParts.push(sub.text.slice(0, 2_000));
        }
      }
    }
  }

  const evidenceText = evidenceParts.join('\n\n---\n\n');
  if (!evidenceText.trim()) return { messages, compressed: false };

  try {
    const summaryResponse = await client.messages.create({
      model,
      max_tokens: 800,
      system:
        'You are compressing evidence gathered during a debugging investigation. ' +
        'Produce a compact but complete summary that preserves: error patterns, ' +
        'file paths, suspicious code snippets, metric values, and current working ' +
        'hypothesis. This replaces raw tool output in the conversation context — ' +
        'nothing important may be lost.',
      messages: [
        {
          role: 'user',
          content: `Summarize the evidence gathered so far (keep all key technical details):\n\n${evidenceText.slice(0, 20_000)}`,
        },
      ],
    });

    const summary = summaryResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!summary) return { messages, compressed: false };

    // Keep: initial user prompt + compressed findings + last assistant turn
    const initial = messages[0]!;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

    const rebuilt: Anthropic.MessageParam[] = [
      initial,
      {
        role: 'user',
        content: `[Findings so far — compressed to preserve context budget]\n\n${summary}`,
      },
      ...(lastAssistant ? [lastAssistant] : []),
    ];

    return { messages: rebuilt, compressed: true };
  } catch {
    return { messages, compressed: false };
  }
}

// ── Learn-pass event compression ──────────────────────────────────────────

/**
 * Format and optionally compress a run's event log for the learn pass.
 *
 * If the formatted events fit within EVENT_THRESHOLD_CHARS, return them
 * verbatim. If they exceed the threshold, call Opus to produce a compressed
 * narrative that preserves stage outcomes, metric values, error messages,
 * and medic findings — without the full verbose payload of every event.
 *
 * Falls back to tail truncation if no API key is available or if the
 * compression call fails.
 */
export async function compressRunEvents(
  events: RunEvent[],
  opts: { apiKey?: string; model?: string } = {},
): Promise<string> {
  const formatEvent = (e: RunEvent) =>
    `[${e.stage}/${e.kind}${e.laneId ? `/${e.laneId}` : ''}] ${JSON.stringify(e.payload).slice(0, 400)}`;

  const full = events.map(formatEvent).join('\n');

  if (full.length <= EVENT_THRESHOLD_CHARS) {
    return full;
  }

  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    // No key — tail truncation only
    return events.slice(-40).map(formatEvent).join('\n');
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: opts.model ?? COMPRESS_MODEL,
      max_tokens: 1_000,
      system:
        'You are compressing a deployment run event log for a learning agent. ' +
        'Extract and preserve: which stages ran and their outcome, any p99/error_rate ' +
        'metric values, error messages or stack traces, medic classification and ' +
        'root cause if present, and the final run status. Omit repetitive boilerplate ' +
        'and verbose but uninformative payloads. Output a compact technical summary.',
      messages: [
        {
          role: 'user',
          content: `Compress this run event log, keeping all key technical facts:\n\n${full.slice(0, 60_000)}`,
        },
      ],
    });

    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return summary || events.slice(-40).map(formatEvent).join('\n');
  } catch {
    return events.slice(-40).map(formatEvent).join('\n');
  }
}
