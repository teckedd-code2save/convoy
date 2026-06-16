import { listPlans, type PlanSummary } from '@/lib/plans';
import { listRuns, type RunRow } from '@/lib/runs';
import { PipelineHero } from '@/components/pipeline-hero';
import { HeroCards } from '@/components/hero-cards';
import { Starfield } from '@/components/starfield';

export const dynamic = 'force-dynamic';

export default function Home() {
  const plans = listPlans();
  const runs = listRuns(8);
  const hasContent = plans.length + runs.length > 0;
  const activePlans = plans.filter(p => !p.supersededBy);

  return (
    <div className="space-y-0">
      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section
        className="relative -mx-6 px-6 pt-16 pb-12 overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(110,168,255,0.06) 0%, transparent 100%)',
          borderBottom: '1px solid rgba(38,38,47,0.6)',
        }}
      >
        <Starfield />

        {/* Title */}
        <div className="relative z-10 text-center space-y-4 mb-14">
          <div className="inline-flex items-center gap-2 text-xs text-muted border border-rule/60 rounded-full px-3 py-1 bg-card/50 backdrop-blur-sm mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            rehearse · ship · observe
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight">
            The deployment agent that{' '}
            <span
              className="relative"
              style={{
                background: 'linear-gradient(135deg, #6ea8ff 0%, #38d399 50%, #c084fc 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              ships your code
            </span>
          </h1>
          <p className="text-lg text-muted max-w-2xl mx-auto leading-relaxed">
            Plan. Rehearse on a live twin. Author only the files you&apos;d rather not write.
            Promote through canary steps gated by real signals. Auto-roll back when they breach.
            When something breaks, medic tells you where — it doesn&apos;t touch your code.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <a
              href="/plans"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                background: 'linear-gradient(135deg, rgba(110,168,255,0.15), rgba(56,211,153,0.1))',
                border: '1px solid rgba(110,168,255,0.3)',
                color: 'var(--color-accent)',
                boxShadow: '0 0 20px rgba(110,168,255,0.1)',
              }}
            >
              View plans →
            </a>
            <a
              href="/runs"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted border border-rule/60 hover:border-rule transition-all hover:text-ink"
            >
              Recent runs
            </a>
            <a
              href="https://github.com/teckedd-code2save/convoy"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-muted border border-rule/60 hover:border-rule transition-all hover:text-ink"
            >
              Source ↗
            </a>
          </div>
        </div>

        {/* Pipeline visualization */}
        <div className="relative z-10 max-w-4xl mx-auto">
          <PipelineHero />
          <p className="text-center text-xs text-muted mt-1 opacity-60">
            Hover a stage to see what it does
          </p>
        </div>
      </section>

      {/* ── Floating cards (stats / live metrics) ─────────────────── */}
      <section className="relative -mx-6 px-6 py-14 overflow-hidden"
        style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(56,211,153,0.04), transparent)',
        }}
      >
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8 space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">Evidence, not promises</h2>
            <p className="text-sm text-muted max-w-xl mx-auto">
              Every decision is grounded in real signals — scan evidence, platform scores, live p99, error rates.
              The plan is the audit trail.
            </p>
          </div>
          <HeroCards />
        </div>
      </section>

      {/* ── Feature pills ─────────────────────────────────────────── */}
      <section className="border-t border-b border-rule/40 -mx-6 px-6 py-10">
        <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-3 gap-4">
          {[
            { icon: '🎯', title: 'Onboard once', desc: 'First-contact interview locks in your platform mandate, approvers, and compliance requirements.' },
            { icon: '🔍', title: 'Orient every run', desc: 'Drift detection compares repo artifacts to declared preferences. Never a silent re-score.' },
            { icon: '🧪', title: 'Rehearse before the PR', desc: 'Synthetic load on a live twin. p99, error-rate, stdout captured. Medic agent diagnoses breaches.' },
            { icon: '🔑', title: 'Secrets-manager native', desc: 'Pull from Infisical, Doppler, or Vault. Push to the platform. Nothing leaks to stdout.' },
            { icon: '🌊', title: 'Canary-first deploys', desc: '5% → 10% → 25% → 50% → 100%, each gate watched by real signals with auto-rollback.' },
            { icon: '📋', title: 'Plans as runbooks', desc: 'Every plan page is the handoff document: what was scanned, scored, staged, rehearsed.' },
          ].map(f => (
            <div
              key={f.title}
              className="rounded-xl p-4 space-y-2 border border-rule/50 bg-card/40 hover:bg-card/70 hover:border-rule transition-all"
            >
              <div className="text-2xl">{f.icon}</div>
              <div className="font-medium text-sm">{f.title}</div>
              <div className="text-xs text-muted leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Plans + Runs dashboard ─────────────────────────────────── */}
      <section className="py-12 space-y-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Your workspace</h2>
          {!hasContent && (
            <span className="text-xs text-muted">
              Run <code className="px-1 py-0.5 rounded bg-rule">convoy plan &lt;path&gt; --save</code> to get started
            </span>
          )}
        </div>

        {!hasContent ? (
          <EmptyState />
        ) : (
          <div className="grid md:grid-cols-2 gap-8">
            <PlansCard plans={activePlans.slice(0, 6)} total={activePlans.length} />
            <RunsCard runs={runs} />
          </div>
        )}
      </section>

      {/* ── Quick start strip ─────────────────────────────────────── */}
      <section
        className="-mx-6 px-6 py-10 border-t border-rule/40"
        style={{ background: 'rgba(14,14,18,0.6)' }}
      >
        <div className="max-w-4xl mx-auto grid sm:grid-cols-3 gap-6 text-sm">
          <div className="space-y-2">
            <div className="text-xs text-muted uppercase tracking-wider font-semibold">1 · Install</div>
            <code className="block text-xs bg-rule/60 px-3 py-2 rounded-lg text-ink leading-relaxed break-all">
              curl -fsSL …/scripts/get | bash
            </code>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-muted uppercase tracking-wider font-semibold">2 · Onboard</div>
            <code className="block text-xs bg-rule/60 px-3 py-2 rounded-lg text-ink">
              convoy onboard ./my-repo
            </code>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-muted uppercase tracking-wider font-semibold">3 · Ship</div>
            <code className="block text-xs bg-rule/60 px-3 py-2 rounded-lg text-ink">
              convoy ship ./my-repo
            </code>
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-2xl border border-dashed border-rule p-12 text-center space-y-4"
      style={{ background: 'rgba(20,20,26,0.4)' }}
    >
      <div className="w-12 h-12 rounded-full border border-rule/60 flex items-center justify-center mx-auto">
        <span className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
      </div>
      <div>
        <p className="font-medium">No plans yet</p>
        <p className="text-sm text-muted mt-1">
          Start with an onboard interview, then create your first plan.
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-center justify-center text-xs">
        <code className="px-3 py-1.5 rounded-lg bg-rule text-ink">convoy onboard ./your-repo</code>
        <span className="text-muted">then</span>
        <code className="px-3 py-1.5 rounded-lg bg-rule text-ink">convoy plan ./your-repo --save</code>
      </div>
    </div>
  );
}

function PlansCard({ plans, total }: { plans: PlanSummary[]; total: number }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Active Plans</h2>
        {total > 0 ? (
          <a href="/plans" className="text-xs text-accent hover:underline">{total} total →</a>
        ) : null}
      </div>
      {plans.length === 0 ? (
        <div className="border border-dashed border-rule rounded-xl p-6 text-center text-sm text-muted">
          No plans yet. Run <code className="px-1 py-0.5 rounded bg-rule text-xs">convoy plan &lt;path&gt; --save</code>
        </div>
      ) : (
        <ul className="border border-rule rounded-xl overflow-hidden bg-card divide-y divide-rule">
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Recent Runs</h2>
        <a href="/runs" className="text-xs text-accent hover:underline">all →</a>
      </div>
      {runs.length === 0 ? (
        <div className="border border-dashed border-rule rounded-xl p-6 text-center text-sm text-muted">
          No runs yet.{' '}
          <code className="px-1 py-0.5 rounded bg-rule text-xs">convoy apply &lt;planId&gt;</code>
        </div>
      ) : (
        <ul className="border border-rule rounded-xl overflow-hidden bg-card divide-y divide-rule">
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
    pending:           { color: 'bg-muted',                  label: 'pending' },
    running:           { color: 'bg-accent animate-pulse',   label: 'running' },
    awaiting_approval: { color: 'bg-warn animate-pulse',     label: 'awaiting approval' },
    awaiting_fix:      { color: 'bg-warn animate-pulse',     label: 'awaiting fix' },
    succeeded:         { color: 'bg-success',                label: 'succeeded' },
    failed:            { color: 'bg-danger',                 label: 'failed' },
    rolled_back:       { color: 'bg-warn',                   label: 'rolled back' },
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
