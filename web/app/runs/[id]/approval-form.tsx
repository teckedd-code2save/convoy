'use client';

import { useState, useTransition } from 'react';

import { decideApproval } from '@/app/actions';

export function ApprovalActions({
  runId,
  approvalId,
  kind,
}: {
  runId: string;
  approvalId: string;
  kind: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handle(decision: 'approved' | 'rejected') {
    setError(null);
    startTransition(async () => {
      const result = await decideApproval(runId, approvalId, decision);
      if (!result.ok) setError(result.reason ?? 'decision failed');
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => handle('approved')}
        className="px-4 py-2 rounded-md bg-success text-white text-sm font-medium hover:bg-success/90 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pending ? 'Deciding...' : `Approve ${kind.replace('_', ' ')}`}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => handle('rejected')}
        className="px-4 py-2 rounded-md border border-rule text-sm font-medium hover:bg-rule/40 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        Reject
      </button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
