'use client';

import { useMemo, useState } from 'react';

interface MedicDiagnosisForFix {
  rootCause: string;
  classification: string;
  confidence: string;
  location?: { file: string; line?: number };
  reproduction?: string;
  suggestedFix?: {
    file: string;
    owned: 'convoy' | 'developer';
    description: string;
    patch?: string;
  };
  narrative: string;
  source: string;
}

interface ToolCallTrace {
  tool: string;
  inputSummary: string;
  timestamp: string;
}

/**
 * Fix & resume actions rendered at the top of the diagnosis card. Two
 * things the medic chat cannot do from a browser:
 *
 *   1. Show the operator the exact resume command so they don't have to
 *      reconstruct `npm run convoy -- apply <plan-id-prefix>` from memory.
 *   2. Hand the investigation off to a Claude Code session that actually
 *      has file-edit + shell tools, so the fix can be applied without
 *      leaving Claude.
 *
 * Both are pure client-side UI — we copy text, we don't call any action.
 */
export function FixActions({
  diagnosis,
  planId,
  runId,
  toolCalls,
  repoUrl,
}: {
  diagnosis: MedicDiagnosisForFix;
  planId: string | null;
  runId: string;
  toolCalls: ToolCallTrace[];
  repoUrl: string;
}) {
  const planPrefix = planId ? planId.slice(0, 8) : null;
  const resumeCommand = planPrefix
    ? `npm run convoy -- apply ${planPrefix}`
    : null;

  const commandsBlock = useMemo(
    () => buildCommandsBlock(diagnosis, resumeCommand),
    [diagnosis, resumeCommand],
  );

  const handoffPrompt = useMemo(
    () => buildHandoffPrompt(diagnosis, planPrefix, runId, toolCalls, repoUrl),
    [diagnosis, planPrefix, runId, toolCalls, repoUrl],
  );

  return (
    <div className="space-y-4 pt-4 pb-1">
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Fix & resume
          </h3>
          <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
            {resumeCommand ? 'includes resume command' : 'resume command unavailable (no plan linked)'}
          </span>
        </div>
        <CopyBlock text={commandsBlock} label="Copy commands" />
      </div>

      <HandoffBlock prompt={handoffPrompt} />
    </div>
  );
}

function HandoffBlock({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Hand off to Claude Code
        </h3>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
          file-edit + shell tools
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs font-medium ml-auto px-3 py-1 rounded-md border border-rule hover:bg-rule/30 transition"
        >
          {open ? 'hide prompt' : 'show prompt'}
        </button>
      </div>
      {open ? (
        <>
          <p className="text-xs text-muted leading-relaxed">
            Paste into a Claude Code session that has access to this repo. Claude will
            see the diagnosis, the evidence the medic gathered, and the exact resume
            command to run once the fix is applied.
          </p>
          <CopyBlock text={prompt} label="Copy handoff prompt" multiline />
        </>
      ) : null}
    </div>
  );
}

function CopyBlock({
  text,
  label,
  multiline = false,
}: {
  text: string;
  label: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for contexts without clipboard API — select the text.
      const el = document.getElementById(`copy-${text.length}-${label}`);
      if (el instanceof HTMLTextAreaElement) el.select();
    }
  };

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          readOnly
          value={text}
          id={`copy-${text.length}-${label}`}
          className="w-full text-xs font-mono bg-ink text-paper rounded-md p-3 border border-rule resize-y min-h-[180px] max-h-[480px] whitespace-pre-wrap break-words"
        />
      ) : (
        <pre className="text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto whitespace-pre-wrap break-words max-h-60">
          {text}
        </pre>
      )}
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 text-[11px] font-medium px-2 py-1 rounded bg-paper/20 backdrop-blur hover:bg-paper/30 text-paper transition"
      >
        {copied ? '✓ copied' : label}
      </button>
    </div>
  );
}

function buildCommandsBlock(
  diagnosis: MedicDiagnosisForFix,
  resumeCommand: string | null,
): string {
  const lines: string[] = [];

  // Header comment pointing at the root cause so the block is self-documenting
  // if pasted into a shell without the surrounding card context.
  if (diagnosis.location?.file) {
    const loc = `${diagnosis.location.file}${diagnosis.location.line ? `:${diagnosis.location.line}` : ''}`;
    lines.push(`# Fix for: ${diagnosis.rootCause}`);
    lines.push(`# Location: ${loc}`);
  } else {
    lines.push(`# Fix for: ${diagnosis.rootCause}`);
  }
  lines.push('');

  if (diagnosis.suggestedFix) {
    lines.push(`# Suggested fix (${diagnosis.suggestedFix.owned}-owned — ${diagnosis.suggestedFix.file}):`);
    for (const descLine of diagnosis.suggestedFix.description.split(/\r?\n/)) {
      lines.push(`# ${descLine}`);
    }
    lines.push('');
  }

  if (diagnosis.reproduction) {
    lines.push('# Reproduce the failure first (optional):');
    lines.push(diagnosis.reproduction);
    lines.push('');
  }

  if (resumeCommand) {
    lines.push('# After applying the fix, resume Convoy from the last clean stage:');
    lines.push(resumeCommand);
  } else {
    lines.push('# (No plan linked to this run — resume manually with `convoy apply <plan-id>`.)');
  }

  return lines.join('\n');
}

function buildHandoffPrompt(
  diagnosis: MedicDiagnosisForFix,
  planPrefix: string | null,
  runId: string,
  toolCalls: ToolCallTrace[],
  repoUrl: string,
): string {
  const locStr = diagnosis.location?.file
    ? `${diagnosis.location.file}${diagnosis.location.line ? `:${diagnosis.location.line}` : ''}`
    : '(no specific location)';

  const trace =
    toolCalls.length > 0
      ? toolCalls.map((t, i) => `${i + 1}. ${t.tool} — ${t.inputSummary}`).join('\n')
      : '(no tool trace recorded)';

  const resume = planPrefix
    ? `npm run convoy -- apply ${planPrefix}`
    : 'npm run convoy -- apply <plan-id>';

  return `Convoy paused a deployment run at this diagnosis. Apply the fix described below using your file-edit tools, then resume the pipeline so Convoy re-enters from the last clean stage. Convoy will NOT modify developer code — that's why it's paused.

## Context

- **Repository:** ${repoUrl}
- **Run id:** ${runId}
- **Plan id:** ${planPrefix ?? '(not linked)'}
- **Classification:** ${diagnosis.classification} (${diagnosis.confidence} confidence, ${diagnosis.source})
- **Location:** ${locStr}

## Root cause

${diagnosis.rootCause}

## The medic's narrative

${diagnosis.narrative}

## Suggested fix (${diagnosis.suggestedFix?.owned ?? 'unspecified'}-owned)

${diagnosis.suggestedFix?.description ?? '(no suggested fix recorded)'}

${diagnosis.suggestedFix?.patch ? `\`\`\`\n${diagnosis.suggestedFix.patch}\n\`\`\`\n` : ''}
## Reproduction

${diagnosis.reproduction ?? '(none)'}

## Investigation trace (${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'})

${trace}

## What I need you to do

1. Read the diagnosis above and confirm you understand the root cause.
2. Apply the suggested fix using your file-edit tools. If the patch is provided verbatim, use it; if the description is abstract, make the minimal edit that matches the medic's intent.
3. Once the fix is in place, run:

\`\`\`
${resume}
\`\`\`

Convoy's orchestrator will re-create a run, re-run scan → pick → author, and drive rehearsal again. If the fix holds the pipeline continues; if it doesn't, the medic will investigate again and you can hand off a fresh prompt.

**Do not** touch Convoy-authored files (Dockerfile is typically developer-authored too; check \`.convoy/manifest.yaml\` for what Convoy owns). Convoy's rule: it ships your code, it does not rewrite your code. Your job is the code fix; Convoy's job is the deploy.`;
}
