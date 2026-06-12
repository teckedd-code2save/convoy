import type { Platform } from '../core/types.js';
import type { DeployPreferences } from '../onboard/preferences.js';
import type { PlatformAdjustments } from '../planner/picker.js';
import type { OrientResult } from './index.js';

/**
 * One platform-shaped artifact the orient pass found in the repo (or in
 * team preferences). Signals do double duty:
 *
 *  - With a platform mandate on file, any signal pointing at a DIFFERENT
 *    platform is drift — surfaced loudly, never silently re-scored.
 *  - Without a mandate, every signal feeds the picker as a score
 *    adjustment so it shows up in the candidate table (CLI, plan JSON, web).
 */
export interface OrientSignal {
  platform: Platform;
  /** Short artifact name for drift messages, e.g. "vercel.json". */
  evidence: string;
  delta: number;
  /** Score-table label, e.g. "existing platform (fly.toml)". */
  label: string;
}

export interface DriftFinding {
  detectedPlatform: Platform;
  evidence: string;
}

const PLATFORM_CONFIG_FILES: Array<{ file: string; platform: Platform }> = [
  { file: 'fly.toml', platform: 'fly' },
  { file: 'vercel.json', platform: 'vercel' },
  { file: 'railway.json', platform: 'railway' },
  { file: 'railway.toml', platform: 'railway' },
];

const CI_DEPLOY_PATTERNS: Array<{ match: RegExp; platform: Platform; what: string }> = [
  { match: /fly\s+deploy|flyctl\s+deploy/, platform: 'fly', what: 'fly deploy' },
  { match: /vercel\s+(--prod|deploy)/, platform: 'vercel', what: 'vercel --prod' },
  { match: /railway\s+up/, platform: 'railway', what: 'railway up' },
  { match: /gcloud\s+run\s+deploy/, platform: 'cloudrun', what: 'gcloud run deploy' },
];

/**
 * Collect platform-pointing signals from an orient result + preferences.
 * Pure over its inputs — no filesystem access — so it's unit-testable.
 */
export function collectPlatformSignals(
  orient: OrientResult,
  prefs: DeployPreferences | null,
): OrientSignal[] {
  const signals: OrientSignal[] = [];
  const seen = new Set<string>();
  const push = (s: OrientSignal) => {
    const key = `${s.platform}:${s.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(s);
  };

  const topFiles = orient.graph.topLevelFiles;
  const topDirs = orient.graph.topLevelDirs;

  for (const { file, platform } of PLATFORM_CONFIG_FILES) {
    if (topFiles.includes(file)) {
      push({ platform, evidence: file, delta: 40, label: `existing platform (${file})` });
    }
  }
  if (topDirs.includes('.vercel')) {
    push({ platform: 'vercel', evidence: '.vercel/', delta: 40, label: 'existing platform (.vercel project link)' });
  }

  // Per-service platform configs detected by the scanner (covers configs
  // living inside workspace members, not just repo root).
  for (const node of orient.graph.nodes) {
    if (node.existingPlatform) {
      push({
        platform: node.existingPlatform,
        evidence: `${node.path === '.' ? '' : `${node.path}/`}${node.existingPlatform} config`,
        delta: 40,
        label: `existing platform (${node.name})`,
      });
    }
  }

  // CI workflows with deploy steps referencing a platform CLI.
  for (const wf of orient.ciWorkflows) {
    for (const step of wf.deploySteps) {
      for (const { match, platform, what } of CI_DEPLOY_PATTERNS) {
        if (match.test(step)) {
          push({
            platform,
            evidence: `${wf.file} (${what})`,
            delta: 30,
            label: `CI already configured (${what})`,
          });
        }
      }
    }
  }

  const vpsHost = prefs?.deployment.vpsHost;
  if (vpsHost && vpsHost.trim().length > 0) {
    push({
      platform: 'vps',
      evidence: `preferences vpsHost=${vpsHost}`,
      delta: 50,
      label: 'VPS host on file in team preferences',
    });
  }

  return signals;
}

/**
 * Compare collected signals against the team's platform mandate. Any signal
 * pointing somewhere else is drift. The mandate still wins — callers warn
 * (or hard-pause under --strict-drift), never silently re-score.
 */
export function detectDrift(mandate: string, signals: OrientSignal[]): DriftFinding[] {
  // One finding per stray platform — the first (highest-priority) artifact
  // is evidence enough; listing every echo of the same platform is noise.
  const byPlatform = new Map<Platform, DriftFinding>();
  for (const signal of signals) {
    if (signal.platform === mandate) continue;
    if (byPlatform.has(signal.platform)) continue;
    byPlatform.set(signal.platform, { detectedPlatform: signal.platform, evidence: signal.evidence });
  }
  return [...byPlatform.values()];
}

/** Fold signals into the picker's extra-adjustments shape. */
export function signalsToAdjustments(signals: OrientSignal[]): PlatformAdjustments {
  const out: PlatformAdjustments = {};
  for (const signal of signals) {
    (out[signal.platform] ??= []).push({ delta: signal.delta, label: signal.label });
  }
  return out;
}
