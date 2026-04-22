import { listRuns, runsLocation } from '@/lib/runs';

export const dynamic = 'force-dynamic';

export default function RunsPage() {
  const runs = listRuns();

  return (
    <section className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Runs</h1>
        <p className="text-muted">
          Pipelines executed from{' '}
          <code className="px-1.5 py-0.5 rounded bg-rule text-sm">convoy apply &lt;plan-id&gt;</code>{' '}
          or{' '}
          <code className="px-1.5 py-0.5 rounded bg-rule text-sm">convoy ship &lt;url&gt;</code>.
          Click a run to watch it live or grant approvals.
        </p>
      </header>

      {runs.length === 0 ? (
        <div className="border border-dashed border-rule rounded-lg p-10 text-center space-y-2">
          <p className="text-muted">No runs yet.</p>
          <p className="text-sm text-muted">
            Try:{' '}
            <code className="px-1.5 py-0.5 rounded bg-rule">
              npm run convoy -- apply &lt;plan-id&gt; --no-auto-approve
            </code>
          </p>
          <p className="text-xs text-muted pt-2">State DB: {runsLocation()}</p>
        </div>
      ) : (
        <ul className="divide-y divide-rule border border-rule rounded-lg overflow-hidden bg-card">
          {runs.map((run) => (
            <li key={run.id}>
              <a
                href={`/runs/${run.id}`}
                className="flex items-center gap-6 px-5 py-4 hover:bg-rule/40 transition-colors"
              >
                <span className="font-mono text-xs text-muted shrink-0 w-20">
                  {run.id.slice(0, 8)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{run.repoUrl}</span>
                    {run.platform ? <Tag>{run.platform}</Tag> : null}
                  </div>
                  {run.liveUrl ? (
                    <p className="text-sm text-muted truncate mt-0.5">{run.liveUrl}</p>
                  ) : null}
                </div>
                <div className="text-sm shrink-0 text-right">
                  <StatusBadge status={run.status} />
                  <div className="text-xs text-muted mt-1">{formatTime(run.startedAt)}</div>
                </div>
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

function StatusBadge({ status }: { status: string }) {
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
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
      {c.label}
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const delta = Date.now() - d.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 10);
}
