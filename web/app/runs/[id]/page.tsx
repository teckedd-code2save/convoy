import { notFound } from 'next/navigation';

import { listChatTurns, type MedicChatTurn } from '@/lib/medic-chat';
import { getRun, listEvents, listApprovals, type EventRow, type ApprovalRow, type RunRow } from '@/lib/runs';

import { AutoRefresher } from './refresher';
import { ApprovalActions } from './approval-form';
import { FixActions } from './fix-actions';
import { MedicChat } from './medic-chat';
import { ScrollIntoFailure } from './scroll-into-failure';
import { SecretStagingForm } from './secret-staging-form';

export const dynamic = 'force-dynamic';

const STAGE_ORDER = ['scan', 'pick', 'rehearse', 'author', 'canary', 'promote', 'observe'];
type Stage = typeof STAGE_ORDER[number];

/**
 * Pick the stage that should be selected when the operator lands on the
 * page without an explicit `?stage=` choice. Priority: actively-running >
 * most-recently-failed > most-recently-finished > first idle. Matches
 * "what does the operator most likely want to look at right now."
 */
function defaultActiveStage(events: EventRow[]): Stage {
  const lastTerminalByStage = new Map<Stage, 'finished' | 'failed' | 'started' | 'skipped'>();
  for (const event of events) {
    if (
      event.kind === 'started' ||
      event.kind === 'finished' ||
      event.kind === 'failed' ||
      event.kind === 'skipped'
    ) {
      lastTerminalByStage.set(event.stage as Stage, event.kind);
    }
  }
  // Running: started but no terminal yet.
  for (const stage of STAGE_ORDER) {
    if (lastTerminalByStage.get(stage) === 'started') return stage;
  }
  // Failed: walk in reverse pipeline order so a downstream failure wins
  // over an upstream skipped retry.
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    const stage = STAGE_ORDER[i]!;
    if (lastTerminalByStage.get(stage) === 'failed') return stage;
  }
  // Most-recently-finished/skipped: walk reverse, pick last completed.
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    const stage = STAGE_ORDER[i]!;
    const state = lastTerminalByStage.get(stage);
    if (state === 'finished' || state === 'skipped') return stage;
  }
  return STAGE_ORDER[0]!;
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stage?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const run = getRun(id);
  if (!run) notFound();

  const events = listEvents(run.id);
  const approvals = listApprovals(run.id);
  const chatTurns = listChatTurns(run.id);
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const isLive = run.status === 'running' || run.status === 'awaiting_approval';

  const requestedStage = sp.stage && STAGE_ORDER.includes(sp.stage) ? (sp.stage as Stage) : null;
  const activeStage: Stage = requestedStage ?? defaultActiveStage(events);

  return (
    <article className="space-y-8">
      <AutoRefresher enabled={isLive} />

      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <a href="/runs" className="text-sm text-muted hover:text-ink transition-colors">
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
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight truncate">{run.repoUrl}</h1>
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

      <MedicSpotlight events={events} runStatus={run.status} />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 lg:gap-8 items-start">
        <StageNav
          events={events}
          activeStage={activeStage}
          runId={run.id}
          pendingApprovals={pendingApprovals}
        />
        <StageDetail
          run={run}
          events={events}
          approvals={approvals}
          pendingApprovals={pendingApprovals}
          activeStage={activeStage}
          chatTurns={chatTurns}
        />
      </div>
    </article>
  );
}

/**
 * Sticky vertical sidebar listing the seven stages with state, duration,
 * event count, and active highlight. Each row is a server-side link to
 * `?stage=<name>` so navigation is free (no client JS, no hydration cost).
 *
 * Active state: 2px left border accent + soft glow halo. Hover state on
 * inactive rows lifts subtly via translateY(-1px) and bumps the border
 * weight. Approval pings show as a small ⏸ badge inline; pending approvals
 * across the run get a sticky footer block below the stages.
 */
function StageNav({
  events,
  activeStage,
  runId,
  pendingApprovals,
}: {
  events: EventRow[];
  activeStage: Stage;
  runId: string;
  pendingApprovals: ApprovalRow[];
}) {
  const stageStatus = computeStageStatus(events);
  const stageStartByStage = new Map<Stage, Date>();
  const stageEndByStage = new Map<Stage, Date>();
  const eventCountByStage = new Map<Stage, number>();
  for (const event of events) {
    const ts = new Date(event.createdAt);
    if (event.kind === 'started') stageStartByStage.set(event.stage as Stage, ts);
    else if (event.kind === 'finished' || event.kind === 'failed') stageEndByStage.set(event.stage as Stage, ts);
    eventCountByStage.set(event.stage as Stage, (eventCountByStage.get(event.stage as Stage) ?? 0) + 1);
  }
  // Pending approvals scoped to a specific stage so the row gets its own
  // ⏸ pulse, not just the footer block.
  const pendingApprovalByStage = new Map<Stage, ApprovalRow>();
  for (const approval of pendingApprovals) {
    const stage = approvalToStage(approval.kind);
    if (stage) pendingApprovalByStage.set(stage, approval);
  }

  return (
    <nav className="lg:sticky lg:top-20 self-start space-y-1.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted px-1 mb-3">Pipeline</h2>
      {STAGE_ORDER.map((stage) => {
        const state = stageStatus[stage] ?? 'idle';
        const start = stageStartByStage.get(stage);
        const end = stageEndByStage.get(stage);
        const duration = start && end ? formatDuration(end.toISOString(), start.toISOString()) : null;
        const eventCount = eventCountByStage.get(stage) ?? 0;
        const isActive = activeStage === stage;
        const pendingApproval = pendingApprovalByStage.get(stage);
        // computeStageStatus uses 'done' for the finished state — match it.
        const icon = state === 'done' ? '●' : state === 'failed' ? '✗' : state === 'skipped' ? '⤳' : state === 'running' ? '◐' : '○';
        const iconColor =
          state === 'done' ? 'text-success' :
          state === 'failed' ? 'text-danger' :
          state === 'skipped' ? 'text-muted' :
          state === 'running' ? 'text-accent' :
          'text-muted/50';

        // Severity halos: failed stages glow red so a glance at the nav
        // surfaces the breach; pending approvals glow warn so the gate
        // is unmissable. Active state still wins on color (accent), but
        // the halos compose — a stage that's both active AND failed
        // shows the active border + the danger glow.
        const severityHalo =
          state === 'failed'
            ? 'shadow-[0_0_20px_color-mix(in_srgb,var(--color-danger)_40%,transparent)]'
            : pendingApproval
              ? 'shadow-[0_0_20px_color-mix(in_srgb,var(--color-warn)_30%,transparent)]'
              : '';
        const severityBorder =
          state === 'failed'
            ? 'border-danger/50'
            : pendingApproval
              ? 'border-warn/40'
              : '';
        const baseBorder = isActive
          ? 'border-accent/60 bg-accent/5 shadow-[0_0_24px_var(--color-accent-glow)]'
          : severityBorder
            ? `${severityBorder} bg-card/60 hover:-translate-y-px`
            : 'border-rule/40 hover:border-rule hover:bg-card/60 hover:-translate-y-px';

        return (
          <a
            key={stage}
            href={`/runs/${runId}?stage=${stage}`}
            className={`group relative block rounded-lg border px-3 py-2.5 transition-all ${baseBorder} ${!isActive ? severityHalo : ''}`}
          >
            {isActive ? (
              <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 bg-accent rounded-r" />
            ) : state === 'failed' ? (
              <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 bg-danger rounded-r" />
            ) : pendingApproval ? (
              <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 bg-warn rounded-r animate-pulse" />
            ) : null}
            <div className="flex items-center gap-2.5">
              <span className={`text-base leading-none ${iconColor} ${state === 'running' || state === 'failed' ? 'animate-pulse' : ''}`}>
                {icon}
              </span>
              <span className={`font-mono text-sm font-medium flex-1 ${isActive ? 'text-ink' : state === 'idle' ? 'text-muted' : 'text-ink/90'}`}>
                {stage}
              </span>
              {pendingApproval ? (
                <span aria-hidden className="text-warn text-xs animate-pulse" title={`awaiting ${pendingApproval.kind}`}>⏸</span>
              ) : null}
              {duration ? (
                <span className="text-[11px] text-muted/80 tabular-nums">{duration}</span>
              ) : null}
            </div>
            {(eventCount > 0 || state === 'running' || pendingApproval) && (
              <div className="mt-1 ml-7 flex items-center gap-2 text-[11px] text-muted">
                {eventCount > 0 ? (
                  <span>{eventCount} event{eventCount === 1 ? '' : 's'}</span>
                ) : null}
                {state === 'running' ? (
                  <span className="text-accent inline-flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />live
                  </span>
                ) : null}
                {pendingApproval ? (
                  <span className="text-warn font-mono">awaiting {pendingApproval.kind}</span>
                ) : null}
              </div>
            )}
          </a>
        );
      })}

      {pendingApprovals.length > 0 ? (
        <div className="mt-5 pt-5 border-t border-rule/40">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-warn px-1 mb-2">
            ⏸ Awaiting you
          </h2>
          <div className="space-y-1.5 px-1">
            {pendingApprovals.map((approval) => (
              <div
                key={approval.id}
                className="text-xs text-muted flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                <span className="font-mono">{approval.kind}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/**
 * Right-side detail panel. Sticky header with stage name, big status badge,
 * duration, and a `live` indicator if the stage is in flight. Body is the
 * filtered event timeline for this stage, plus a stage-specific artifact
 * card (see StageArtifactCard) inserted right below the header. Empty
 * states for stages that haven't run yet.
 */
function StageDetail({
  run,
  events,
  approvals,
  pendingApprovals,
  activeStage,
  chatTurns,
}: {
  run: RunRow;
  events: EventRow[];
  approvals: ApprovalRow[];
  pendingApprovals: ApprovalRow[];
  activeStage: Stage;
  chatTurns: MedicChatTurn[];
}) {
  const stageEvents = events.filter((e) => e.stage === activeStage);
  const status = computeStageStatus(events);
  const state = status[activeStage] ?? 'idle';
  const stageStart = stageEvents.find((e) => e.kind === 'started');
  const stageEnd = stageEvents.find((e) => e.kind === 'finished' || e.kind === 'failed');
  const duration = stageStart && stageEnd
    ? formatDuration(stageEnd.createdAt, stageStart.createdAt)
    : null;
  const statePillColor: Record<string, string> = {
    done: 'border-success/50 bg-success/10 text-success',
    failed: 'border-danger/60 bg-danger/10 text-danger',
    skipped: 'border-muted/40 bg-card/60 text-muted',
    running: 'border-accent/60 bg-accent/10 text-accent',
    idle: 'border-rule/40 bg-card text-muted',
  };
  const stagePendingApproval = pendingApprovals.find((a) => approvalToStage(a.kind) === activeStage);

  return (
    <section className="min-w-0 space-y-6">
      <header className="flex items-center gap-3 flex-wrap">
        <h2 className="text-2xl font-semibold tracking-tight font-mono">{activeStage}</h2>
        <span className={`inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full border ${statePillColor[state] ?? statePillColor['idle']}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${state === 'running' ? 'animate-pulse' : ''} ${
            state === 'done' ? 'bg-success' :
            state === 'failed' ? 'bg-danger' :
            state === 'skipped' ? 'bg-muted' :
            state === 'running' ? 'bg-accent' :
            'bg-muted/50'
          }`} />
          {state === 'idle' ? 'not run' : state === 'skipped' ? 'replayed' : state === 'done' ? 'finished' : state}
        </span>
        {duration ? (
          <span className="text-sm text-muted tabular-nums font-mono">{duration}</span>
        ) : null}
      </header>

      {/* Failure spotlight pinned at the top so the operator sees what broke
          AND the next action without scrolling through the events list. */}
      {state === 'failed' ? (
        <FailureSpotlight
          run={run}
          events={events}
          stageEvents={stageEvents}
        />
      ) : null}

      {/* Stage-specific artifact card */}
      <StageArtifactCard
        run={run}
        stage={activeStage}
        events={events}
        stageEvents={stageEvents}
        chatTurns={chatTurns}
      />

      {/* Pending approval scoped to this stage gets surfaced here. */}
      {stagePendingApproval ? (
        <ApprovalCard runId={run.id} approval={stagePendingApproval} />
      ) : null}

      {/* Filtered timeline */}
      {stageEvents.length === 0 ? (
        <div className="rounded-lg border border-rule/40 bg-card/40 p-6 text-center">
          <span className="text-2xl text-muted/50 block mb-2">○</span>
          <p className="text-sm text-muted">
            <span className="font-mono">{activeStage}</span> hasn&apos;t run yet.
          </p>
        </div>
      ) : (
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted mb-3">
            Events
          </h3>
          <ol className="border-l border-rule/40 ml-2 space-y-3">
            {stageEvents.map((e) => (
              <li key={e.id} className="pl-5 relative">
                <span
                  className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${markerForEvent(e)}`}
                />
                <TimelineEvent event={e} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/**
 * Pending approvals are tied to a stage by their `kind`. This map mirrors
 * the orchestrator's awaitApproval() call sites in src/core/stages.ts.
 */
function approvalToStage(kind: string): Stage | null {
  if (kind === 'open_pr' || kind === 'merge_pr') return 'author';
  if (kind === 'promote' || kind === 'stage_secrets') return 'canary';
  if (kind === 'rollback') return 'observe';
  if (kind === 'apply_migration') return 'rehearse';
  return null;
}

/**
 * Per-stage detail card. Each stage gets a tailored summary derived from
 * its key events: scan signals, pick decision, rehearse metrics + medic
 * link, author PR + carry list, canary/promote traffic split, observe
 * SLO + bake. Falls back to a minimal "stage info" block when the stage
 * is idle or has no recognizable artifacts yet.
 */
function StageArtifactCard({
  run,
  stage,
  events,
  stageEvents,
  chatTurns,
}: {
  run: RunRow;
  stage: Stage;
  events: EventRow[];
  stageEvents: EventRow[];
  chatTurns: MedicChatTurn[];
}) {
  const finished = stageEvents.find((e) => e.kind === 'finished');
  const failed = stageEvents.find((e) => e.kind === 'failed');
  const skipped = stageEvents.find((e) => e.kind === 'skipped');

  if (skipped) {
    const skippedPayload = skipped.payload as Record<string, unknown> | null;
    const replayedPayload = skippedPayload?.['replayed_payload'] as Record<string, unknown> | null;
    return (
      <div className="rounded-xl border border-muted/30 bg-card/40 p-5">
        <div className="flex items-center gap-2.5 text-sm">
          <span className="text-muted text-lg">⤳</span>
          <span className="text-muted">
            Skipped — already finished in a prior attempt. Convoy replayed the prior payload into the run context.
          </span>
        </div>
        {replayedPayload ? (
          <div className="mt-4 text-xs font-mono text-muted/80 break-all">
            {Object.entries(replayedPayload).slice(0, 5).map(([k, v]) => (
              <div key={k} className="py-0.5">
                <span className="text-muted/60">{k}=</span>
                <span className="text-ink/80">{renderValue(v)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // Diagnosis + medic spotlight live with rehearse since that's where breach + diagnose happens.
  if (stage === 'rehearse') {
    return (
      <RehearseArtifactCard run={run} events={events} stageEvents={stageEvents} chatTurns={chatTurns} finished={finished} failed={failed} />
    );
  }
  if (stage === 'author') {
    return <AuthorArtifactCard finished={finished} failed={failed} stageEvents={stageEvents} />;
  }
  if (stage === 'scan') {
    return <ScanArtifactCard finished={finished} />;
  }
  if (stage === 'pick') {
    return <PickArtifactCard finished={finished} stageEvents={stageEvents} />;
  }
  if (stage === 'canary' || stage === 'promote') {
    return <DeployArtifactCard stage={stage} finished={finished} failed={failed} stageEvents={stageEvents} />;
  }
  if (stage === 'observe') {
    return <ObserveArtifactCard run={run} finished={finished} failed={failed} />;
  }
  return null;
}

function ScanArtifactCard({ finished }: { finished?: EventRow }) {
  if (!finished) return null;
  const p = finished.payload as Record<string, unknown> | null;
  const signals = (p?.['signals'] ?? p) as Record<string, unknown> | undefined;
  if (!signals) return null;
  const interesting = ['ecosystem', 'framework', 'topology', 'packageManager', 'startCommand', 'healthPath', 'port', 'isMonorepo', 'dataLayer'];
  return (
    <div className="rounded-xl border border-rule/40 bg-card/60 p-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted mb-3">Repo signals</h3>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {interesting.map((key) => {
          const value = signals[key];
          if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return null;
          return (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-muted">{key}</dt>
              <dd className="font-mono text-ink/90 truncate">{renderValue(value)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function PickArtifactCard({ finished, stageEvents }: { finished?: EventRow; stageEvents: EventRow[] }) {
  const decision = stageEvents.find((e) => e.kind === 'decision');
  const payload = (decision?.payload ?? finished?.payload) as Record<string, unknown> | undefined;
  if (!payload) return null;
  return (
    <div className="rounded-xl border border-rule/40 bg-card/60 p-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted mb-3">Platform decision</h3>
      <div className="space-y-2 text-sm">
        {payload['chosen'] ? (
          <div className="flex items-baseline gap-3">
            <span className="text-muted">chose</span>
            <span className="font-mono font-semibold text-accent text-base">{String(payload['chosen'])}</span>
            {payload['source'] ? <span className="text-xs text-muted/70">via {String(payload['source'])}</span> : null}
          </div>
        ) : null}
        {payload['reason'] ? (
          <p className="text-ink/90">{String(payload['reason'])}</p>
        ) : null}
        {Array.isArray(payload['candidates']) && (payload['candidates'] as unknown[]).length > 0 ? (
          <div className="text-xs text-muted">scored against {(payload['candidates'] as unknown[]).length} platform{(payload['candidates'] as unknown[]).length === 1 ? '' : 's'}</div>
        ) : null}
      </div>
    </div>
  );
}

function RehearseArtifactCard({ run, events, stageEvents, chatTurns, finished, failed }: {
  run: RunRow;
  events: EventRow[];
  stageEvents: EventRow[];
  chatTurns: MedicChatTurn[];
  finished?: EventRow;
  failed?: EventRow;
}) {
  const finishedPayload = finished?.payload as Record<string, unknown> | undefined;
  const failedPayload = failed?.payload as Record<string, unknown> | undefined;
  const breach = stageEvents.find((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return e.kind === 'progress' && (typeof p?.['phase'] === 'string') && (p['phase'] as string).includes('breach');
  });
  const breachPayload = breach?.payload as Record<string, unknown> | undefined;
  const stats = finishedPayload ?? breachPayload;

  return (
    <div className="space-y-4">
      {stats ? (
        <div className="rounded-xl border border-rule/40 bg-card/60 p-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted mb-3">Rehearsal evidence</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            {typeof stats['p99_ms'] === 'number' ? (
              <Metric label="p99" value={`${stats['p99_ms']}ms`} status={Number(stats['p99_ms']) > 500 ? 'warn' : 'ok'} />
            ) : null}
            {typeof stats['error_rate_pct'] === 'number' ? (
              <Metric label="error rate" value={`${stats['error_rate_pct']}%`} status={Number(stats['error_rate_pct']) > 1 ? 'fail' : 'ok'} />
            ) : null}
            {typeof stats['smoke_tests_passed'] === 'number' ? (
              <Metric label="smoke tests" value={`${stats['smoke_tests_passed']}/${stats['smoke_tests_passed']}`} status="ok" />
            ) : null}
            {typeof stats['healthy'] === 'boolean' ? (
              <Metric label="healthy" value={stats['healthy'] ? 'yes' : 'no'} status={stats['healthy'] ? 'ok' : 'fail'} />
            ) : null}
          </div>
        </div>
      ) : null}
      {failedPayload?.['reason'] === 'rehearsal_breach' ? (
        <DiagnosisSection events={events} runId={run.id} planId={run.planId} repoUrl={run.repoUrl} chatTurns={chatTurns} />
      ) : null}
      <MedicInvestigationSection events={events} />
    </div>
  );
}

function AuthorArtifactCard({ finished, failed, stageEvents }: { finished?: EventRow; failed?: EventRow; stageEvents: EventRow[] }) {
  const fp = (finished?.payload ?? failed?.payload) as Record<string, unknown> | undefined;
  const carry = stageEvents.find((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return p?.['phase'] === 'pr.carry_committed';
  });
  const carryPayload = carry?.payload as Record<string, unknown> | undefined;
  const alreadyShipped = stageEvents.find((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return p?.['phase'] === 'pr.already_shipped' || p?.['phase'] === 'pr.already_merged' || p?.['phase'] === 'pr.no_op';
  });
  const alreadyPayload = alreadyShipped?.payload as Record<string, unknown> | undefined;
  const prUrl = (fp?.['pr_url'] as string | null | undefined) ?? (alreadyPayload?.['pr_url'] as string | undefined);
  const prNumber = fp?.['pr_number'] ?? alreadyPayload?.['pr_number'];
  const branch = (fp?.['branch'] as string | undefined) ?? (alreadyPayload?.['branch'] as string | undefined);
  const files = (fp?.['files'] as string[] | undefined) ?? (alreadyPayload?.['files'] as string[] | undefined);
  if (!fp && !alreadyPayload) return null;

  return (
    <div className="rounded-xl border border-rule/40 bg-card/60 p-5 space-y-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Pull request</h3>
      {alreadyPayload ? (
        <div className="rounded-md border border-muted/30 bg-card/40 p-3 text-sm flex items-start gap-2">
          <span className="text-muted shrink-0">⤳</span>
          <span className="text-muted">
            {alreadyPayload['note'] as string ?? 'Plumbing already shipped — author skipped.'}
          </span>
        </div>
      ) : null}
      {prUrl ? (
        <a href={prUrl} target="_blank" rel="noreferrer" className="block group">
          <div className="rounded-md border border-rule/60 hover:border-accent/60 transition-colors p-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-muted">PR #{String(prNumber)} {branch ? <span className="font-mono ml-1">on {branch}</span> : null}</div>
              <div className="text-sm text-accent group-hover:underline break-all">{prUrl}</div>
            </div>
            <span className="text-accent shrink-0">↗</span>
          </div>
        </a>
      ) : branch ? (
        <div className="text-xs text-muted">branch <span className="font-mono">{branch}</span></div>
      ) : null}
      {carryPayload ? (
        <div className="rounded-md border border-medic/30 bg-medic/5 p-3 space-y-2">
          <div className="text-xs font-medium text-medic">Carried operator-authored fix</div>
          <div className="text-sm font-mono">{String(carryPayload['commit_subject'])}</div>
          {Array.isArray(carryPayload['files']) ? (
            <ul className="text-xs text-muted font-mono space-y-0.5">
              {(carryPayload['files'] as string[]).slice(0, 6).map((f) => (
                <li key={f}>· {f}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {Array.isArray(files) && files.length > 0 ? (
        <div>
          <div className="text-xs text-muted mb-1.5">Convoy authored {files.length} file{files.length === 1 ? '' : 's'}</div>
          <ul className="text-xs text-muted font-mono space-y-0.5">
            {files.map((f) => (
              <li key={f}>· {f}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DeployArtifactCard({ stage, finished, failed, stageEvents }: { stage: Stage; finished?: EventRow; failed?: EventRow; stageEvents: EventRow[] }) {
  const trafficEvents = stageEvents.filter((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return e.kind === 'progress' && typeof p?.['traffic_split_percent'] === 'number';
  });
  const lastTraffic = trafficEvents.at(-1);
  const trafficPercent = (lastTraffic?.payload as Record<string, unknown> | undefined)?.['traffic_split_percent'];
  const fp = (finished?.payload ?? failed?.payload) as Record<string, unknown> | undefined;
  if (!fp && trafficEvents.length === 0) return null;

  return (
    <div className="rounded-xl border border-rule/40 bg-card/60 p-5 space-y-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{stage === 'canary' ? 'Canary deploy' : 'Promote to production'}</h3>
      {typeof trafficPercent === 'number' ? (
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm text-muted">traffic on canary</span>
            <span className="text-2xl font-semibold tabular-nums">{trafficPercent}<span className="text-base text-muted ml-0.5">%</span></span>
          </div>
          <div className="h-2 bg-rule/60 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.min(100, Number(trafficPercent))}%` }} />
          </div>
        </div>
      ) : null}
      {fp ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          {typeof fp['p99_delta_ms'] === 'number' ? (
            <Metric label="p99 Δ" value={`${fp['p99_delta_ms']}ms`} status={Number(fp['p99_delta_ms']) > 100 ? 'warn' : 'ok'} />
          ) : null}
          {typeof fp['error_rate_delta_pct'] === 'number' ? (
            <Metric label="err Δ" value={`${fp['error_rate_delta_pct']}%`} status={Number(fp['error_rate_delta_pct']) > 0.5 ? 'warn' : 'ok'} />
          ) : null}
          {typeof fp['healthy'] === 'boolean' ? (
            <Metric label="healthy" value={fp['healthy'] ? 'yes' : 'no'} status={fp['healthy'] ? 'ok' : 'fail'} />
          ) : null}
          {fp['preview_url'] ? (
            <a href={String(fp['preview_url'])} target="_blank" rel="noreferrer" className="col-span-2 sm:col-span-3 text-xs text-accent hover:underline break-all">
              {String(fp['preview_url'])} ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ObserveArtifactCard({ run, finished, failed }: { run: RunRow; finished?: EventRow; failed?: EventRow }) {
  const fp = (finished?.payload ?? failed?.payload) as Record<string, unknown> | undefined;
  if (!fp && !run.liveUrl) return null;
  return (
    <div className="rounded-xl border border-rule/40 bg-card/60 p-5 space-y-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Observe</h3>
      {fp ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          {typeof fp['window_seconds'] === 'number' ? (
            <Metric label="bake window" value={`${fp['window_seconds']}s`} status="ok" />
          ) : null}
          {typeof fp['slo_healthy'] === 'boolean' ? (
            <Metric label="SLO" value={fp['slo_healthy'] ? 'healthy' : 'breach'} status={fp['slo_healthy'] ? 'ok' : 'fail'} />
          ) : null}
        </div>
      ) : null}
      {run.liveUrl ? (
        <a href={run.liveUrl} target="_blank" rel="noreferrer" className="block rounded-md border border-rule/60 hover:border-accent/60 transition-colors p-3">
          <div className="text-xs text-muted">live</div>
          <div className="text-sm text-accent break-all">{run.liveUrl} ↗</div>
        </a>
      ) : null}
    </div>
  );
}

/**
 * Pinned at the top of the StageDetail body when the active stage failed.
 * Three pieces visible without scrolling:
 *   1. Failure headline + the run's outcomeReason (so the operator reads
 *      Convoy's own "what broke" before any event payload).
 *   2. The last 4–6 events leading up to the failure, expanded — the
 *      breadcrumbs you'd otherwise hunt through the timeline for.
 *   3. NextActionCard — a remedy adaptive to the failure shape (medic
 *      diagnosis, secrets, platform auth, generic).
 *
 * The wrapping <a id="failed-event"> + the ScrollIntoFailure client
 * component below cause the browser to auto-anchor to this section on
 * page load when the stage failed, so landing on a failed run jumps
 * the operator to the breach instead of the page top.
 */
function FailureSpotlight({
  run,
  events,
  stageEvents,
}: {
  run: RunRow;
  events: EventRow[];
  stageEvents: EventRow[];
}) {
  const failedEvent = stageEvents.find((e) => e.kind === 'failed');
  if (!failedEvent) return null;

  // Find events leading up to the failure within the same stage. We cap at
  // 6 so the spotlight stays compact; full timeline is below for the
  // operator who wants every breath.
  const failedIdx = stageEvents.indexOf(failedEvent);
  const leadUp = stageEvents.slice(Math.max(0, failedIdx - 6), failedIdx);

  const failedPayload = failedEvent.payload as Record<string, unknown> | null;
  const errorMessage = (failedPayload?.['error'] as string | undefined) ?? '';
  const headline = run.outcomeReason ?? errorMessage ?? 'Stage failed.';

  return (
    <section
      id="failed-event"
      data-failed-event=""
      className="rounded-xl border border-danger/50 bg-gradient-to-br from-danger/10 via-danger/5 to-transparent p-5 space-y-4"
    >
      <ScrollIntoFailure />
      <header className="flex items-start gap-3">
        <span aria-hidden className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-danger/20 text-danger text-base shrink-0">✗</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-danger tracking-tight">
            {failedEvent.stage} failed
          </h3>
          <p className="text-sm text-ink/90 mt-1 break-words">{headline}</p>
          {failedPayload?.['classification'] ? (
            <p className="text-xs text-muted mt-2 font-mono">
              classification=<span className="text-ink/80">{String(failedPayload['classification'])}</span>
              {failedPayload['reason'] ? <> · reason=<span className="text-ink/80">{String(failedPayload['reason'])}</span></> : null}
            </p>
          ) : null}
        </div>
      </header>

      {leadUp.length > 0 ? (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted mb-2">
            Leading up to the breach
          </p>
          <ol className="space-y-1">
            {leadUp.map((e) => {
              const isMedic = isMedicToolUse(e);
              const compact = renderPayload(e.payload);
              return (
                <li key={e.id} className="font-mono text-xs flex items-baseline gap-2 text-muted">
                  <span className={`shrink-0 ${
                    e.kind === 'started' ? 'text-accent' :
                    e.kind === 'finished' ? 'text-success' :
                    isMedic ? 'text-medic' :
                    'text-muted/60'
                  }`}>
                    {e.kind === 'started' ? '▸' : e.kind === 'finished' ? '✓' : isMedic ? '◇' : '·'}
                  </span>
                  <span className="text-muted/70 tabular-nums shrink-0">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="text-ink/80 break-all">
                    {isMedic ? renderMedicToolLine(e.payload) : compact || <em className="text-muted/60">{e.kind}</em>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <NextActionCard run={run} events={events} failedEvent={failedEvent} />
    </section>
  );
}

/**
 * Adaptive remedy card. Reads the failure shape and the medic verdict (if
 * present) to surface the most actionable next step inline, instead of
 * making the operator infer it from the logs. Falls back to a generic
 * "fix and resume" hint when no specific signal matches.
 *
 * Patterns matched:
 *   - Medic diagnosis with owned=developer  → fix code, then `convoy resume`
 *   - Reason mentions DATABASE_URL / secret / env / unset / unreachable
 *     / Prisma / connection / sslmode → likely missing platform env vars
 *     (the softpharmamanager case) — link to stage-secrets
 *   - Reason mentions auth / token / permission / 401 / 403 / Invalid
 *     token / not authenticated → re-auth platform CLI
 *   - Reason mentions did not respond 200 with status=401 → very likely
 *     Vercel SSO/preview-protection on a preview URL — surface as a
 *     distinct case
 *   - Generic fallback → read the timeline below + resume
 */
function NextActionCard({
  run,
  events,
  failedEvent,
}: {
  run: RunRow;
  events: EventRow[];
  failedEvent: EventRow;
}) {
  const reason = (run.outcomeReason ?? '').toLowerCase();
  const failedPayload = failedEvent.payload as Record<string, unknown> | null;
  const errorMessage = ((failedPayload?.['error'] as string | undefined) ?? '').toLowerCase();
  const hay = `${reason} ${errorMessage}`;

  const diagnosis = events.find((e) => e.kind === 'diagnosis');
  const diagnosisPayload = diagnosis?.payload as Record<string, unknown> | undefined;
  // owned is sometimes missing from the medic verdict (older runs, or
  // when classification didn't reach finalize_diagnosis). Treat presence
  // of a rootCause as sufficient to surface the medic-driven remedy —
  // the medic already filtered "convoy-authored vs developer" via its
  // system prompt; if rootCause names a developer file we trust it.
  const owned = String(diagnosisPayload?.['owned'] ?? '').toLowerCase();
  const rootCause = diagnosisPayload?.['rootCause'] as string | undefined;

  // Pattern detection — first match wins, ordered by specificity.
  type Action = {
    title: string;
    body: React.ReactNode;
    cta: { label: string; href?: string; command?: string }[];
  };
  let action: Action;

  if (diagnosis && rootCause) {
    const isConvoyOwned = owned === 'convoy';
    action = {
      title: isConvoyOwned ? 'Convoy will iterate on the authored file' : 'Fix your code, then resume',
      body: (
        <>
          <p className="text-sm">
            {isConvoyOwned
              ? 'Medic flagged a config-level failure in a Convoy-authored file. The pipeline can iterate on it via re-author.'
              : 'Medic identified the root cause as a code-level failure in your repo. Convoy paused so you can fix it without losing pipeline state.'}
          </p>
          <p className="text-xs text-muted mt-2 italic">
            &ldquo;{rootCause}&rdquo;
          </p>
        </>
      ),
      cta: [
        { label: 'Read full diagnosis', href: '#diagnosis' },
        { label: 'After fixing', command: 'convoy resume' },
      ],
    };
  } else if (
    /\bdid not respond 200\b.*\bstatus=401\b/.test(hay) ||
    /\bvercel\b.*\bsso\b/.test(hay) ||
    /\bpreview\b.*\bauthentication\b/.test(hay)
  ) {
    action = {
      title: 'Vercel preview is gated by SSO',
      body: (
        <p className="text-sm">
          The preview URL returned 401 — Vercel teams have <strong>preview deployment protection</strong> on by default, which blocks Convoy&apos;s observe probe. Disable it on this deployment or set a deployment-protection bypass header for Convoy to probe through.
        </p>
      ),
      cta: [
        { label: 'Vercel deployment-protection settings', href: 'https://vercel.com/docs/deployment-protection' },
        { label: 'Or bypass with header', command: 'vercel env add VERCEL_PROTECTION_BYPASS production' },
        { label: 'Then', command: 'convoy resume' },
      ],
    };
  } else if (
    /\bprisma\b.*\b(localhost|connection|reach|database server)\b/.test(hay) ||
    /\bdatabase_url\b/.test(hay) ||
    /\bunable to connect\b.*\bdatabase\b/.test(hay)
  ) {
    action = {
      title: 'Likely missing DATABASE_URL on the platform',
      body: (
        <p className="text-sm">
          The deployed app fell back to <code className="text-ink/90">localhost:5432</code> — your platform doesn&apos;t have <code className="text-ink/90">DATABASE_URL</code> set. Stage it via Convoy so Convoy pushes the value to the platform with the deploy.
        </p>
      ),
      cta: [
        { label: 'Stage interactively', command: `convoy stage-secrets ${run.planId?.slice(0, 8) ?? '<plan>'}` },
        { label: 'Or self-declare if you set it manually', command: 'convoy resume --already-set=DATABASE_URL' },
      ],
    };
  } else if (/\b(secret|env(ironment)? variable|unset|missing)\b/.test(hay)) {
    action = {
      title: 'Probably an unset env var on the platform',
      body: (
        <p className="text-sm">
          The failure mentions a missing or unset variable. Stage the required vars in Convoy so they ride into the deploy with the secrets push, instead of being set after the fact.
        </p>
      ),
      cta: [
        { label: 'Stage interactively', command: `convoy stage-secrets ${run.planId?.slice(0, 8) ?? '<plan>'}` },
      ],
    };
  } else if (/\b(invalid token|not authenticated|gh auth|fly auth|vercel login|permission denied|401|403)\b/.test(hay)) {
    action = {
      title: 'Re-authenticate the platform CLI',
      body: (
        <p className="text-sm">
          The failure looks like an auth problem. Re-authenticate the platform CLI Convoy uses for this deploy, then resume.
        </p>
      ),
      cta: [
        { label: 'GitHub', command: 'gh auth login' },
        { label: 'Fly', command: 'fly auth login' },
        { label: 'Vercel', command: 'vercel login' },
        { label: 'Then', command: 'convoy resume' },
      ],
    };
  } else if (/\btls\b|\bhandshake\b|\bcanceled\b/.test(hay)) {
    action = {
      title: 'Build builder lost auth or network',
      body: (
        <p className="text-sm">
          The platform builder returned mid-build (TLS handshake / token expiry / canceled). Often this is a build context that&apos;s too large — make sure a <code className="text-ink/90">.dockerignore</code> is present so the upload finishes inside the auth window. Convoy now drafts one alongside every Dockerfile.
        </p>
      ),
      cta: [
        { label: 'Resume after the fix lands', command: 'convoy resume' },
      ],
    };
  } else {
    action = {
      title: 'Inspect the events below, then resume',
      body: (
        <p className="text-sm">
          Convoy doesn&apos;t have a specific remedy for this failure shape. Read through the timeline below to identify the root cause, fix it locally, and run <code className="text-ink/90">convoy resume</code> — Convoy will continue from this stage on the same run row.
        </p>
      ),
      cta: [
        { label: 'After fixing', command: 'convoy resume' },
      ],
    };
  }

  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 space-y-3">
      <h4 className="text-sm font-semibold text-warn flex items-center gap-2">
        <span aria-hidden>→</span> What to do next
      </h4>
      <div className="text-ink/90">{action.body}</div>
      {action.cta.length > 0 ? (
        <ul className="space-y-1.5">
          {action.cta.map((c, idx) => (
            <li key={idx} className="text-xs flex items-baseline gap-2 flex-wrap">
              <span className="text-muted shrink-0">{c.label}</span>
              {c.command ? (
                <code className="font-mono bg-card border border-rule/40 rounded px-1.5 py-0.5 text-ink/90 break-all">
                  {c.command}
                </code>
              ) : null}
              {c.href ? (
                <a
                  href={c.href}
                  target={c.href.startsWith('http') ? '_blank' : undefined}
                  rel={c.href.startsWith('http') ? 'noreferrer' : undefined}
                  className="text-accent hover:underline"
                >
                  {c.href.startsWith('http') ? `${c.href} ↗` : c.href}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Metric({ label, value, status }: { label: string; value: string; status: 'ok' | 'warn' | 'fail' }) {
  const color =
    status === 'ok' ? 'text-success' :
    status === 'warn' ? 'text-warn' :
    'text-danger';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums font-mono ${color}`}>{value}</div>
    </div>
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

interface FailureLogPayload {
  phase: 'rehearsal.failure_logs';
  reason: string;
  excerpt: string;
  totalLines: number;
  excerptLines: number;
  truncated: boolean;
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
  const latestFailureLog = events
    .filter((e) => {
      if (e.kind !== 'log' || e.stage !== 'rehearse') return false;
      const p = e.payload as Record<string, unknown> | null;
      return p !== null && p['phase'] === 'rehearsal.failure_logs';
    })
    .at(-1)?.payload as FailureLogPayload | undefined;

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
            rawFailureLog={e.id === latestId ? latestFailureLog ?? null : null}
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
  rawFailureLog,
}: {
  diagnosis: MedicDiagnosis;
  createdAt: string;
  runId: string | null;
  planId: string | null;
  repoUrl: string;
  toolCalls: { tool: string; inputSummary: string; timestamp: string }[];
  chatTurns: MedicChatTurn[];
  rawFailureLog: FailureLogPayload | null;
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

        {rawFailureLog?.excerpt && diagnosis.source !== 'ai' ? (
          <DisclosureSection
            label={`Raw failure output${rawFailureLog.truncated ? ' (tail)' : ''}`}
            defaultOpen={diagnosis.source === 'error' || diagnosis.classification === 'unknown'}
          >
            <div className="space-y-3">
              <p className="text-xs text-muted leading-relaxed">
                {rawFailureLog.reason}
                {' · '}
                showing {rawFailureLog.excerptLines} of {rawFailureLog.totalLines} captured lines
                {rawFailureLog.truncated ? ' from the tail of the log' : ''}
              </p>
              <pre className="text-xs font-mono bg-ink text-paper rounded-md p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words">
                {rawFailureLog.excerpt}
              </pre>
            </div>
          </DisclosureSection>
        ) : null}

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
      <div className="flex flex-wrap items-stretch gap-2">
        {STAGE_ORDER.map((stage, idx) => {
          const s = status[stage] ?? 'idle';
          const styles: Record<string, string> = {
            idle: 'border-rule/60 text-muted bg-card',
            running: 'border-accent text-accent bg-accent/10 convoy-pulse',
            done: 'border-success/50 text-success bg-success/5',
            failed: 'border-danger text-danger bg-danger/10',
            skipped: 'border-muted/40 text-muted bg-card/60 opacity-70',
          };
          const icon: Record<string, string> = {
            idle: '○',
            running: '◐',
            done: '●',
            failed: '✗',
            skipped: '⤳',
          };
          return (
            <div key={stage} className="flex items-center">
              <div
                className={`px-3.5 py-2 rounded-md border font-mono text-sm font-medium inline-flex items-center gap-2 ${styles[s]}`}
              >
                <span aria-hidden className="text-xs">{icon[s]}</span>
                <span>{stage}</span>
              </div>
              {idx < STAGE_ORDER.length - 1 ? (
                <span className="text-muted/30 mx-1 text-xs select-none" aria-hidden>
                  →
                </span>
              ) : null}
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
  // Count `skipped` toward `done` for the progress bar — a skipped stage is
  // a complete one (it finished in the prior attempt and we replayed its
  // payload). Without this the bar would understate progress on resumed runs.
  const done = STAGE_ORDER.filter((s) => status[s] === 'done' || status[s] === 'skipped').length;
  const running = STAGE_ORDER.find((s) => status[s] === 'running');
  const pct = Math.min(100, Math.round((done / STAGE_ORDER.length) * 100));
  const elapsedMs =
    (completedAt ? new Date(completedAt).getTime() : Date.now()) - new Date(startedAt).getTime();

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {done}<span className="text-muted font-normal mx-1">/</span>{STAGE_ORDER.length}
          </span>
          <span className="text-sm text-muted uppercase tracking-wider">stages</span>
          {running ? (
            <span className="text-sm text-accent inline-flex items-center gap-1.5 ml-2">
              <span className="font-mono font-medium">{running}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="text-muted">running</span>
            </span>
          ) : null}
        </div>
        <div className="text-xs font-mono text-muted tabular-nums">
          {formatElapsed(elapsedMs)}
          {completedAt ? null : <span className="ml-1.5 text-accent animate-pulse">●</span>}
        </div>
      </div>
      <div className="h-2 bg-rule/60 rounded-full overflow-hidden">
        <div
          className="h-full convoy-progress-fill rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

/**
 * Renders only when medic events exist. Sits high in the page (right under
 * the progress bar) with a magenta glow so a screenshot or video frame makes
 * it obvious that the Claude-driven medic agent is in the loop.
 *
 * The body re-uses the existing tool-call list rendering — this component is
 * the visual frame, not a duplicated source of truth.
 */
function MedicSpotlight({
  events,
  runStatus,
}: {
  events: EventRow[];
  runStatus: string;
}) {
  const toolCalls = events.filter(isMedicToolUse);
  if (toolCalls.length === 0) return null;

  const seenFinalize = toolCalls.some((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return p?.['tool'] === 'finalize_diagnosis';
  });
  const isInvestigating = !seenFinalize && (runStatus === 'running' || runStatus === 'awaiting_fix' || runStatus === 'awaiting_approval');
  const recent = toolCalls.slice(-4);

  return (
    <section
      className={`relative rounded-xl border border-medic/40 bg-gradient-to-br from-medic/10 via-medic/5 to-transparent p-5 ${
        isInvestigating ? 'convoy-medic-glow' : ''
      }`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`inline-flex items-center justify-center w-8 h-8 rounded-full bg-medic/20 text-medic text-base ${
            isInvestigating ? 'animate-pulse' : ''
          }`}
          aria-hidden
        >
          ◇
        </span>
        <div className="flex flex-col">
          <h2 className="text-base font-semibold tracking-tight text-medic">
            {isInvestigating ? 'Medic is investigating' : 'Medic finished investigating'}
          </h2>
          <p className="text-xs text-muted">
            Claude agent · {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'} {isInvestigating ? '· live' : '· complete'}
          </p>
        </div>
        {isInvestigating ? (
          <span className="ml-auto text-xs text-medic inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-medic animate-pulse" />
            live
          </span>
        ) : null}
      </div>

      <ol className="mt-4 space-y-1.5">
        {recent.map((e, idx) => {
          const realIdx = toolCalls.length - recent.length + idx + 1;
          const tool = (e.payload as Record<string, unknown>)['tool'] as string;
          return (
            <li
              key={e.id}
              className="font-mono text-xs flex items-baseline gap-2 flex-wrap text-muted"
            >
              <span className="text-medic shrink-0">◇</span>
              <span className="text-muted/60 tabular-nums shrink-0 w-6 text-right">
                {realIdx}
              </span>
              <span className="text-ink font-semibold">{tool}</span>
              <span className="text-muted break-all">
                {renderMedicToolLine(e.payload).replace(/^\S+\s*/, '')}
              </span>
              <span className="text-muted/50 ml-auto shrink-0 tabular-nums">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
            </li>
          );
        })}
      </ol>

      {toolCalls.length > recent.length ? (
        <p className="mt-3 text-[11px] text-muted/70">
          Showing most recent {recent.length} of {toolCalls.length}. Full investigation log below.
        </p>
      ) : null}
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

  if (approval.kind === 'open_pr' && summary) {
    return <OpenPrApprovalCard runId={runId} approval={approval} summary={summary} />;
  }
  if (approval.kind === 'merge_pr' && summary) {
    return <MergePrApprovalCard runId={runId} approval={approval} summary={summary} />;
  }
  if (approval.kind === 'stage_secrets' && summary) {
    return <StageSecretsApprovalCard runId={runId} approval={approval} summary={summary} />;
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

function OpenPrApprovalCard({
  runId,
  approval,
  summary,
}: {
  runId: string;
  approval: ApprovalRow;
  summary: Record<string, unknown>;
}) {
  const mode = (summary['mode'] as string | undefined) ?? 'real';
  const repo = typeof summary['repo'] === 'string' ? summary['repo'] : null;
  const defaultBranch = typeof summary['default_branch'] === 'string' ? summary['default_branch'] : null;
  const branchToCreate = typeof summary['branch_to_create'] === 'string' ? summary['branch_to_create'] : null;
  const note = typeof summary['note'] === 'string' ? summary['note'] : null;
  const rehearsal = summary['rehearsal'] && typeof summary['rehearsal'] === 'object'
    ? (summary['rehearsal'] as Record<string, unknown>)
    : null;

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
          approve opening PR
        </span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
          {mode === 'scripted' ? 'scripted preview' : 'real PR'}
        </span>
        <span className="font-mono text-xs text-muted ml-auto">{approval.id.slice(0, 8)}</span>
      </div>

      {note ? <p className="text-sm text-muted leading-relaxed">{note}</p> : null}

      {rehearsal ? <RehearsalEvidence rehearsal={rehearsal} /> : (
        <div className="text-xs text-muted italic">
          No rehearsal evidence attached. This should not happen in the reordered pipeline —
          check the rehearse stage output above.
        </div>
      )}

      {repo || branchToCreate ? (
        <div className="text-xs font-mono text-muted space-y-1">
          {repo ? <div>repo: <span className="text-ink">{repo}</span></div> : null}
          {defaultBranch ? <div>base: <span className="text-ink">{defaultBranch}</span></div> : null}
          {branchToCreate ? <div>branch to create: <span className="text-ink">{branchToCreate}</span></div> : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">
          {files.length} file{files.length === 1 ? '' : 's'} Convoy will commit
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

function RehearsalEvidence({ rehearsal }: { rehearsal: Record<string, unknown> }) {
  const mode = typeof rehearsal['mode'] === 'string' ? rehearsal['mode'] : 'unknown';
  const healthy = typeof rehearsal['healthy'] === 'boolean' ? rehearsal['healthy'] : null;
  const durationMs = typeof rehearsal['duration_ms'] === 'number' ? rehearsal['duration_ms'] : null;
  const logLines = typeof rehearsal['log_lines'] === 'number' ? rehearsal['log_lines'] : null;
  const p99 = typeof rehearsal['p99_ms'] === 'number' ? rehearsal['p99_ms'] : null;
  const smokeCount = typeof rehearsal['smoke_tests_passed'] === 'number' ? rehearsal['smoke_tests_passed'] : null;
  const metrics = rehearsal['metrics'] && typeof rehearsal['metrics'] === 'object'
    ? (rehearsal['metrics'] as Record<string, unknown>)
    : null;

  return (
    <div className="border border-rule rounded-md bg-card p-3 space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted">Rehearsal evidence</div>
      <div className="flex items-center gap-3 flex-wrap text-xs">
        {healthy === true ? (
          <span className="inline-flex items-center gap-1.5 text-success">
            <span className="w-1.5 h-1.5 rounded-full bg-success" /> healthy
          </span>
        ) : healthy === false ? (
          <span className="inline-flex items-center gap-1.5 text-danger">
            <span className="w-1.5 h-1.5 rounded-full bg-danger" /> breached
          </span>
        ) : null}
        <span className="text-muted">mode: <span className="text-ink font-mono">{mode}</span></span>
        {durationMs !== null ? (
          <span className="text-muted">duration: <span className="text-ink tabular-nums">{(durationMs / 1000).toFixed(1)}s</span></span>
        ) : null}
        {smokeCount !== null ? (
          <span className="text-muted">smoke: <span className="text-ink tabular-nums">{smokeCount} passed</span></span>
        ) : null}
        {p99 !== null ? (
          <span className="text-muted">p99: <span className="text-ink tabular-nums">{p99}ms</span></span>
        ) : null}
        {logLines !== null ? (
          <span className="text-muted">logs: <span className="text-ink tabular-nums">{logLines} lines</span></span>
        ) : null}
      </div>
      {metrics ? (
        <div className="text-xs font-mono text-muted">
          {Object.entries(metrics).map(([k, v]) => (
            <span key={k} className="mr-3">
              {k}=<span className="text-ink">{String(v)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StageSecretsApprovalCard({
  runId,
  approval,
  summary,
}: {
  runId: string;
  approval: ApprovalRow;
  summary: Record<string, unknown>;
}) {
  const note = typeof summary['note'] === 'string' ? summary['note'] : null;
  const platform = (summary['platform'] as 'fly' | 'vercel' | 'cloudrun' | 'railway' | undefined) ?? 'fly';
  const planId = typeof summary['plan_id'] === 'string' ? (summary['plan_id'] as string) : '';
  const flyApp = typeof summary['fly_app'] === 'string' ? (summary['fly_app'] as string) : null;
  const targetCwd = typeof summary['target_cwd'] === 'string' ? (summary['target_cwd'] as string) : '';
  const sources = Array.isArray(summary['sources']) ? (summary['sources'] as string[]) : [];

  const rawMissing = summary['missing'];
  const missing: { key: string; severity: 'critical' | 'standard'; purpose: string }[] = Array.isArray(rawMissing)
    ? rawMissing.map((m) => {
        if (m && typeof m === 'object') {
          const obj = m as Record<string, unknown>;
          return {
            key: typeof obj['key'] === 'string' ? obj['key'] : '(unknown)',
            severity: obj['severity'] === 'critical' ? 'critical' : 'standard',
            purpose: typeof obj['purpose'] === 'string' ? obj['purpose'] : 'required',
          };
        }
        return { key: '(unknown)', severity: 'standard' as const, purpose: 'required' };
      })
    : [];

  return (
    <div className="border border-warn/40 bg-warn/5 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warn">
          <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
          stage secrets before deploy
        </span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-rule text-muted">
          {platform}
        </span>
        <span className="font-mono text-xs text-muted ml-auto">{approval.id.slice(0, 8)}</span>
      </div>
      {note ? <p className="text-sm text-muted leading-relaxed">{note}</p> : null}
      {sources.length > 0 ? (
        <p className="text-xs text-muted">
          Required keys derived from: {sources.join(', ')}.
        </p>
      ) : null}

      {planId && missing.length > 0 ? (
        <SecretStagingForm
          runId={runId}
          approvalId={approval.id}
          planId={planId}
          missing={missing}
          platform={platform}
          flyApp={flyApp}
          targetCwd={targetCwd}
        />
      ) : (
        <ApprovalActions runId={runId} approvalId={approval.id} kind={approval.kind} />
      )}
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

function computeStageStatus(events: EventRow[]): Record<string, 'idle' | 'running' | 'done' | 'failed' | 'skipped'> {
  const status: Record<string, 'idle' | 'running' | 'done' | 'failed' | 'skipped'> = {};
  for (const e of events) {
    if (e.kind === 'started') status[e.stage] = 'running';
    else if (e.kind === 'finished') status[e.stage] = 'done';
    else if (e.kind === 'failed') status[e.stage] = 'failed';
    else if (e.kind === 'skipped') status[e.stage] = 'skipped';
  }
  return status;
}

function markerForEvent(event: EventRow): string {
  if (isMedicToolUse(event)) return 'bg-warn';
  const kind = event.kind;
  if (kind === 'failed') return 'bg-danger';
  if (kind === 'finished') return 'bg-success';
  if (kind === 'skipped') return 'bg-muted';
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
