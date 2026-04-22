import { notFound } from 'next/navigation';

import { getPlan, type PlanAuthoredFile, type PlanSummary } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = getPlan(id);
  if (!plan) notFound();

  const notDeployable = plan.deployability.verdict === 'not-cloud-deployable';

  return (
    <article className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]">
            ← Plans
          </a>
          <span className="font-mono text-xs text-[color:var(--color-muted)]">{plan.id.slice(0, 8)}</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{plan.target.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-muted)]">
          <Tag>{plan.target.ecosystem}</Tag>
          {plan.target.framework ? <Tag>{plan.target.framework}</Tag> : null}
          <span>·</span>
          <span>{plan.target.repoUrl ?? plan.target.localPath}</span>
        </div>
        {plan.target.readmeTitle ? (
          <p className="text-[color:var(--color-muted)] italic">&quot;{plan.target.readmeTitle}&quot;</p>
        ) : null}
      </header>

      <Summary plan={plan} notDeployable={notDeployable} />

      {notDeployable ? null : (
        <>
          <AuthorSection files={plan.author.convoyAuthoredFiles} />
          <ShipSection plan={plan} />
          <PlatformSection plan={plan} />
        </>
      )}

      <RisksSection risks={plan.risks} />
      <EvidenceSection evidence={plan.evidence} />

      {notDeployable ? null : (
        <div className="flex items-center gap-4 pt-6 border-t border-[color:var(--color-rule)]">
          <button
            disabled
            title="Apply from CLI: npm run convoy -- apply <id>"
            className="px-4 py-2 rounded-md bg-[color:var(--color-ink)] text-white text-sm font-medium opacity-60 cursor-not-allowed"
          >
            Apply plan →
          </button>
          <code className="text-xs text-[color:var(--color-muted)]">
            npm run convoy -- apply {plan.id.slice(0, 8)}
          </code>
        </div>
      )}
    </article>
  );
}

function Summary({ plan, notDeployable }: { plan: PlanSummary; notDeployable: boolean }) {
  return (
    <section className="space-y-3">
      <p className="text-lg leading-relaxed">{plan.summary}</p>
      {notDeployable ? (
        <p className="text-sm text-[color:var(--color-danger)]">{plan.deployability.reason}</p>
      ) : null}
    </section>
  );
}

function AuthorSection({ files }: { files: PlanAuthoredFile[] }) {
  if (files.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--color-muted)]">
        What Convoy will author
      </h2>
      <div className="border border-[color:var(--color-rule)] rounded-lg overflow-hidden divide-y divide-[color:var(--color-rule)] bg-white">
        {files.map((file) => (
          <details key={file.path} className="group">
            <summary className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-[color:var(--color-rule)]/30 select-none">
              <span className="text-[color:var(--color-success)] font-mono">+</span>
              <span className="font-mono text-sm font-medium">{file.path}</span>
              <span className="text-xs text-[color:var(--color-muted)] ml-auto">
                {file.lines} lines — {file.summary}
              </span>
              <span className="text-[color:var(--color-muted)] text-xs group-open:hidden">view</span>
              <span className="text-[color:var(--color-muted)] text-xs hidden group-open:inline">hide</span>
            </summary>
            <pre className="px-5 py-4 text-xs overflow-auto bg-[#0b0d10] text-[#fafaf9] leading-relaxed">
              <code>{file.contentPreview}</code>
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}

function ShipSection({ plan }: { plan: PlanSummary }) {
  const mergeApproval = plan.approvals.find((a) => a.kind === 'merge_pr');
  const promoteApproval = plan.approvals.find((a) => a.kind === 'promote');
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--color-muted)]">How it ships</h2>
      <ol className="space-y-3">
        <Step index={1} kind="approval" text={mergeApproval?.description ?? 'PR merge required.'} />
        <Step
          index={2}
          kind="action"
          text={
            <>
              Rehearse on <span className="font-mono text-sm">{plan.rehearsal.targetDescriptor}</span>
              {plan.rehearsal.buildCommand ? (
                <>
                  {' '}
                  · build <code className="text-sm">{plan.rehearsal.buildCommand}</code>
                </>
              ) : null}
              {plan.rehearsal.startCommand ? (
                <>
                  {' '}
                  · start <code className="text-sm">{plan.rehearsal.startCommand}</code>
                </>
              ) : null}
              {plan.rehearsal.expectedPort ? <> · port {plan.rehearsal.expectedPort}</> : null}
            </>
          }
        />
        <Step
          index={3}
          kind="action"
          text={<>Validate: {plan.rehearsal.validations.slice(0, 4).join(' · ')}</>}
        />
        <Step index={4} kind="approval" text={promoteApproval?.description ?? 'Promote approval required.'} />
        <Step
          index={5}
          kind="action"
          text={
            <>
              Canary {plan.promotion.canary.trafficPercent}% for {plan.promotion.canary.bakeWindowSeconds}s — halt on{' '}
              <em>{plan.promotion.haltOn[0] ?? 'SLO breach'}</em>
            </>
          }
        />
        <Step
          index={6}
          kind="action"
          text={
            <>
              Promote {plan.promotion.steps.map((s) => `${s.trafficPercent}%`).join(' → ')} with{' '}
              {plan.promotion.steps[0]?.bakeWindowSeconds ?? 30}s bake per step
            </>
          }
        />
        <Step
          index={7}
          kind="action"
          text={
            <>
              Observe — auto-rollback via <code className="text-sm">{plan.rollback.strategy}</code> (~
              {plan.rollback.estimatedSeconds}s) if any halt condition fires
            </>
          }
        />
      </ol>
    </section>
  );
}

function Step({
  index,
  kind,
  text,
}: {
  index: number;
  kind: 'action' | 'approval';
  text: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-4">
      <span className="shrink-0 w-6 h-6 rounded-full bg-[color:var(--color-rule)] text-[color:var(--color-muted)] text-xs font-medium flex items-center justify-center mt-0.5">
        {index}
      </span>
      <div className="flex-1 pt-0.5">
        {kind === 'approval' ? (
          <span className="inline-block text-[10px] uppercase tracking-wider font-medium text-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 px-1.5 py-0.5 rounded mr-2">
            approval
          </span>
        ) : null}
        {text}
      </div>
    </li>
  );
}

function PlatformSection({ plan }: { plan: PlanSummary }) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--color-muted)]">
        Why this platform
      </h2>
      <div className="border border-[color:var(--color-rule)] rounded-lg p-5 bg-white space-y-3">
        <p className="leading-relaxed">{plan.platform.reason}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
          {plan.platform.candidates.map((c) => {
            const chosen = c.platform === plan.platform.chosen;
            return (
              <div
                key={c.platform}
                className={`border rounded-md p-3 ${chosen ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5' : 'border-[color:var(--color-rule)]'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold">{c.platform}</span>
                  <span className="text-xs text-[color:var(--color-muted)]">{c.score}</span>
                </div>
                {chosen ? (
                  <div className="text-[10px] text-[color:var(--color-accent)] mt-1 uppercase tracking-wider font-medium">
                    chosen
                  </div>
                ) : null}
                <div className="text-xs text-[color:var(--color-muted)] mt-2 line-clamp-3">{c.reason}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RisksSection({ risks }: { risks: PlanSummary['risks'] }) {
  if (risks.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--color-muted)]">Risks</h2>
      <ul className="space-y-2">
        {risks.map((risk, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <RiskBadge level={risk.level} />
            <span className="flex-1">{risk.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RiskBadge({ level }: { level: string }) {
  const styles: Record<string, string> = {
    block: 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]',
    warn: 'bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]',
    info: 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]',
  };
  return (
    <span className={`shrink-0 text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${styles[level] ?? styles['info']!}`}>
      {level}
    </span>
  );
}

function EvidenceSection({ evidence }: { evidence: string[] }) {
  if (evidence.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--color-muted)]">Evidence</h2>
      <ul className="font-mono text-xs text-[color:var(--color-muted)] space-y-1">
        {evidence.slice(0, 10).map((e, i) => (
          <li key={i}>· {e}</li>
        ))}
      </ul>
    </section>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[color:var(--color-rule)] text-[color:var(--color-muted)] font-medium">
      {children}
    </span>
  );
}
