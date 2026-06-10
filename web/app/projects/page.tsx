import { listProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  const projects = listProjects();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <span className="text-sm text-muted">{projects.length} registered</span>
      </div>

      {projects.length === 0 ? (
        <div className="border border-dashed border-rule rounded-lg p-10 text-center space-y-3">
          <p className="text-muted">No projects yet.</p>
          <p className="text-sm text-muted">
            Run{' '}
            <code className="px-1.5 py-0.5 rounded bg-rule">
              npm run convoy -- plan &lt;path&gt; --save
            </code>{' '}
            to register a project.
          </p>
        </div>
      ) : (
        <ul className="border border-rule rounded-lg overflow-hidden bg-card divide-y divide-rule">
          {projects.map((project) => (
            <li key={project.slug}>
              <a
                href={`/projects/${project.slug}`}
                className="flex items-center gap-4 px-5 py-4 hover:bg-rule/40 transition-colors"
              >
                {/* Status indicator */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${runStatusColor(project.latestRun?.status ?? null)}`}
                />

                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{project.name}</span>
                    {project.platform ? (
                      <Tag>{project.platform}</Tag>
                    ) : null}
                    {project.plans.length > 1 ? (
                      <Tag>{project.plans.length} plans</Tag>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted mt-0.5 truncate">
                    {project.localPath}
                    {project.repoUrl ? (
                      <> · <span>{shortRepo(project.repoUrl)}</span></>
                    ) : null}
                  </div>
                </div>

                {/* Live URL pill */}
                {project.liveUrl ? (
                  <a
                    href={project.liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-accent hover:underline shrink-0"
                  >
                    live ↗
                  </a>
                ) : null}

                {/* Run status */}
                <div className="text-right shrink-0">
                  {project.latestRun ? (
                    <>
                      <div className="text-xs font-medium">{formatStatus(project.latestRun.status)}</div>
                      <div className="text-[10px] text-muted">{relativeTime(project.latestRun.startedAt)}</div>
                    </>
                  ) : (
                    <span className="text-xs text-muted">never deployed</span>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rule text-muted font-medium">
      {children}
    </span>
  );
}

function runStatusColor(status: string | null): string {
  const map: Record<string, string> = {
    succeeded: 'bg-success',
    running: 'bg-accent animate-pulse',
    awaiting_approval: 'bg-warn animate-pulse',
    awaiting_fix: 'bg-warn animate-pulse',
    failed: 'bg-danger',
    rolled_back: 'bg-warn',
    pending: 'bg-muted',
  };
  return map[status ?? ''] ?? 'bg-rule';
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
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
