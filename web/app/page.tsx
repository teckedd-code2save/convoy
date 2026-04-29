import { listPlans, plansLocation, type PlanSummary } from '@/lib/plans';
import { listRuns, type RunRow } from '@/lib/runs';

export const dynamic = 'force-dynamic';

export default function Home() {
  const plans = listPlans();
  const runs = listRuns(8);
  const hasContent = plans.length + runs.length > 0;

  return (
    <div className="space-y-12">
      <section className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight leading-tight">
          The deployment agent that ships your code — <span className="text-muted">without rewriting it.</span>
        </h1>
        <p className="text-lg text-muted leading-relaxed max-w-2xl">
          Convoy turns a pull request into a safe production deployment. Rehearse on a twin of your target. Promote through canary steps watched against real signals. Auto-rollback when they breach. When something breaks, medic tells you where — it doesn&apos;t rewrite your code.
        </p>
        <div className="flex items-center gap-4 text-sm pt-2">
          <a href="/runs" className="inline-flex items-center gap-1.5 text-accent hover:underline">
            Recent runs →
          </a>
          <span className="text-muted">·</span>
          <a
            href="https://github.com/teckedd-code2save/convoy"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted hover:text-ink"
          >
            Source ↗
          </a>
        </div>
      </section>

      {!hasContent ? (
        <div className="border border-dashed border-rule rounded-lg p-10 text-center space-y-3">
          <p className="text-muted">No plans or runs yet.</p>
          <p className="text-sm text-muted">
            Create your first plan:{' '}
            <code className="px-1.5 py-0.5 rounded bg-rule">
              npm run convoy -- plan &lt;path&gt; --save
            </code>
          </p>
          <p className="text-xs text-muted pt-1">Plans directory: {plansLocation()}</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-8">
          <PlansCard plans={plans.slice(0, 6)} total={plans.length} />
          <RunsCard runs={runs} />
        </div>
      )}
    </div>
  );
}

function PlansCard({ plans, total }: { plans: PlanSummary[]; total: number }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Plans</h2>
        {total > 0 ? <span className="text-xs text-muted">{total} saved</span> : null}
      </div>
      {plans.length === 0 ? (
        <div className="border border-dashed border-rule rounded-lg p-6 text-center text-sm text-muted">
          No plans yet.
        </div>
      ) : (
        <ul className="border border-rule rounded-lg overflow-hidden bg-card divide-y divide-rule">
          {plans.map((plan) => (
            <li key={plan.id}>
              <a
                href={`/plans/${plan.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-rule/40 transition-colors"
              >
                <span className="font-mono text-[10px] text-muted shrink-0 w-14">
                  {plan.id.slice(0, 8)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate text-sm">{plan.target.name}</span>
                    <Tag>{plan.target.ecosystem}</Tag>
                    {plan.target.framework ? <Tag>{plan.target.framework}</Tag> : null}
                    {plan.lanes && plan.lanes.length > 1 ? <Tag>{plan.lanes.length} lanes</Tag> : null}
                  </div>
                </div>
                <PlatformBadge plan={plan} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunsCard({ runs }: { runs: RunRow[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Runs</h2>
        <a href="/runs" className="text-xs text-accent hover:underline">
          all →
        </a>
      </div>
      {runs.length === 0 ? (
        <div className="border border-dashed border-rule rounded-lg p-6 text-center text-sm text-muted">
          No runs yet. <code className="px-1 py-0.5 rounded bg-rule text-xs">convoy apply</code> a plan to start one.
        </div>
      ) : (
        <ul className="border border-rule rounded-lg overflow-hidden bg-card divide-y divide-rule">
          {runs.map((run) => (
            <li key={run.id}>
              <a
                href={`/runs/${run.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-rule/40 transition-colors"
              >
                <span className="font-mono text-[10px] text-muted shrink-0 w-14">
                  {run.id.slice(0, 8)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {run.platform ? <Tag>{run.platform}</Tag> : null}
                    <span className="text-sm text-muted truncate">{shortRepo(run.repoUrl)}</span>
                  </div>
                </div>
                <StatusBadge status={run.status} />
              </a>
            </li>
          ))}
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

function PlatformBadge({ plan }: { plan: PlanSummary }) {
  if (plan.deployability.verdict === 'not-cloud-deployable') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-danger shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-danger" />
        refused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-success" />
      {plan.platform.chosen}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
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
    <span className="inline-flex items-center gap-1.5 text-xs font-medium shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
      {c.label}
    </span>
  );
}

function shortRepo(url: string): string {
  if (url.startsWith('/') || url.startsWith('.')) {
    const parts = url.split('/');
    return parts.slice(-2).join('/');
  }
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}
