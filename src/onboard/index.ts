import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPreferences, savePreferences, type DeployPreferences } from './preferences.js';

export interface OnboardAnswers {
  mode?: 'first' | 'update';
  approvers?: string[];
  canaryStrategy?: 'skip' | 'canary' | 'bluegreen';
  bakeWindowSeconds?: number;
  autoRollback?: boolean;
  platformMandate?: string | null;
  budgetTier?: 'hobby' | 'startup' | 'growth' | 'unconstrained';
  releaseCadence?: 'many-per-day' | 'daily' | 'weekly' | 'infrequent';
  releaseGate?: 'pr-merged' | 'pr-staging' | 'pr-staging-approver' | 'change-ticket';
  secretsManager?: string;
  compliance?: Array<'soc2' | 'hipaa' | 'pci' | 'gdpr'>;
  dataResidency?: string;
  errorTracking?: string | null;
  metrics?: string | null;
  slackChannel?: string;
  prComments?: boolean;
}

export async function runOnboard(repoPath: string, prefilled: Partial<OnboardAnswers> = {}): Promise<DeployPreferences> {
  const localPath = resolve(repoPath);
  const existing = loadPreferences(localPath);

  if (!process.stdin.isTTY) {
    // Non-interactive: merge prefilled answers into defaults and save
    return applyAnswers(localPath, existing, prefilled);
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (q: string, def?: string): Promise<string> => {
    const prompt = def ? `${q} [${def}]: ` : `${q}: `;
    const answer = await rl.question(prompt);
    return answer.trim() || def || '';
  };
  const askBool = async (q: string, def: boolean): Promise<boolean> => {
    const answer = await ask(`${q} (y/n)`, def ? 'y' : 'n');
    return answer.toLowerCase().startsWith('y');
  };
  const askChoice = async <T extends string>(q: string, choices: T[], def: T): Promise<T> => {
    const choiceStr = choices.map((c, i) => `  ${i + 1}. ${c}${c === def ? ' (default)' : ''}`).join('\n');
    output.write(`${q}\n${choiceStr}\n`);
    const answer = await ask('choice', String(choices.indexOf(def) + 1));
    const idx = parseInt(answer, 10) - 1;
    return (idx >= 0 && idx < choices.length) ? choices[idx]! : def;
  };

  output.write('\n■ Convoy Onboarding\n\n');
  output.write('I\'ll ask a few questions to understand how your team deploys. Takes ~3 minutes.\n\n');

  const answers: OnboardAnswers = { ...prefilled };

  // Section 1 — Deployment style
  output.write('── Section 1: Deployment style ──────────────────────\n\n');
  if (!prefilled.mode) {
    answers.mode = await askChoice<'first' | 'update'>('Is this a first deploy or an update to a running service?', ['first', 'update'], existing?.deployment.mode ?? 'first');
  }
  if (!prefilled.approvers) {
    const approversRaw = await ask('Who approves production deploys? (GitHub usernames, comma-separated; leave blank for auto-approve)', existing?.deployment.approvers.join(',') ?? '');
    answers.approvers = approversRaw ? approversRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  if (!prefilled.canaryStrategy) {
    answers.canaryStrategy = await askChoice<'skip' | 'canary' | 'bluegreen'>('Canary strategy?', ['skip', 'canary', 'bluegreen'], existing?.deployment.canary.strategy ?? 'canary');
  }
  if (!prefilled.bakeWindowSeconds && answers.canaryStrategy !== 'skip') {
    const bakeRaw = await ask('Bake window (seconds)', String(existing?.deployment.canary.bakeWindowSeconds ?? 120));
    answers.bakeWindowSeconds = parseInt(bakeRaw, 10) || 120;
  }
  if (!prefilled.autoRollback) {
    answers.autoRollback = await askBool('Auto-rollback on SLO breach?', existing?.deployment.canary.autoRollback ?? true);
  }

  // Section 2 — Platform
  output.write('\n── Section 2: Platform ──────────────────────────────\n\n');
  if (!prefilled.platformMandate) {
    const platforms = ['none', 'fly', 'vercel', 'railway', 'cloudrun', 'vps'] as const;
    const mandate = await askChoice('Platform mandate? ("none" lets Convoy score)', [...platforms], 'none');
    answers.platformMandate = mandate === 'none' ? null : mandate;
  }
  if (!prefilled.budgetTier) {
    answers.budgetTier = await askChoice<'hobby' | 'startup' | 'growth' | 'unconstrained'>('Budget ceiling per service/month?', ['hobby', 'startup', 'growth', 'unconstrained'], existing?.platform.budgetTier ?? 'startup');
  }

  // Section 3 — Release process
  output.write('\n── Section 3: Release process ───────────────────────\n\n');
  if (!prefilled.releaseCadence) {
    answers.releaseCadence = await askChoice<'many-per-day' | 'daily' | 'weekly' | 'infrequent'>('Release cadence?', ['many-per-day', 'daily', 'weekly', 'infrequent'], existing?.release.cadence ?? 'daily');
  }
  if (!prefilled.releaseGate) {
    answers.releaseGate = await askChoice<'pr-merged' | 'pr-staging' | 'pr-staging-approver' | 'change-ticket'>('What gates a production deploy?', ['pr-merged', 'pr-staging', 'pr-staging-approver', 'change-ticket'], existing?.release.gate ?? 'pr-merged');
  }

  // Section 4 — Secrets & compliance
  output.write('\n── Section 4: Secrets & compliance ──────────────────\n\n');
  if (!prefilled.secretsManager) {
    answers.secretsManager = await askChoice('Secrets management?', ['platform-native', 'doppler', 'infisical', 'vault', 'aws-sm', 'env-file', 'unknown'], (existing?.secrets.manager as string) ?? 'platform-native');
  }
  if (!prefilled.compliance) {
    const complianceRaw = await ask('Compliance requirements? (comma-separated: soc2, hipaa, pci, gdpr; or leave blank)', existing?.secrets.compliance.join(',') ?? '');
    const valid = ['soc2', 'hipaa', 'pci', 'gdpr'] as const;
    answers.compliance = complianceRaw
      ? complianceRaw.split(',').map(s => s.trim()).filter(s => valid.includes(s as 'soc2' | 'hipaa' | 'pci' | 'gdpr')) as Array<'soc2' | 'hipaa' | 'pci' | 'gdpr'>
      : [];
  }
  if (!prefilled.dataResidency) {
    answers.dataResidency = await ask('Data residency requirement? (any / us / eu / apac / specific region)', existing?.secrets.dataResidency ?? 'any');
  }

  // Section 5 — Observability
  output.write('\n── Section 5: Observability & notifications ─────────\n\n');
  if (!prefilled.errorTracking) {
    const et = await ask('Error tracking? (sentry / datadog / newrelic / none)', existing?.observability.errorTracking ?? 'none');
    answers.errorTracking = et === 'none' ? null : et;
  }
  if (!prefilled.prComments) {
    answers.prComments = await askBool('Comment on PRs Convoy opens with deploy status?', existing?.observability.notifications.prComments ?? false);
  }

  rl.close();

  const prefs = applyAnswers(localPath, existing, answers);
  savePreferences(localPath, prefs);

  output.write('\n✓ Preferences saved to .convoy/preferences.json\n');
  output.write(`\nConvoy will now:\n`);
  if (prefs.deployment.approvers.length > 0) {
    output.write(`  · Require approval from ${prefs.deployment.approvers.join(', ')} before production deploys\n`);
  } else {
    output.write(`  · Auto-approve gates when rehearsal is clean\n`);
  }
  if (prefs.platform.mandate) {
    output.write(`  · Always deploy to ${prefs.platform.mandate} (team mandate)\n`);
  }
  if (prefs.secrets.compliance.length > 0) {
    output.write(`  · Enforce ${prefs.secrets.compliance.join(', ')} compliance (audit logging, forced manual approval)\n`);
  }
  output.write(`\nRe-run 'convoy onboard ${repoPath}' to update preferences.\n\n`);

  return prefs;
}

function applyAnswers(localPath: string, existing: DeployPreferences | null, answers: Partial<OnboardAnswers>): DeployPreferences {
  const now = new Date().toISOString();
  const base = existing ?? {
    version: 1 as const,
    createdAt: now,
    deployment: { mode: 'first' as const, approvers: [], canary: { strategy: 'canary' as const, trafficPercent: 5, bakeWindowSeconds: 120, autoRollback: true }, stagingApp: null },
    platform: { mandate: null, budgetTier: 'startup' as const },
    release: { cadence: 'daily' as const, gate: 'pr-merged' as const, freezeDescription: null },
    secrets: { manager: 'platform-native' as const, compliance: [], dataResidency: 'any' },
    observability: { errorTracking: null, metrics: null, notifications: { slack: null, prComments: false } },
    _adaptive: { lastUpdated: now, services: {} },
  };

  return {
    ...base,
    version: 1 as const,
    updatedAt: now,
    deployment: {
      ...base.deployment,
      ...(answers.mode !== undefined && { mode: answers.mode }),
      ...(answers.approvers !== undefined && { approvers: answers.approvers }),
      canary: {
        ...base.deployment.canary,
        ...(answers.canaryStrategy !== undefined && { strategy: answers.canaryStrategy }),
        ...(answers.bakeWindowSeconds !== undefined && { bakeWindowSeconds: answers.bakeWindowSeconds }),
        ...(answers.autoRollback !== undefined && { autoRollback: answers.autoRollback }),
      },
    },
    platform: {
      ...base.platform,
      ...(answers.platformMandate !== undefined && { mandate: answers.platformMandate }),
      ...(answers.budgetTier !== undefined && { budgetTier: answers.budgetTier }),
    },
    release: {
      ...base.release,
      ...(answers.releaseCadence !== undefined && { cadence: answers.releaseCadence }),
      ...(answers.releaseGate !== undefined && { gate: answers.releaseGate }),
    },
    secrets: {
      ...base.secrets,
      ...(answers.secretsManager !== undefined && { manager: answers.secretsManager as DeployPreferences['secrets']['manager'] }),
      ...(answers.compliance !== undefined && { compliance: answers.compliance }),
      ...(answers.dataResidency !== undefined && { dataResidency: answers.dataResidency }),
    },
    observability: {
      ...base.observability,
      ...(answers.errorTracking !== undefined && { errorTracking: answers.errorTracking }),
      ...(answers.metrics !== undefined && { metrics: answers.metrics }),
      notifications: {
        ...base.observability.notifications,
        ...(answers.prComments !== undefined && { prComments: answers.prComments }),
      },
    },
  };
}
