'use client';

import { useState, useTransition } from 'react';

import type { BlockerRow } from '@/lib/runs';

import { acknowledgeBlocker, rerunPreflight } from '../../actions';

/**
 * Top-of-page card for the operator: every preflight blocker that's open
 * for this plan. Each blocker exposes its ordered fixes inline — copy-able
 * commands first, opt-out flags last — so "what do I do about this?" is
 * one click away from the answer.
 *
 * Acknowledging a blocker only suppresses it visually until preflight runs
 * again. Preflight itself is the source of truth for whether the blocker
 * is gone — the rerun button shells out to `convoy preflight <id>`.
 */
export function BlockersSection({
  planId,
  blockers,
}: {
  planId: string;
  blockers: BlockerRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const hard = blockers.filter((b) => b.payload.severity === 'hard');
  const soft = blockers.filter((b) => b.payload.severity !== 'hard');

  const onRerun = () => {
    setError(null);
    startTransition(async () => {
      const result = await rerunPreflight(planId);
      if (!result.ok) setError(result.reason ?? 'rerun failed');
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          {hard.length > 0
            ? `${hard.length} blocker${hard.length === 1 ? '' : 's'} — apply paused`
            : `${soft.length} warning${soft.length === 1 ? '' : 's'}`}
        </h2>
        <button
          type="button"
          onClick={onRerun}
          disabled={pending}
          className="text-xs px-3 py-1 rounded border border-rule hover:bg-rule/40 transition-colors disabled:opacity-50"
        >
          {pending ? 'Re-running…' : 'Re-run preflight'}
        </button>
      </div>
      {error ? (
        <div className="text-xs text-red-600">{error}</div>
      ) : null}
      <ul className="space-y-3">
        {[...hard, ...soft].map((blocker) => (
          <BlockerCard key={blocker.id} planId={planId} blocker={blocker} />
        ))}
      </ul>
    </section>
  );
}

function BlockerCard({ planId, blocker }: { planId: string; blocker: BlockerRow }) {
  const [pending, startTransition] = useTransition();
  const isHard = blocker.payload.severity === 'hard';
  const onAcknowledge = () => {
    startTransition(async () => {
      await acknowledgeBlocker(planId, blocker.id);
    });
  };

  return (
    <li
      className={`border rounded-lg p-4 space-y-3 ${
        isHard
          ? 'border-red-500/40 bg-red-500/5'
          : 'border-yellow-500/40 bg-yellow-500/5'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                isHard ? 'bg-red-500/20 text-red-700' : 'bg-yellow-500/20 text-yellow-700'
              }`}
            >
              {isHard ? 'Hard' : 'Warning'}
            </span>
            <span className="font-mono text-[10px] text-muted">{blocker.payload.id}</span>
          </div>
          <h3 className="font-medium">{blocker.payload.title}</h3>
          <p className="text-sm text-muted">{blocker.payload.detail}</p>
        </div>
        <button
          type="button"
          onClick={onAcknowledge}
          disabled={pending}
          title="Suppress until next preflight runs"
          className="text-xs px-2 py-1 rounded border border-rule hover:bg-rule/40 transition-colors disabled:opacity-50 shrink-0"
        >
          {pending ? '…' : 'Acknowledge'}
        </button>
      </div>
      {blocker.payload.fixes.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">Fixes</div>
          <ul className="space-y-1.5">
            {blocker.payload.fixes.map((fix, idx) => (
              <FixRow key={idx} fix={fix} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function FixRow({
  fix,
}: {
  fix: BlockerRow['payload']['fixes'][number];
}) {
  const [copied, setCopied] = useState(false);
  const target = fix.command ?? fix.flag ?? '';
  const onCopy = async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — older browsers / restricted contexts
    }
  };

  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1 text-muted">•</span>
      <div className="flex-1 min-w-0 space-y-1">
        <div>{fix.label}</div>
        {target ? (
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs bg-card border border-rule rounded px-2 py-0.5 truncate">
              {target}
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="text-[10px] uppercase tracking-wider text-muted hover:text-ink"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
