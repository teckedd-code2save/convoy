import { notFound } from 'next/navigation';

import { listChatTurns, type MedicChatTurn } from '@/lib/medic-chat';
import { getRun, listEvents, listApprovals, type EventRow, type ApprovalRow, type RunRow } from '@/lib/runs';

import { AutoRefresher } from './refresher';
import { ApprovalActions } from './approval-form';
import { FixActions } from './fix-actions';
import { MedicChat } from './medic-chat';

export const dynamic = 'force-dynamic';

const STAGE_ORDER = ['scan', 'pick', 'author', 'rehearse', 'canary', 'promote', 'observe'];

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) notFound();

  const events = listEvents(run.id);
  const approvals = listApprovals(run.id);
  const chatTurns = listChatTurns(run.id);
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

      {run.status === 'rolled_back' ? <RolledBackBanner run={run} /> : null}

      <ProgressBar events={events} startedAt={run.startedAt} completedAt={run.completedAt} />

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

      <DiagnosisSection
        events={events}
        runId={run.id}
        planId={run.planId}
        repoUrl={run.repoUrl}
        chatTurns={chatTurns}
      />

      <MedicInvestigationSection events={events} />

      <StagesSection events={events} />

      <TimelineSection events={events} />
    </article>
  );
}

function RolledBackBanner({ run }: { run: RunRow }) {
  const restored = run.outcomeRestoredVersion;
  return (
    <section className="border border-warn/50 bg-warn/5 rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-warn text-white text-sm font-bold">↺</span>
        <div className="flex-1">
          <h2 className="font-semibold">
            Rolled back{restored !== null ? ` to v${restored}` : ''}
          </h2>
          <p className="text-sm text-muted">
            Convoy caught a breach and restored the previous healthy release.
            {run.liveUrl ? <> Traffic is now served by <a href={run.liveUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline font-mono">{run.liveUrl}</a>.</> : null}
          </p>
        </div>
      </div>
      {run.outcomeReason ? (
        <div className="text-sm bg-card rounded-md p-3 border border-warn/30">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted mr-2">Breach reason</span>
          <span className="font-mono">{run.outcomeReason}</span>
        </div>
      ) : null}
    </section>
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

function DiagnosisSection({
  events,
  runId,
  planId,
  repoUrl,
  chatTurns,
}: {
  events: EventRow[];
  runId: string;
  planId: string | null;
  repoUrl: string;
  chatTurns: MedicChatTurn[];
}) {
  const diagnoses = events.filter((e) => e.kind === 'diagnosis');
  if (diagnoses.length === 0) return null;
  // Only the latest diagnosis hosts the chat — follow-up questions are
  // scoped per-run, so showing chat on every historical diagnosis would
  // duplicate turns.
  const latestId = diagnoses[diagnoses.length - 1]?.id;

  // Extract the medic's tool call trace from progress events so the handoff
  // prompt can tell Claude Code what evidence was gathered. Cheap per render.
  const toolCalls = events
    .filter((e) => {
      if (e.kind !== 'progress') return false;
      const p = e.payload as Record<string, unknown> | null;
      return p !== null && p['phase'] === 'medic.tool_use';
    })
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      const tool = typeof p['tool'] === 'string' ? p['tool'] : 'tool';
      const input = p['input'];
      let inputSummary = '';
      if (input && typeof input === 'object') {
        const io = input as Record<string, unknown>;
        if (typeof io['path'] === 'string') inputSummary = String(io['path']);
        else if (typeof io['pattern'] === 'string') inputSummary = `/${io['pattern']}/`;
        else if (typeof io['n'] === 'number') inputSummary = `n=${io['n']}`;
        else inputSummary = JSON.stringify(input).slice(0, 100);
      }
      return { tool, inputSummary, timestamp: e.createdAt };
    });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
        Medic&apos;s diagnosis
      </h2>
      <div className="space-y-4">
        {diagnoses.map((e) => (
          <DiagnosisCard
            key={e.id}
            diagnosis={e.payload as MedicDiagnosis}
            createdAt={e.createdAt}
            runId={e.id === latestId ? runId : null}
            planId={e.id === latestId ? planId : null}
            repoUrl={repoUrl}
            toolCalls={e.id === latestId ? toolCalls : []}
            chatTurns={e.id === latestId ? chatTurns : []}
          />
        ))}
      </div>
    </section>
  );
}

function DiagnosisCard({
  diagnosis,
  createdAt,
  runId,
  planId,
  repoUrl,
  toolCalls,
  chatTurns,
}: {
  diagnosis: MedicDiagnosis;
  createdAt: string;
  runId: string | null;
  planId: string | null;
  repoUrl: string;
  toolCalls: { tool: string; inputSummary: string; timestamp: string }[];
  chatTurns: MedicChatTurn[];
}) {
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
  const confBadge: Record<string, string> = {
    high: 'bg-success/10 text-success',
    medium: 'bg-rule text-muted',
    low: 'bg-warn/10 text-warn',
  };
  const location = diagnosis.location
    ? `${diagnosis.location.file}${diagnosis.location.line ? `:${diagnosis.location.line}` : ''}`
    : null;

  return (
    <div className={`border rounded-lg ${classColors[diagnosis.classification] ?? classColors.unknown}`}>
      {/* Headline — always open. One-line verdict the operator scans first. */}
      <div className="p-5 space-y-2">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-block w-2 h-2 rounded-full bg-warn" />
            <span className="text-xs font-semibold uppercase tracking-wider text-warn">Medic</span>
          </div>
          <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${classBadge[diagnosis.classification] ?? classBadge.unknown}`}>
            {diagnosis.classification}
          </span>
          <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${confBadge[diagnosis.confidence] ?? confBadge.medium}`}>
            {diagnosis.confidence} confidence
          </span>
          {diagnosis.suggestedFix ? (
            <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${diagnosis.suggestedFix.owned === 'developer' ? 'bg-warn/10 text-warn' : 'bg-accent/10 text-accent'}`}>
              {diagnosis.suggestedFix.owned}-owned
            </span>
          ) : null}
          {diagnosis.source === 'ai' ? (
            <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
              opus
            </span>
          ) : null}
          <span className="text-xs text-muted ml-auto">{new Date(createdAt).toLocaleTimeString()}</span>
        </div>

        <p className="text-base leading-relaxed">{diagnosis.rootCause}</p>

        {location ? (
          <div className="font-mono text-sm inline-block bg-card border border-rule rounded-md px-2.5 py-1">
            {location}
          </div>
        ) : null}

        {runId ? (
          <FixActions
            diagnosis={diagnosis}
            planId={planId}
            runId={runId}
            toolCalls={toolCalls}
            repoUrl={repoUrl}
          />
        ) : null}
      </div>

      {/* Progressive disclosure — each section expands on click. */}
      <div className="border-t border-rule/60 divide-y divide-rule/60">
        <DisclosureSection label="What I see" defaultOpen={false}>
          <p className="leading-relaxed text-sm whitespace-pre-wrap">{diagnosis.narrative}</p>
        </DisclosureSection>

        {diagnosis.suggestedFix ? (
          <DisclosureSection
            label={`Suggested fix — ${diagnosis.suggestedFix.file}`}
            defaultOpen={false}
          >
            <p className="leading-relaxed text-sm whitespace-pre-wrap">
              {diagnosis.suggestedFix.description}
            </p>
            {diagnosis.suggestedFix.patch ? (
              <pre className="mt-3 text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto max-h-80 whitespace-pre-wrap break-words">
                {diagnosis.suggestedFix.patch}
              </pre>
            ) : null}
          </DisclosureSection>
        ) : null}

        {diagnosis.reproduction ? (
          <DisclosureSection label="Reproduction" defaultOpen={false}>
            <pre className="text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto whitespace-pre-wrap break-words">
              {diagnosis.reproduction}
            </pre>
          </DisclosureSection>
        ) : null}

        {diagnosis.classification === 'code' ? (
          <div className="px-5 py-3 text-xs text-muted leading-relaxed bg-rule/30">
            Convoy will not modify your code. Push a fix and the pipeline resumes from the last clean stage.
          </div>
        ) : null}
      </div>

      {runId ? (
        <div className="px-5 pb-5 pt-2">
          <MedicChat runId={runId} turns={chatTurns} />
        </div>
      ) : null}
    </div>
  );
}

function DisclosureSection({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="cursor-pointer select-none list-none px-5 py-3 flex items-center gap-3 hover:bg-rule/30 transition">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted flex-1">
          {label}
        </span>
        <span className="text-xs text-muted/70 group-open:hidden">show ▾</span>
        <span className="text-xs text-muted/70 hidden group-open:inline">hide ▴</span>
      </summary>
      <div className="px-5 pb-4 pt-1">{children}</div>
    </details>
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
              className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${markerForEvent(e)}`}
            />
            <TimelineEvent event={e} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function TimelineEvent({ event }: { event: EventRow }) {
  const hasPayload =
    event.payload !== null && event.payload !== undefined && !(typeof event.payload === 'object' && Object.keys(event.payload as Record<string, unknown>).length === 0);
  const compact = renderPayload(event.payload);
  const full = hasPayload ? JSON.stringify(event.payload, null, 2) : '';
  const isMedic = isMedicToolUse(event);

  return (
    <details className="group">
      <summary className="cursor-pointer select-none list-none">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-xs font-semibold">{event.stage}</span>
          {isMedic ? (
            <span className="text-xs font-semibold text-warn inline-flex items-center gap-1">
              <span>◇</span> medic
            </span>
          ) : (
            <span className="text-xs text-muted">{event.kind}</span>
          )}
          <span className="text-xs text-muted ml-auto">
            {new Date(event.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className="text-sm mt-1 font-mono text-muted break-words flex items-start gap-2">
          <span className="flex-1">
            {isMedic ? renderMedicToolLine(event.payload) : compact || <em className="text-muted/70">(no payload)</em>}
          </span>
          {hasPayload ? (
            <span className="text-xs text-muted/70 shrink-0 group-open:hidden select-none">expand ▾</span>
          ) : null}
          {hasPayload ? (
            <span className="text-xs text-muted/70 shrink-0 hidden group-open:inline select-none">collapse ▴</span>
          ) : null}
        </div>
      </summary>
      {hasPayload ? (
        <pre className="mt-2 p-3 rounded-md bg-ink text-paper text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap break-words">
{full}
        </pre>
      ) : null}
    </details>
  );
}

function isMedicToolUse(event: EventRow): boolean {
  if (event.kind !== 'progress') return false;
  const p = event.payload as Record<string, unknown> | null | undefined;
  return p !== null && p !== undefined && p['phase'] === 'medic.tool_use';
}

function renderMedicToolLine(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const tool = typeof p['tool'] === 'string' ? p['tool'] : 'tool';
  const input = p['input'];
  if (input && typeof input === 'object') {
    const io = input as Record<string, unknown>;
    if (typeof io['path'] === 'string') {
      const line =
        typeof io['start_line'] === 'number'
          ? `:${io['start_line']}${typeof io['end_line'] === 'number' ? `-${io['end_line']}` : ''}`
          : '';
      return `${tool} ${io['path']}${line}`;
    }
    if (typeof io['pattern'] === 'string') {
      const scope = typeof io['path'] === 'string' ? ` in ${io['path']}` : '';
      return `${tool} /${io['pattern']}/${scope}`;
    }
    if (typeof io['n'] === 'number') return `${tool} n=${io['n']}`;
  }
  return tool;
}

function ProgressBar({
  events,
  startedAt,
  completedAt,
}: {
  events: EventRow[];
  startedAt: string;
  completedAt: string | null;
}) {
  const status = computeStageStatus(events);
  const done = STAGE_ORDER.filter((s) => status[s] === 'done').length;
  const running = STAGE_ORDER.find((s) => status[s] === 'running');
  const pct = Math.min(100, Math.round((done / STAGE_ORDER.length) * 100));
  const elapsedMs =
    (completedAt ? new Date(completedAt).getTime() : Date.now()) - new Date(startedAt).getTime();

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">
            {done} <span className="text-muted font-normal">/</span> {STAGE_ORDER.length}
          </span>
          <span className="text-sm text-muted">stages</span>
          {running ? (
            <span className="text-sm text-accent">
              · <span className="font-mono">{running}</span> running
            </span>
          ) : null}
        </div>
        <div className="text-xs font-mono text-muted">
          {formatElapsed(elapsedMs)}
          {completedAt ? null : <span className="ml-1 text-accent animate-pulse">●</span>}
        </div>
      </div>
      <div className="h-1.5 bg-rule rounded-full overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function MedicInvestigationSection({ events }: { events: EventRow[] }) {
  const toolCalls = events.filter(isMedicToolUse);
  if (toolCalls.length === 0) return null;

  const seenFinalize = toolCalls.some((e) => {
    const p = e.payload as Record<string, unknown> | null;
    const tool = p?.['tool'];
    return tool === 'finalize_diagnosis';
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Medic investigation
        </h2>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-warn/10 text-warn">
          Claude agent · {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
        </span>
        {!seenFinalize ? (
          <span className="text-xs text-accent inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            investigating
          </span>
        ) : null}
      </div>
      <ol className="border border-rule rounded-lg p-3 space-y-1.5 bg-card">
        {toolCalls.map((e, idx) => (
          <li
            key={e.id}
            className="font-mono text-xs text-muted flex items-baseline gap-2 flex-wrap"
          >
            <span className="text-warn shrink-0">◇</span>
            <span className="text-muted/70 tabular-nums shrink-0 w-4 text-right">
              {idx + 1}
            </span>
            <span className="text-ink font-semibold">
              {(e.payload as Record<string, unknown>)['tool'] as string}
            </span>
            <span className="text-muted break-all">{renderMedicToolLine(e.payload).replace(/^\S+\s*/, '')}</span>
            <span className="text-muted/60 ml-auto shrink-0">
              {new Date(e.createdAt).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted leading-relaxed">
        Each line is a tool call the medic agent made against this run. The agent picks
        which tools to call and when to stop — path-traversal is refused at the tool boundary,
        so the agent can only read files under the repo root.
      </p>
    </section>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

interface AuthoredFileSummary {
  path: string;
  lines: number;
  summary: string;
  contentPreview: string;
}

function ApprovalCard({ runId, approval }: { runId: string; approval: ApprovalRow }) {
  const summary = (approval.summary ?? null) as Record<string, unknown> | null;

  if (approval.kind === 'merge_pr' && summary) {
    return <MergePrApprovalCard runId={runId} approval={approval} summary={summary} />;
  }

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

function MergePrApprovalCard({
  runId,
  approval,
  summary,
}: {
  runId: string;
  approval: ApprovalRow;
  summary: Record<string, unknown>;
}) {
  const mode = (summary['mode'] as string | undefined) ?? 'real';
  const prUrl = typeof summary['pr_url'] === 'string' ? summary['pr_url'] : null;
  const prNumber = typeof summary['pr_number'] === 'number' ? summary['pr_number'] : null;
  const branch = typeof summary['branch'] === 'string' ? summary['branch'] : null;
  const note = typeof summary['note'] === 'string' ? summary['note'] : null;

  // New shape: files is an array of {path, lines, summary, contentPreview}.
  // Older shape (pre-rewrite): files is a string[] of paths only.
  const rawFiles = summary['files'];
  const files: AuthoredFileSummary[] = Array.isArray(rawFiles)
    ? rawFiles.map((f) => {
        if (typeof f === 'string') {
          return { path: f, lines: 0, summary: '', contentPreview: '' };
        }
        if (f && typeof f === 'object') {
          const obj = f as Record<string, unknown>;
          return {
            path: typeof obj['path'] === 'string' ? obj['path'] : '(unknown)',
            lines: typeof obj['lines'] === 'number' ? obj['lines'] : 0,
            summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
            contentPreview:
              typeof obj['contentPreview'] === 'string' ? obj['contentPreview'] : '',
          };
        }
        return { path: '(unknown)', lines: 0, summary: '', contentPreview: '' };
      })
    : [];

  return (
    <div className="border border-warn/40 bg-warn/5 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warn">
          <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
          approve merge
        </span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
          {mode === 'scripted' ? 'scripted preview' : 'real PR'}
        </span>
        <span className="font-mono text-xs text-muted ml-auto">{approval.id.slice(0, 8)}</span>
      </div>

      {prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-sm text-accent hover:underline font-mono break-all"
        >
          {prUrl.replace(/^https?:\/\//, '')}
          {prNumber ? <span className="text-muted">#{prNumber}</span> : null}
          <span aria-hidden>↗</span>
        </a>
      ) : null}

      {branch ? (
        <div className="text-xs font-mono text-muted">
          branch: <span className="text-ink">{branch}</span>
        </div>
      ) : null}

      {note ? (
        <p className="text-sm text-muted leading-relaxed">{note}</p>
      ) : null}

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">
          {files.length} file{files.length === 1 ? '' : 's'} Convoy authored
        </div>
        <div className="space-y-1.5">
          {files.map((f) => (
            <AuthoredFileRow key={f.path} file={f} />
          ))}
        </div>
      </div>

      <ApprovalActions runId={runId} approvalId={approval.id} kind={approval.kind} />
    </div>
  );
}

function AuthoredFileRow({ file }: { file: AuthoredFileSummary }) {
  const hasPreview = file.contentPreview.length > 0;
  return (
    <details className="group border border-rule rounded-md bg-card">
      <summary
        className={`cursor-pointer select-none list-none px-3 py-2 flex items-baseline gap-3 flex-wrap ${hasPreview ? 'hover:bg-rule/30' : ''}`}
      >
        <span className="font-mono text-sm text-ink">{file.path}</span>
        {file.lines > 0 ? (
          <span className="text-xs text-muted tabular-nums">
            {file.lines} line{file.lines === 1 ? '' : 's'}
          </span>
        ) : null}
        {file.summary ? (
          <span className="text-xs text-muted flex-1 truncate">{file.summary}</span>
        ) : null}
        {hasPreview ? (
          <>
            <span className="text-xs text-muted/70 shrink-0 group-open:hidden select-none">
              show ▾
            </span>
            <span className="text-xs text-muted/70 shrink-0 hidden group-open:inline select-none">
              hide ▴
            </span>
          </>
        ) : null}
      </summary>
      {hasPreview ? (
        <pre className="text-xs font-mono bg-ink text-paper p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words rounded-b-md border-t border-rule">
          {file.contentPreview}
        </pre>
      ) : null}
    </details>
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

function markerForEvent(event: EventRow): string {
  if (isMedicToolUse(event)) return 'bg-warn';
  const kind = event.kind;
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
    awaiting_fix: { color: 'bg-warn animate-pulse', label: 'awaiting fix' },
    succeeded: { color: 'bg-success', label: 'succeeded' },
    failed: { color: 'bg-danger', label: 'failed' },
    rolled_back: { color: 'bg-warn', label: 'rolled back' },
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
