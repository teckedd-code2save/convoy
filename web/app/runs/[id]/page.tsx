import { notFound } from 'next/navigation';

import { getRun, listEvents, listApprovals, type EventRow, type ApprovalRow } from '@/lib/runs';

import { AutoRefresher } from './refresher';
import { ApprovalActions } from './approval-form';

export const dynamic = 'force-dynamic';

const STAGE_ORDER = ['scan', 'pick', 'author', 'rehearse', 'canary', 'promote', 'observe'];

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) notFound();

  const events = listEvents(run.id);
  const approvals = listApprovals(run.id);
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const isLive = run.status === 'running' || run.status === 'awaiting_approval';

  return (
    <article className="space-y-10">
      <AutoRefresher enabled={isLive} />

      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <a href="/runs" className="text-sm text-muted hover:text-ink">
            ← Runs
          </a>
          <span className="font-mono text-xs text-muted">{run.id.slice(0, 8)}</span>
          {run.planId ? (
            <a
              href={`/plans/${run.planId}`}
              className="text-xs text-accent hover:underline font-mono"
            >
              plan {run.planId.slice(0, 8)} ↗
            </a>
          ) : null}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-semibold tracking-tight truncate">{run.repoUrl}</h1>
          <StatusBadge status={run.status} live={isLive} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {run.platform ? <Tag>{run.platform}</Tag> : null}
          <span>Started {new Date(run.startedAt).toLocaleString()}</span>
          {run.completedAt ? (
            <>
              <span>·</span>
              <span>{formatDuration(run.completedAt, run.startedAt)}</span>
            </>
          ) : null}
        </div>
        {run.liveUrl ? (
          <a
            href={run.liveUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
          >
            {run.liveUrl} →
          </a>
        ) : null}
      </header>

      {pendingApprovals.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Waiting on you
          </h2>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
              <ApprovalCard key={approval.id} runId={run.id} approval={approval} />
            ))}
          </div>
        </section>
      ) : null}

      <DiagnosisSection events={events} />

      <StagesSection events={events} />

      <TimelineSection events={events} />
    </article>
  );
}

interface MedicDiagnosis {
  rootCause: string;
  classification: 'config' | 'code' | 'infrastructure' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  location?: { file: string; line?: number };
  reproduction?: string;
  suggestedFix?: { file: string; owned: 'convoy' | 'developer'; description: string; patch?: string };
  narrative: string;
  source: 'ai' | 'skipped-no-key' | 'error';
}

function DiagnosisSection({ events }: { events: EventRow[] }) {
  const diagnoses = events.filter((e) => e.kind === 'diagnosis');
  if (diagnoses.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
        Medic&apos;s diagnosis
      </h2>
      <div className="space-y-4">
        {diagnoses.map((e) => (
          <DiagnosisCard key={e.id} diagnosis={e.payload as MedicDiagnosis} createdAt={e.createdAt} />
        ))}
      </div>
    </section>
  );
}

function DiagnosisCard({ diagnosis, createdAt }: { diagnosis: MedicDiagnosis; createdAt: string }) {
  const classColors: Record<string, string> = {
    code: 'border-warn/50 bg-warn/5',
    config: 'border-accent/50 bg-accent/5',
    infrastructure: 'border-accent/50 bg-accent/5',
    unknown: 'border-muted/40 bg-card',
  };
  const classBadge: Record<string, string> = {
    code: 'bg-warn/10 text-warn',
    config: 'bg-accent/10 text-accent',
    infrastructure: 'bg-accent/10 text-accent',
    unknown: 'bg-rule text-muted',
  };
  return (
    <div className={`border rounded-lg p-5 space-y-4 ${classColors[diagnosis.classification] ?? classColors.unknown}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-block w-2 h-2 rounded-full bg-warn animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-warn">Medic</span>
        </div>
        <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${classBadge[diagnosis.classification] ?? classBadge.unknown}`}>
          {diagnosis.classification}
        </span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
          confidence: {diagnosis.confidence}
        </span>
        {diagnosis.source === 'ai' ? (
          <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            opus
          </span>
        ) : null}
        <span className="text-xs text-muted ml-auto">{new Date(createdAt).toLocaleTimeString()}</span>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Root cause</h3>
        <p className="leading-relaxed">{diagnosis.rootCause}</p>
      </div>

      {diagnosis.location ? (
        <div className="font-mono text-sm bg-card border border-rule rounded-md px-3 py-2">
          {diagnosis.location.file}
          {diagnosis.location.line ? `:${diagnosis.location.line}` : ''}
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">What I see</h3>
        <p className="leading-relaxed text-sm">{diagnosis.narrative}</p>
      </div>

      {diagnosis.reproduction ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Reproduction</h3>
          <pre className="text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto">{diagnosis.reproduction}</pre>
        </div>
      ) : null}

      {diagnosis.suggestedFix ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Suggested fix{' '}
            <span className={`ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded ${diagnosis.suggestedFix.owned === 'developer' ? 'bg-warn/10 text-warn' : 'bg-accent/10 text-accent'}`}>
              {diagnosis.suggestedFix.owned}-owned
            </span>
          </h3>
          <p className="leading-relaxed text-sm">{diagnosis.suggestedFix.description}</p>
          <div className="text-xs font-mono text-muted">{diagnosis.suggestedFix.file}</div>
          {diagnosis.suggestedFix.patch ? (
            <pre className="text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto max-h-80">
              {diagnosis.suggestedFix.patch}
            </pre>
          ) : null}
        </div>
      ) : null}

      {diagnosis.classification === 'code' ? (
        <div className="text-xs text-muted bg-rule/50 rounded-md px-3 py-2 leading-relaxed">
          Convoy will not modify your code. Push a fix and the pipeline resumes from the last clean stage.
        </div>
      ) : null}
    </div>
  );
}

function StagesSection({ events }: { events: EventRow[] }) {
  const status = computeStageStatus(events);
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Pipeline</h2>
      <div className="flex flex-wrap gap-2">
        {STAGE_ORDER.map((stage) => {
          const s = status[stage] ?? 'idle';
          const styles: Record<string, string> = {
            idle: 'border-rule text-muted bg-card',
            running: 'border-accent text-accent bg-accent/5 animate-pulse',
            done: 'border-success text-success bg-success/5',
            failed: 'border-danger text-danger bg-danger/5',
          };
          return (
            <div
              key={stage}
              className={`px-3 py-1.5 rounded-md border font-mono text-xs font-medium ${styles[s]}`}
            >
              {stage}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TimelineSection({ events }: { events: EventRow[] }) {
  if (events.length === 0) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Timeline</h2>
        <p className="text-muted text-sm">No events yet.</p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Timeline</h2>
      <ol className="border-l border-rule ml-2 space-y-3">
        {events.map((e) => (
          <li key={e.id} className="pl-5 relative">
            <span
              className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${markerForKind(e.kind)}`}
            />
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono text-xs font-semibold">{e.stage}</span>
              <span className="text-xs text-muted">{e.kind}</span>
              <span className="text-xs text-muted ml-auto">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="text-sm mt-1 font-mono text-muted break-words">
              {renderPayload(e.payload)}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ApprovalCard({ runId, approval }: { runId: string; approval: ApprovalRow }) {
  const summary = approval.summary as Record<string, unknown> | null;
  return (
    <div className="border border-warn/40 bg-warn/5 rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warn">
          <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
          {approval.kind.replace('_', ' ')}
        </span>
        <span className="font-mono text-xs text-muted">{approval.id.slice(0, 8)}</span>
      </div>
      {summary ? (
        <pre className="text-xs font-mono bg-card rounded-md p-3 overflow-auto max-h-60 border border-rule">
          {JSON.stringify(summary, null, 2)}
        </pre>
      ) : null}
      <ApprovalActions runId={runId} approvalId={approval.id} kind={approval.kind} />
    </div>
  );
}

function computeStageStatus(events: EventRow[]): Record<string, 'idle' | 'running' | 'done' | 'failed'> {
  const status: Record<string, 'idle' | 'running' | 'done' | 'failed'> = {};
  for (const e of events) {
    if (e.kind === 'started') status[e.stage] = 'running';
    else if (e.kind === 'finished') status[e.stage] = 'done';
    else if (e.kind === 'failed') status[e.stage] = 'failed';
  }
  return status;
}

function markerForKind(kind: string): string {
  if (kind === 'failed') return 'bg-danger';
  if (kind === 'finished') return 'bg-success';
  if (kind === 'started') return 'bg-accent';
  if (kind === 'decision') return 'bg-accent';
  if (kind === 'diagnosis') return 'bg-warn';
  return 'bg-muted';
}

function renderPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  const entries = Object.entries(payload as Record<string, unknown>);
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(' · ');
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return '{...}';
  return String(v);
}

function formatDuration(endIso: string, startIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function StatusBadge({ status, live }: { status: string; live: boolean }) {
  const config: Record<string, { color: string; label: string }> = {
    pending: { color: 'bg-muted', label: 'pending' },
    running: { color: 'bg-accent animate-pulse', label: 'running' },
    awaiting_approval: { color: 'bg-warn animate-pulse', label: 'awaiting approval' },
    succeeded: { color: 'bg-success', label: 'succeeded' },
    failed: { color: 'bg-danger', label: 'failed' },
    rolled_back: { color: 'bg-danger', label: 'rolled back' },
  };
  const c = config[status] ?? { color: 'bg-muted', label: status };
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded ${live ? 'bg-accent/10' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
      {c.label}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rule text-muted font-medium">
      {children}
    </span>
  );
}
