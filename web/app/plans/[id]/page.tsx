import { notFound } from 'next/navigation';

import { getPlan, type PlanAuthoredFile, type PlanSummary } from '@/lib/plans';
import { listRunsForPlan, type RunRow } from '@/lib/runs';

export const dynamic = 'force-dynamic';

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = getPlan(id);
  if (!plan) notFound();

  const notDeployable = plan.deployability.verdict === 'not-cloud-deployable';
  const runs = listRunsForPlan(plan.id);

  return (
    <article className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-muted hover:text-ink">
            ← Plans
          </a>
          <span className="font-mono text-xs text-muted">{plan.id.slice(0, 8)}</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{plan.target.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Tag>{plan.target.ecosystem}</Tag>
          {plan.target.framework ? <Tag>{plan.target.framework}</Tag> : null}
          <span>·</span>
          <span>{plan.target.repoUrl ?? plan.target.localPath}</span>
        </div>
        {plan.target.readmeTitle ? (
          <p className="text-muted italic">&quot;{plan.target.readmeTitle}&quot;</p>
        ) : null}
      </header>

      <Summary plan={plan} notDeployable={notDeployable} />

      {runs.length > 0 ? <RunsForPlan runs={runs} /> : null}

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
        <div className="flex items-center gap-4 pt-6 border-t border-rule">
          <button
            disabled
            title="Apply from CLI: npm run convoy -- apply <id>"
            className="px-4 py-2 rounded-md bg-ink text-white text-sm font-medium opacity-60 cursor-not-allowed"
          >
            Apply plan →
          </button>
          <code className="text-xs text-muted">
            npm run convoy -- apply {plan.id.slice(0, 8)}
          </code>
        </div>
      )}
    </article>
  );
}

function RunsForPlan({ runs }: { runs: RunRow[] }) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
        Runs from this plan ({runs.length})
      </h2>
      <ul className="divide-y divide-rule border border-rule rounded-lg overflow-hidden bg-card">
        {runs.map((run) => (
          <li key={run.id}>
            <a
              href={`/runs/${run.id}`}
              className="flex items-center gap-6 px-5 py-3 hover:bg-rule/40 transition-colors"
            >
              <span className="font-mono text-xs text-muted shrink-0 w-20">
                {run.id.slice(0, 8)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <RunStatusBadge status={run.status} />
                  {run.liveUrl ? (
                    <span className="font-mono text-xs text-accent truncate">{run.liveUrl}</span>
                  ) : null}
                </div>
              </div>
              <div className="text-xs text-muted shrink-0">{formatDelta(run.startedAt)}</div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunStatusBadge({ status }: { status: string }) {
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
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
      {c.label}
    </span>
  );
}

function formatDelta(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function Summary({ plan, notDeployable }: { plan: PlanSummary; notDeployable: boolean }) {
  return (
    <section className="space-y-3">
      <p className="text-lg leading-relaxed">{plan.summary}</p>
      {notDeployable ? (
        <p className="text-sm text-danger">{plan.deployability.reason}</p>
      ) : null}
    </section>
  );
}

function AuthorSection({ files }: { files: PlanAuthoredFile[] }) {
  if (files.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
        What Convoy will author
      </h2>
      <div className="border border-rule rounded-lg overflow-hidden divide-y divide-rule bg-card">
        {files.map((file) => (
          <details key={file.path} className="group">
            <summary className="flex items-center gap-4 px-5 py-3 cursor-pointer hover:bg-rule/30 select-none">
              <span className="text-success font-mono">+</span>
              <span className="font-mono text-sm font-medium">{file.path}</span>
              <span className="text-xs text-muted ml-auto">
                {file.lines} lines — {file.summary}
              </span>
              <span className="text-muted text-xs group-open:hidden">view</span>
              <span className="text-muted text-xs hidden group-open:inline">hide</span>
            </summary>
            <pre className="px-5 py-4 text-xs overflow-auto bg-ink text-paper leading-relaxed">
              <code>{file.contentPreview}</code>
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}

function ShipSection({ plan }: { plan: PlanSummary }) {
  const narrative = plan.shipNarrative ?? [];
  if (narrative.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">How I&apos;ll ship this</h2>
      <ol className="space-y-4">
        {narrative.map((s) => (
          <Step key={s.step} index={s.step} kind={s.kind} text={s.text} details={s.details ?? []} />
        ))}
      </ol>
    </section>
  );
}

function escapeInlineCode(input: string): string {
  const escaped = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 bg-rule rounded text-xs">$1</code>');
}

function Step({
  index,
  kind,
  text,
  details,
}: {
  index: number;
  kind: 'action' | 'approval';
  text: React.ReactNode;
  details?: string[];
}) {
  return (
    <li className="flex items-start gap-4">
      <span
        className={`shrink-0 w-6 h-6 rounded-full text-xs font-medium flex items-center justify-center mt-0.5 ${kind === 'approval' ? 'bg-warn text-white' : 'bg-rule text-muted'}`}
      >
        {index}
      </span>
      <div className="flex-1 pt-0.5 space-y-2">
        <div className="flex items-start gap-2">
          {kind === 'approval' ? (
            <span className="inline-block text-[10px] uppercase tracking-wider font-medium text-warn bg-warn/10 px-1.5 py-0.5 rounded shrink-0 mt-0.5">
              approval
            </span>
          ) : null}
          <span
            className="leading-relaxed"
            dangerouslySetInnerHTML={typeof text === 'string' ? { __html: escapeInlineCode(text) } : undefined}
          >
            {typeof text === 'string' ? undefined : text}
          </span>
        </div>
        {details && details.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-muted">
            {details.map((d, i) => (
              <li key={i} className="pl-4 relative">
                <span className="absolute left-0 text-muted">·</span>
                <span dangerouslySetInnerHTML={{ __html: escapeInlineCode(d) }} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function PlatformSection({ plan }: { plan: PlanSummary }) {
  const advisory = computePlatformAdvisory(plan);
  const sortedCandidates = [...plan.platform.candidates].sort((a, b) => b.score - a.score);

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
        Why this platform
      </h2>
      <div className="border border-rule rounded-lg p-5 bg-card space-y-4">
        <div className="flex items-start gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-accent mt-2 shrink-0" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold">{plan.platform.chosen}</span>
              <SourceBadge source={plan.platform.source} />
            </div>
            <p className="leading-relaxed mt-1">{plan.platform.reason}</p>
          </div>
        </div>

        {advisory ? (
          <div className="flex items-start gap-3 p-3 rounded-md bg-warn/10 border border-warn/30">
            <span className="text-warn text-sm font-semibold shrink-0">Advisory</span>
            <div className="flex-1 text-sm leading-relaxed">{advisory}</div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
          {sortedCandidates.map((c) => {
            const chosen = c.platform === plan.platform.chosen;
            return (
              <div
                key={c.platform}
                className={`border rounded-md p-3 relative ${chosen ? 'border-accent bg-accent/5 ring-1 ring-accent/30' : 'border-rule'}`}
              >
                {chosen ? (
                  <span className="absolute -top-2 left-3 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent text-white font-semibold">
                    chosen
                  </span>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold">{c.platform}</span>
                  <span className="text-xs text-muted font-mono tabular-nums">{c.score}</span>
                </div>
                <div className="text-xs text-muted mt-2 line-clamp-3">{c.reason}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  const styles: Record<string, string> = {
    override: 'bg-accent/10 text-accent',
    'existing-config': 'bg-warn/10 text-warn',
    scored: 'bg-success/10 text-success',
    refused: 'bg-danger/10 text-danger',
  };
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium ${styles[source] ?? styles['scored']!}`}>
      {source.replace('-', ' ')}
    </span>
  );
}

function computePlatformAdvisory(plan: PlanSummary): string | null {
  if (plan.deployability.verdict === 'not-cloud-deployable') return null;
  const candidates = plan.platform.candidates;
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const topScored = sorted[0];
  if (!topScored || topScored.platform === plan.platform.chosen) return null;
  const chosenScore = candidates.find((c) => c.platform === plan.platform.chosen)?.score ?? 0;
  if (topScored.score - chosenScore < 10) return null;
  const flag = `--platform=${topScored.platform}`;
  if (plan.platform.source === 'existing-config') {
    return `${topScored.platform} scored higher (${topScored.score} vs ${chosenScore}) on the heuristic. Convoy is honoring your existing config for ${plan.platform.chosen}. Rerun with ${flag} to switch platforms instead.`;
  }
  if (plan.platform.source === 'override') {
    return `${topScored.platform} scored higher (${topScored.score} vs ${chosenScore}). You chose ${plan.platform.chosen} explicitly — this is just a note, not a correction.`;
  }
  return null;
}

function RisksSection({ risks }: { risks: PlanSummary['risks'] }) {
  if (risks.length === 0) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Risks</h2>
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
    block: 'bg-danger/10 text-danger',
    warn: 'bg-warn/10 text-warn',
    info: 'bg-accent/10 text-accent',
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
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Evidence</h2>
      <ul className="font-mono text-xs text-muted space-y-1">
        {evidence.slice(0, 10).map((e, i) => (
          <li key={i}>· {e}</li>
        ))}
      </ul>
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
