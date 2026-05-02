'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { applyPlan } from '../../actions';

/**
 * "Apply plan →" button. Replaces the disabled stub that used to point
 * the operator at the CLI. The actual heavy lifting still runs in a
 * detached `convoy apply` spawn — this component just kicks it off and
 * redirects to the run timeline once the orchestrator has materialized
 * the run row.
 *
 * Disabled paths:
 *   - hardBlockerCount > 0 → "resolve blockers first" (the server action
 *     would refuse anyway, but disabling the button here saves the round
 *     trip and gives the operator a tooltip explaining why).
 *   - runInFlight === true → "apply already running" (likewise — the
 *     server action enforces the one-at-a-time rule).
 *   - cliHint always shown alongside as a power-user fallback.
 */
export function ApplyButton({
  planId,
  planIdShort,
  hardBlockerCount,
  runInFlight,
}: {
  planId: string;
  planIdShort: string;
  hardBlockerCount: number;
  runInFlight: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const blockedReason = hardBlockerCount > 0
    ? `Resolve ${hardBlockerCount} blocker${hardBlockerCount === 1 ? '' : 's'} above (or acknowledge them) and re-run preflight.`
    : runInFlight
      ? 'A run for this plan is already in flight — wait for it to finish or roll back.'
      : null;
  const disabled = blockedReason !== null || pending;

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await applyPlan(planId);
      if (result.ok && result.runId) {
        router.push(`/runs/${result.runId}`);
        return;
      }
      // If the action returned a runId despite ok=false, that's the
      // "in flight" case — let the operator jump to the existing run.
      if (result.runId) {
        router.push(`/runs/${result.runId}`);
        return;
      }
      setError(result.reason ?? 'apply failed for an unknown reason');
    });
  };

  return (
    <div className="space-y-2 pt-6 border-t border-rule">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          title={blockedReason ?? 'Spawn `convoy apply` and watch live in the run timeline'}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            disabled
              ? 'bg-ink text-white opacity-50 cursor-not-allowed'
              : 'bg-ink text-white hover:bg-accent'
          }`}
        >
          {pending ? 'Starting…' : 'Apply plan →'}
        </button>
        <code className="text-xs text-muted">
          npm run convoy -- apply {planIdShort}
        </code>
      </div>
      {blockedReason ? (
        <div className="text-xs text-muted">{blockedReason}</div>
      ) : null}
      {error ? (
        <div className="text-xs text-red-600">{error}</div>
      ) : null}
    </div>
  );
}
