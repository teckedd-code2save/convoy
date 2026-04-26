export type Platform = 'fly' | 'railway' | 'vercel' | 'cloudrun';

export type StageName =
  | 'scan'
  | 'pick'
  | 'author'
  | 'rehearse'
  | 'canary'
  | 'promote'
  | 'observe';

export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_approval'
  | 'rolled_back';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_fix'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export type EventKind =
  | 'started'
  | 'progress'
  | 'finished'
  | 'failed'
  | 'log'
  | 'diagnosis'
  | 'decision'
  | 'skipped';

export type ApprovalKind =
  | 'open_pr'
  | 'merge_pr'
  | 'promote'
  | 'rollback'
  | 'apply_migration'
  | 'stage_secrets';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type FileProvenanceKind = 'convoy-authored' | 'developer-authored';

export interface Run {
  id: string;
  repoUrl: string;
  platform: Platform | null;
  status: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
  liveUrl: string | null;
  planId: string | null;
  outcomeReason: string | null;
  outcomeRestoredVersion: number | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  stage: StageName;
  kind: EventKind;
  payload: unknown;
  createdAt: Date;
}

export interface Approval {
  id: string;
  runId: string;
  kind: ApprovalKind;
  summary: unknown;
  status: ApprovalStatus;
  decidedAt: Date | null;
}

export interface FileProvenance {
  path: string;
  authoredBy: FileProvenanceKind;
  recordedAt: Date;
}
