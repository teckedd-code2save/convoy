import { listPlans, type PlanSummary } from './plans';
import { listRunsForPlan, type RunRow } from './runs';

export interface Project {
  /** Stable slug derived from target name. */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** Local filesystem path of the repo (from the most recent plan). */
  localPath: string;
  /** Remote URL if known. */
  repoUrl: string | null;
  /** Platform chosen across the most recent plan. */
  platform: string | null;
  /** All saved plans for this project, newest first. */
  plans: PlanSummary[];
  /** Latest run across all plans, or null if never deployed. */
  latestRun: RunRow | null;
  /** The live URL from the latest successful run, or null. */
  liveUrl: string | null;
}

/** Derive the project list from saved plans — no extra DB table required. */
export function listProjects(): Project[] {
  const plans = listPlans();
  // Group by target.name. Two plans for the same app at different local paths
  // are treated as the same project (name is the unique key — intentionally
  // loose so moving a repo doesn't orphan the history).
  const byName = new Map<string, PlanSummary[]>();
  for (const plan of plans) {
    const name = plan.target.name;
    const existing = byName.get(name);
    if (existing) existing.push(plan);
    else byName.set(name, [plan]);
  }

  const projects: Project[] = [];
  for (const [name, planGroup] of byName.entries()) {
    // Sort newest first (listPlans already returns newest first, but be safe)
    const sorted = [...planGroup].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    );
    const newest = sorted[0]!;

    // Gather the latest run across all plans in this group
    let latestRun: RunRow | null = null;
    let liveUrl: string | null = null;
    for (const plan of sorted) {
      const runs = listRunsForPlan(plan.id);
      if (runs.length > 0) {
        const candidate = runs[0]!;
        if (!latestRun || candidate.startedAt > latestRun.startedAt) {
          latestRun = candidate;
        }
        const successRun = runs.find((r) => r.status === 'succeeded' && r.liveUrl);
        if (successRun?.liveUrl && !liveUrl) liveUrl = successRun.liveUrl;
      }
    }

    projects.push({
      slug: slugify(name),
      name,
      localPath: newest.target.localPath,
      repoUrl: newest.target.repoUrl ?? null,
      platform: newest.platform?.chosen ?? null,
      plans: sorted,
      latestRun,
      liveUrl,
    });
  }

  // Sort by most recently active (latest run, then latest plan)
  return projects.sort((a, b) => {
    const aTime = a.latestRun?.startedAt ?? a.plans[0]?.createdAt ?? '';
    const bTime = b.latestRun?.startedAt ?? b.plans[0]?.createdAt ?? '';
    return bTime.localeCompare(aTime);
  });
}

export function getProject(slug: string): Project | null {
  return listProjects().find((p) => p.slug === slug) ?? null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'unnamed';
}
