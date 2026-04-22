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
  const updated = decide(approvalId, decision);
  if (!updated) {
    return { ok: false, reason: 'approval already decided or not found' };
  }
  revalidatePath(`/runs/${runId}`);
  return { ok: true };
}
