import { notFound } from 'next/navigation';

import { getProject } from '@/lib/projects';
import { listRunsForPlan, type RunRow } from '@/lib/runs';
import type { PlanSummary } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export default function ProjectPage({ params }: { params: { slug: string } }) {
  const found = getProject(params.slug);
  if (!found) notFound();
  const project = found!;

  // Load runs per plan (already loaded in lib, but we need per-plan grouping here)
  const planRuns = project.plans.map((plan) => ({
    plan,
    runs: listRunsForPlan(plan.id),
  }));

  const totalRuns = planRuns.reduce((s, pr) => s + pr.runs.length, 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted">
          <a href="/projects" className="hover:text-ink">Projects</a>
          <span>/</span>
          <span className="text-ink font-medium">{project.name}</span>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            <p className="text-sm text-muted mt-1 font-mono">{project.localPath}</p>
          </div>
          <div className="flex items-center gap-3">
            {project.liveUrl ? (
              <a
                href={project.liveUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-accent hover:underline"
              >
                {project.liveUrl} ↗
              </a>
            ) : null}
            {project.repoUrl ? (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted hover:text-ink"
              >
                repo ↗
              </a>
            ) : null}
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-6 pt-1">
          <Stat label="Platform" value={project.platform ?? '—'} />
          <Stat label="Plans" value={String(project.plans.length)} />
          <Stat label="Total runs" value={String(totalRuns)} />
          {project.latestRun ? (
            <Stat
              label="Last status"
              value={project.latestRun.status.replace(/_/g, ' ')}
              highlight={statusHighlight(project.latestRun.status)}
            />
          ) : null}
        </div>
      </div>

      {/* Plans + runs */}
      <div className="space-y-6">
        {planRuns.map(({ plan, runs }) => (
          <PlanCard key={plan.id} plan={plan} runs={runs} />
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-sm font-medium ${highlight ?? ''}`}>{value}</div>
    </div>
  );
}

function PlanCard({ plan, runs }: { plan: PlanSummary; runs: RunRow[] }) {
  const latestRun = runs[0] ?? null;

  return (
    <section className="border border-rule rounded-lg overflow-hidden bg-card">
      {/* Plan header */}
      <a
        href={`/plans/${plan.id}`}
        className="flex items-center gap-4 px-5 py-3 hover:bg-rule/40 transition-colors border-b border-rule"
      >
        <span className="font-mono text-[10px] text-muted w-16 shrink-0">{plan.id.slice(0, 8)}</span>
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">Plan</span>
          {plan.platform?.chosen ? <Tag>{plan.platform.chosen}</Tag> : null}
          {plan.lanes && plan.lanes.length > 1 ? <Tag>{plan.lanes.length} lanes</Tag> : null}
          <span className="text-xs text-muted">{formatDate(plan.createdAt)}</span>
        </div>
        {latestRun ? (
          <span className={`text-xs font-medium shrink-0 ${statusHighlight(latestRun.status)}`}>
            {latestRun.status.replace(/_/g, ' ')}
          </span>
        ) : (
          <span className="text-xs text-muted shrink-0">no runs</span>
        )}
      </a>

      {/* Run list */}
      {runs.length === 0 ? (
        <div className="px-5 py-4 text-sm text-muted">
          No runs for this plan yet.{' '}
          <code className="px-1.5 py-0.5 rounded bg-rule text-xs">
            convoy apply {plan.id.slice(0, 8)}
          </code>
        </div>
      ) : (
        <ul className="divide-y divide-rule">
          {runs.slice(0, 6).map((run) => (
            <li key={run.id}>
              <a
                href={`/runs/${run.id}`}
                className="flex items-center gap-4 px-5 py-3 hover:bg-rule/40 transition-colors"
              >
                <span className="font-mono text-[10px] text-muted w-16 shrink-0">{run.id.slice(0, 8)}</span>
                <div className="flex-1 min-w-0 flex items-center gap-2 text-xs text-muted">
                  {run.platform ? <Tag>{run.platform}</Tag> : null}
                  <span>{relativeTime(run.startedAt)}</span>
                </div>
                {run.liveUrl ? (
                  <a
                    href={run.liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-accent hover:underline shrink-0"
                  >
                    live ↗
                  </a>
                ) : null}
                <RunStatusBadge status={run.status} />
              </a>
            </li>
          ))}
          {runs.length > 6 ? (
            <li className="px-5 py-2 text-xs text-muted">
              +{runs.length - 6} older runs —{' '}
              <a href={`/runs`} className="text-accent hover:underline">
                see all runs
              </a>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rule text-muted font-medium">
      {children}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium shrink-0 ${statusHighlight(status)}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${statusDot(status)}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function statusHighlight(status: string): string {
  if (status === 'succeeded') return 'text-success';
  if (status === 'failed') return 'text-danger';
  if (status === 'rolled_back') return 'text-warn';
  if (status === 'running' || status === 'awaiting_approval' || status === 'awaiting_fix') return 'text-accent';
  return 'text-muted';
}

function statusDot(status: string): string {
  if (status === 'succeeded') return 'bg-success';
  if (status === 'failed') return 'bg-danger';
  if (status === 'rolled_back' || status === 'awaiting_approval' || status === 'awaiting_fix') return 'bg-warn';
  if (status === 'running') return 'bg-accent animate-pulse';
  return 'bg-muted';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
