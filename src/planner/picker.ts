import type { PlanPlatformDecision, PlanPlatformCandidate } from '../core/plan.js';
import type { Platform } from '../core/types.js';
import type { ScanResult, ServiceNode } from './scanner.js';

const SUPPORTED: Platform[] = ['fly', 'railway', 'vercel', 'cloudrun', 'vps'];

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

    case 'vps': {
      // VPS is the "I own the box" path. The baseline penalty keeps it from
      // autopicking over managed PaaSes unless signals clearly point here.
      if (process.env['CONVOY_VPS_HOST']) {
        score += 30;
        reasons.push('CONVOY_VPS_HOST set (operator opted in)');
      } else {
        score -= 10;
        reasons.push('opt-in only (set CONVOY_VPS_HOST or pass --platform=vps)');
      }

      if (scan.hasDockerfile) {
        score += 10;
        reasons.push('repo already ships a Dockerfile');
      }

      // docker-compose.yml at root — operator has container orchestration
      // already configured. Local-dev-only compose would live under a
      // subdirectory; root-level compose targets production deployment.
      const hasDockerCompose = scan.topLevelFiles.some(
        (f) => f === 'docker-compose.yml' || f === 'docker-compose.yaml' ||
               f === 'compose.yml' || f === 'compose.yaml',
      );
      if (hasDockerCompose) {
        score += 15;
        reasons.push('docker-compose.yml present — compose apps run naturally on VPS');
      }

      // Caddyfile at repo root = operator already configured Caddy as the
      // reverse proxy. Almost always means they own the box it runs on.
      if (scan.topLevelFiles.includes('Caddyfile')) {
        score += 15;
        reasons.push('Caddyfile present — repo already configures Caddy reverse proxy');
      }

      // deploy.yml at root is the ship-to-vps convention: app was explicitly
      // scaffolded for VPS deployment. Strongest non-env-var signal.
      if (
        scan.topLevelFiles.includes('deploy.yml') ||
        scan.topLevelFiles.includes('deploy.yaml')
      ) {
        score += 20;
        reasons.push('deploy.yml present — repo scaffolded for VPS deployment');
      }

      // Multi-service monorepos with 3+ services are expensive on managed
      // PaaSes (one deployment unit per service); a single VPS with compose
      // is often the practical choice.
      if (scan.subServices.length >= 3) {
        score += 10;
        reasons.push(`${scan.subServices.length}-service repo — VPS compose avoids per-service PaaS pricing`);
      }

      if (isStatic) {
        score -= 30;
        reasons.push('static sites belong on a CDN, not a VPS');
      }
      if (scan.framework === 'next.js' && !hasWorker) {
        score -= 10;
        reasons.push('Next.js fits Vercel better unless you need a box');
      }
      break;
    }
  }

  score = Math.max(0, Math.min(100, score));
  return {
    platform,
    score,
    reason: reasons.join(', ') || 'no strong signal',
  };
}
