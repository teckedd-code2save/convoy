import type { PlanPlatformDecision, PlanPlatformCandidate, PlanPlatformAdjustment } from '../core/plan.js';
import type { Platform } from '../core/types.js';
import type { ScanResult, ServiceNode } from './scanner.js';

const SUPPORTED: Platform[] = ['fly', 'railway', 'vercel', 'cloudrun', 'vps'];

/**
 * Extra adjustments fed in from outside the scan — today, the orient pass
 * (issue #20): existing fly.toml / vercel.json / CI deploy steps / VPS host
 * in team preferences. They flow through the same adjustments mechanism the
 * deterministic scorer uses, so the deltas show up in the score table (CLI
 * render, plan JSON, web candidate cards) instead of being invisible
 * if-chains.
 */
export type PlatformAdjustments = Partial<Record<Platform, PlanPlatformAdjustment[]>>;

export function pickPlatform(
  scan: ScanResult,
  override?: Platform,
  extraAdjustments?: PlatformAdjustments,
  mandate?: Platform,
): PlanPlatformDecision {
  if (override !== undefined) {
    return {
      chosen: override,
      reason: `respecting explicit --platform=${override} override`,
      source: 'override',
      candidates: scoreAll(scan, extraAdjustments),
    };
  }
  if (mandate !== undefined) {
    return {
      chosen: mandate,
      reason: `honoring the team platform mandate (${mandate}) declared at onboard — .convoy/preferences.json`,
      source: 'mandate',
      candidates: scoreAll(scan, extraAdjustments),
    };
  }
  if (scan.existingPlatform) {
    return {
      chosen: scan.existingPlatform,
      reason: `continuing existing ${scan.existingPlatform} setup detected in the repo`,
      source: 'existing-config',
      candidates: scoreAll(scan, extraAdjustments),
    };
  }
  const candidates = scoreAll(scan, extraAdjustments);
  const top = candidates[0]!;
  return {
    chosen: top.platform,
    reason: top.reason,
    source: 'scored',
    candidates,
  };
}

export function pickPlatformForLane(
  node: ServiceNode,
  override?: Platform,
  extraAdjustments?: PlatformAdjustments,
  mandate?: Platform,
): PlanPlatformDecision {
  return pickPlatform(node.scan, override, extraAdjustments, mandate);
}

function scoreAll(scan: ScanResult, extra?: PlatformAdjustments): PlanPlatformCandidate[] {
  const out = SUPPORTED.map((p) => scoreOne(p, scan, extra?.[p]));
  out.sort((a, b) => b.score - a.score);
  return out;
}

function scoreOne(
  platform: Platform,
  scan: ScanResult,
  extra?: PlanPlatformAdjustment[],
): PlanPlatformCandidate {
  let score = 50;
  const adjustments: PlanPlatformAdjustment[] = [];

  const adj = (delta: number, label: string) => {
    score += delta;
    adjustments.push({ delta, label });
  };

  const hasWorker = scan.topology === 'web+worker' || scan.topology === 'worker';
  const isStatic = scan.topology === 'static';
  const needsContainer = scan.hasDockerfile || scan.language === 'rust' || scan.language === 'go';
  const hasPostgres = scan.dataLayer.some((d) => d.includes('postgres'));

  switch (platform) {
    case 'fly':
      if (hasWorker)      adj(+25, 'background worker topology');
      if (needsContainer) adj(+15, 'container-native (Dockerfile / Go / Rust)');
      if (hasPostgres)    adj(+5,  'attaches external Postgres cleanly');
      if (isStatic)       adj(-20, 'overkill for a static site');
      break;

    case 'railway':
      if (hasPostgres) adj(+20, 'managed Postgres in one click');
      if (hasWorker)   adj(+10, 'multi-service monorepo support');
      if (isStatic)    adj(-10, 'not optimised for static');
      break;

    case 'vercel':
      if (scan.framework === 'next.js' && !hasWorker) adj(+35, 'best-in-class for Next.js');
      if (isStatic)                                    adj(+25, 'static sites are free and instant here');
      if (hasWorker)                                   adj(-25, 'background workers not supported');
      if (needsContainer && scan.framework !== 'next.js') adj(-15, 'container-first apps fit awkwardly');
      break;

    case 'cloudrun':
      adj(-5, 'GCP setup overhead');
      if (needsContainer) adj(+15, 'container-native');
      if (hasPostgres)    adj(+5,  'pairs with Cloud SQL');
      if (scan.framework === 'next.js' && !hasWorker) adj(-5, 'Next.js fits Vercel better');
      if (isStatic) adj(-20, 'static sites belong on a CDN');
      break;

    case 'vps': {
      if (process.env['CONVOY_VPS_HOST']) {
        adj(+30, 'CONVOY_VPS_HOST set — operator opted in');
      } else {
        adj(-10, 'opt-in only (set CONVOY_VPS_HOST or --platform=vps)');
      }

      if (scan.hasDockerfile) adj(+10, 'repo ships a Dockerfile');

      const hasDockerCompose = scan.topLevelFiles.some(
        (f) => f === 'docker-compose.yml' || f === 'docker-compose.yaml' ||
               f === 'compose.yml' || f === 'compose.yaml',
      );
      if (hasDockerCompose) adj(+15, 'docker-compose.yml at root');

      if (scan.topLevelFiles.includes('Caddyfile')) adj(+15, 'Caddyfile at root (Caddy reverse proxy)');

      if (scan.topLevelFiles.includes('deploy.yml') || scan.topLevelFiles.includes('deploy.yaml')) {
        adj(+20, 'deploy.yml — scaffolded for VPS deployment');
      }

      if (scan.subServices.length >= 3) {
        adj(+10, `${scan.subServices.length}-service repo — VPS compose avoids per-service PaaS pricing`);
      }

      if (isStatic)                                     adj(-30, 'static sites belong on a CDN');
      if (scan.framework === 'next.js' && !hasWorker)   adj(-10, 'Next.js fits Vercel better unless you need a box');
      break;
    }
  }

  for (const a of extra ?? []) {
    adj(a.delta, a.label);
  }

  score = Math.max(0, Math.min(100, score));
  const reasons = adjustments
    .filter((a) => a.delta > 0)
    .map((a) => a.label);

  return {
    platform,
    score,
    reason: reasons.join(', ') || 'no strong signal',
    adjustments,
  };
}
