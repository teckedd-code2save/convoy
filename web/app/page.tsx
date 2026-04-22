import { listPlans, plansLocation } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export default function Home() {
  const plans = listPlans();

  return (
    <section className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Plans</h1>
        <p className="text-[color:var(--color-muted)]">
          Terraform-style deployment plans produced by{' '}
          <code className="px-1.5 py-0.5 rounded bg-[color:var(--color-rule)] text-sm">convoy plan &lt;path&gt; --save</code>.
          Reviewed here. Applied with{' '}
          <code className="px-1.5 py-0.5 rounded bg-[color:var(--color-rule)] text-sm">convoy apply &lt;id&gt;</code>.
        </p>
      </header>

      {plans.length === 0 ? (
        <div className="border border-dashed border-[color:var(--color-rule)] rounded-lg p-10 text-center space-y-2">
          <p className="text-[color:var(--color-muted)]">No plans yet.</p>
          <p className="text-sm text-[color:var(--color-muted)]">
            From the repo root:{' '}
            <code className="px-1.5 py-0.5 rounded bg-[color:var(--color-rule)]">
              npm run convoy -- plan &lt;path&gt; --save
            </code>
          </p>
          <p className="text-xs text-[color:var(--color-muted)] pt-2">Looking in: {plansLocation()}</p>
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--color-rule)] border border-[color:var(--color-rule)] rounded-lg overflow-hidden bg-white">
          {plans.map((plan) => (
            <li key={plan.id}>
              <a
                href={`/plans/${plan.id}`}
                className="flex items-center gap-6 px-5 py-4 hover:bg-[color:var(--color-rule)]/40 transition-colors"
              >
                <span className="font-mono text-xs text-[color:var(--color-muted)] shrink-0 w-20">
                  {plan.id.slice(0, 8)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{plan.target.name}</span>
                    <Tag>{plan.target.ecosystem}</Tag>
                    {plan.target.framework ? <Tag>{plan.target.framework}</Tag> : null}
                  </div>
                  {plan.target.readmeTitle ? (
                    <p className="text-sm text-[color:var(--color-muted)] truncate mt-0.5">
                      &quot;{plan.target.readmeTitle}&quot;
                    </p>
                  ) : null}
                </div>
                <div className="text-sm shrink-0 text-right">
                  <PlatformBadge plan={plan} />
                  <div className="text-xs text-[color:var(--color-muted)] mt-1">{formatTime(plan.createdAt)}</div>
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
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[color:var(--color-rule)] text-[color:var(--color-muted)] font-medium">
      {children}
    </span>
  );
}

function PlatformBadge({ plan }: { plan: ReturnType<typeof listPlans>[number] }) {
  if (plan.deployability.verdict === 'not-cloud-deployable') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--color-danger)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-danger)]" />
        refused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-success)]" />
      {plan.platform.chosen}
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const delta = now - d.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 10);
}
