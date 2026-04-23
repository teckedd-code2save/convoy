'use server';

import { revalidatePath } from 'next/cache';

import { decideApproval as decide } from '@/lib/runs';

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
