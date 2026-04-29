import type { PlanPlatformDecision, PlanPlatformCandidate } from '../core/plan.js';
import type { Platform } from '../core/types.js';
import type { ScanResult, ServiceNode } from './scanner.js';

const SUPPORTED: Platform[] = ['fly', 'railway', 'vercel', 'cloudrun'];

export function pickPlatform(
  scan: ScanResult,
  override?: Platform,
): PlanPlatformDecision {
  if (override !== undefined) {
    return {
      chosen: override,
      reason: `respecting explicit --platform=${override} override`,
      source: 'override',
      candidates: scoreAll(scan),
    };
  }
  if (scan.existingPlatform) {
    return {
      chosen: scan.existingPlatform,
      reason: `continuing existing ${scan.existingPlatform} setup detected in the repo`,
      source: 'existing-config',
      candidates: scoreAll(scan),
    };
  }
  const candidates = scoreAll(scan);
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
): PlanPlatformDecision {
  return pickPlatform(node.scan, override);
}

function scoreAll(scan: ScanResult): PlanPlatformCandidate[] {
  const out = SUPPORTED.map((p) => scoreOne(p, scan));
  out.sort((a, b) => b.score - a.score);
  return out;
}

function scoreOne(platform: Platform, scan: ScanResult): PlanPlatformCandidate {
  let score = 50;
  const reasons: string[] = [];

  const hasWorker = scan.topology === 'web+worker' || scan.topology === 'worker';
  const isStatic = scan.topology === 'static';
  const needsContainer = scan.hasDockerfile || scan.language === 'rust' || scan.language === 'go';
  const hasPostgres = scan.dataLayer.some((d) => d.includes('postgres'));

  switch (platform) {
    case 'fly':
      if (hasWorker) {
        score += 25;
        reasons.push('background worker friendly');
      }
      if (needsContainer) {
        score += 15;
        reasons.push('container-native');
      }
      if (hasPostgres) {
        score += 5;
        reasons.push('attaches external Postgres cleanly');
      }
      if (isStatic) {
        score -= 20;
        reasons.push('overkill for a static site');
      }
      break;

    case 'railway':
      if (hasPostgres) {
        score += 20;
        reasons.push('managed Postgres in one click');
      }
      if (hasWorker) {
        score += 10;
        reasons.push('multi-service monorepo support');
      }
      if (isStatic) score -= 10;
      break;

    case 'vercel':
      if (scan.framework === 'next.js' && !hasWorker) {
        score += 35;
        reasons.push('best-in-class for Next.js');
      }
      if (isStatic) {
        score += 25;
        reasons.push('static sites are free and fast here');
      }
      if (hasWorker) {
        score -= 25;
        reasons.push('background workers not supported');
      }
      if (needsContainer && scan.framework !== 'next.js') {
        score -= 15;
        reasons.push('container-first apps fit awkwardly');
      }
      break;

    case 'cloudrun':
      if (needsContainer) {
        score += 15;
        reasons.push('container-native');
      }
      if (hasPostgres) {
        score += 5;
        reasons.push('pairs with Cloud SQL');
      }
      if (scan.framework === 'next.js' && !hasWorker) score -= 5;
      if (isStatic) score -= 20;
      // GCP onboarding overhead
      score -= 5;
      reasons.push('extra GCP setup cost');
      break;
  }

  score = Math.max(0, Math.min(100, score));
  return {
    platform,
    score,
    reason: reasons.join(', ') || 'no strong signal',
  };
}
