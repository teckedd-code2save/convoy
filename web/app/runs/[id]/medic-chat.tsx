'use client';

import { useState, useTransition } from 'react';

import { askMedic } from '@/app/actions';
import type { MedicChatTurn } from '@/lib/medic-chat';

export function MedicChat({
  runId,
  turns,
}: {
  runId: string;
  turns: MedicChatTurn[];
}) {
  const [question, setQuestion] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await askMedic(runId, trimmed);
      if (!result.ok) {
        setError(result.reason ?? 'request failed');
        return;
      }
      setQuestion('');
    });
  };

  return (
    <div className="border-t border-rule pt-4 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
        <span>Ask the medic</span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
          follow-up
        </span>
      </div>

      {turns.length > 0 ? (
        <ol className="space-y-3">
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={
                turn.role === 'user'
                  ? 'border-l-2 border-accent pl-3 py-0.5'
                  : 'border-l-2 border-warn pl-3 py-0.5'
              }
            >
              <div className="text-[10px] uppercase tracking-wider font-medium text-muted mb-1">
                {turn.role === 'user' ? 'you' : 'medic'}{' '}
                <span className="ml-1 font-mono text-muted/70">
                  {new Date(turn.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {turn.content}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted leading-relaxed">
          Ask about the evidence, alternatives the agent didn&apos;t explore, or why
          it ruled something out. The medic answers from the investigation it
          already ran — it doesn&apos;t re-read files in this chat.
        </p>
      )}

      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="e.g. did you consider the queue consumer? what's the evidence for 'every 10th'?"
          disabled={pending}
          className="w-full text-sm font-mono bg-card border border-rule rounded-md px-3 py-2 focus:border-accent focus:outline-none disabled:opacity-50 resize-y"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            {pending ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                medic is thinking…
              </span>
            ) : error ? (
              <span className="text-danger">{error}</span>
            ) : (
              <span className="font-mono text-muted/70">{question.length}/4000</span>
            )}
          </span>
          <button
            type="submit"
            disabled={pending || question.trim().length === 0}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-ink text-paper hover:bg-ink/80 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            ask
          </button>
        </div>
      </form>
    </div>
  );
}
