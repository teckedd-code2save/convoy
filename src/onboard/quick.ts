import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';

import pc from 'picocolors';

import { pickPlatform } from '../planner/picker.js';
import { scanRepository } from '../planner/scanner.js';
import {
  loadPreferences,
  mergePreferences,
  savePreferences,
  DEFAULT_PREFERENCES,
  type DeployPreferences,
} from './preferences.js';

const PLATFORM_CHOICES = ['fly', 'vercel', 'railway', 'cloudrun', 'vps', 'not yet'] as const;
const COMPLIANCE_KINDS = ['soc2', 'hipaa', 'pci', 'gdpr'] as const;
type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];

/**
 * The first-contact gate (issue #23). When `convoy plan` / `convoy ship`
 * hits a repo with no `.convoy/preferences.json`, this 5-question interview
 * BLOCKS before anything is scored — Convoy asks before it assumes.
 *
 * Doctrine:
 *   first contact:   onboard  →  plan        (this gate)
 *   every run after: orient   →  plan        (drift detection, src/orient/drift.ts)
 *   greenfield:      onboard  →  plan, fast  (Convoy leads — its pick IS the pattern)
 *
 * Greenfield ("not yet" + "first deploy"): Convoy scores from repo signals
 * decisively, writes its pick into platform.mandate, and announces it in
 * first person. The pick becomes the team default until `convoy onboard`
 * changes it.
 *
 * Callers must check stdin.isTTY before invoking — non-interactive runs
 * warn and proceed with defaults instead of blocking.
 */
export async function runQuickOnboard(repoPath: string): Promise<DeployPreferences> {
  const localPath = resolve(repoPath);
  const existing = loadPreferences(localPath);

  const rl = readline.createInterface({ input, output });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();
  const askChoice = async <T extends string>(q: string, choices: readonly T[], def: T): Promise<T> => {
    const list = choices.map((c, i) => `  ${i + 1}. ${c}${c === def ? ' (default)' : ''}`).join('\n');
    output.write(`${q}\n${list}\n`);
    const answer = await ask(`${pc.dim('choice')} [${choices.indexOf(def) + 1}]: `);
    if (!answer) return def;
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx]!;
    const byName = choices.find((c) => c.toLowerCase() === answer.toLowerCase());
    return byName ?? def;
  };

  output.write(`\n${pc.bold('■ First contact')} ${pc.dim('— I have no team preferences on file for this repo.')}\n`);
  output.write(`${pc.dim("Five quick questions before I score anything. Full interview later: ")}${pc.bold('convoy onboard')}\n\n`);

  let mandate: string | null = null;
  let vpsHost: string | null = null;
  let greenfieldPick: { platform: string; reason: string } | null = null;

  try {
    // Q1 — existing platform → hard mandate.
    const q1 = await askChoice(
      '1/5 Do you already deploy this service somewhere?',
      PLATFORM_CHOICES,
      'not yet',
    );
    if (q1 !== 'not yet') {
      mandate = q1;
      if (q1 === 'vps') {
        const host = await ask(`    ${pc.dim('VPS host (user@host or IP, Enter to skip):')} `);
        vpsHost = host.length > 0 ? host : null;
      }
    }

    // Q2 — first deploy vs update.
    const q2 = await askChoice<'first' | 'update'>(
      '\n2/5 Is this a first deploy or an update to a live service?',
      ['first', 'update'],
      'first',
    );

    // Q3 — compliance / sensitive data → compliance requirements on file,
    // auto-approve disabled (approver-gated releases).
    const q3raw = (await ask(
      '\n3/5 Does this service require SOC2/HIPAA/PCI/GDPR compliance or handle payment/health data? (y/n) [n]: ',
    )).toLowerCase();
    const q3yes = q3raw.startsWith('y');
    let compliance: ComplianceKind[] = [];
    if (q3yes) {
      const which = (await ask(
        `    ${pc.dim('Which? (soc2, hipaa, pci, gdpr — comma-separated, Enter for all):')} `,
      )).toLowerCase();
      const named = which
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is ComplianceKind => (COMPLIANCE_KINDS as readonly string[]).includes(s));
      compliance = named.length > 0 ? named : [...COMPLIANCE_KINDS];
    }

    // Q4 — approvers.
    const q4 = await ask(
      '\n4/5 Who needs to approve a production deploy? (GitHub handles, comma-separated; Enter to skip): ',
    );
    const approvers = q4
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter((s) => s.length > 0);

    // Q5 — secrets already on the platform → recorded as already-set
    // declarations so preflight stops asking. No platform queries; the
    // operator is vouching.
    const q5 = await ask(
      '\n5/5 Any secrets already set on the platform? (var names, comma-separated; Enter to skip): ',
    );
    const alreadySet = q5
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    if (alreadySet.length > 0) {
      recordAlreadySet(localPath, alreadySet);
    }

    // Greenfield: never shipped + first deploy → Convoy leads. Score from
    // repo signals decisively; the pick becomes the mandate.
    if (mandate === null && q2 === 'first') {
      const scan = scanRepository(localPath);
      const decision = pickPlatform(scan);
      greenfieldPick = { platform: decision.chosen, reason: decision.reason };
      mandate = decision.chosen;
    }

    const prefs = mergePreferences(existing, {
      deployment: {
        ...(existing?.deployment ?? DEFAULT_PREFERENCES.deployment),
        mode: q2,
        approvers,
        vpsHost: vpsHost ?? existing?.deployment.vpsHost ?? null,
      },
      platform: {
        ...(existing?.platform ?? DEFAULT_PREFERENCES.platform),
        mandate,
      },
      secrets: {
        ...(existing?.secrets ?? DEFAULT_PREFERENCES.secrets),
        compliance,
      },
      ...(q3yes
        ? {
            release: {
              ...(existing?.release ?? DEFAULT_PREFERENCES.release),
              // Compliance disables auto-approve: production needs a named
              // approver gate, not a clean rehearsal alone.
              gate: 'pr-staging-approver' as const,
            },
          }
        : {}),
    });
    savePreferences(localPath, prefs);

    output.write('\n');
    if (greenfieldPick) {
      output.write(
        `${pc.cyan('▲')} ${pc.bold(`This service has never shipped. I'm taking it to ${greenfieldPick.platform}`)} — ${greenfieldPick.reason}.\n`,
      );
      output.write(
        `  ${pc.dim('This becomes your default; change it anytime with')} ${pc.bold('convoy onboard')}${pc.dim('.')}\n`,
      );
    } else if (mandate) {
      output.write(
        `${pc.cyan('▲')} I'll ship this to ${pc.bold(mandate)} from now on — that's the team mandate. Change it with ${pc.bold('convoy onboard')}.\n`,
      );
    }
    if (compliance.length > 0) {
      output.write(
        `  ${pc.dim(`Compliance on file (${compliance.join(', ')}) — auto-approve is off; production waits for a named approver.`)}\n`,
      );
    }
    if (alreadySet.length > 0) {
      output.write(
        `  ${pc.dim(`Recorded ${alreadySet.length} var${alreadySet.length === 1 ? '' : 's'} as already set on the platform: ${alreadySet.join(', ')}`)}\n`,
      );
    }
    output.write(`${pc.green('✓')} Preferences saved to .convoy/preferences.json\n`);
    output.write(
      `  ${pc.dim('Tip: run')} ${pc.bold(`convoy onboard ${repoPath}`)} ${pc.dim('later for the full interview (canary strategy, budget, observability).')}\n\n`,
    );

    return prefs;
  } finally {
    rl.close();
  }
}

/**
 * Append KEY= lines to .env.convoy-already-set, skipping keys already
 * declared so re-running the interview stays idempotent.
 */
function recordAlreadySet(localPath: string, keys: string[]): void {
  const filePath = resolve(localPath, '.env.convoy-already-set');
  const prior = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const have = new Set(
    prior
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0]!.trim()),
  );
  const fresh = keys.filter((k) => !have.has(k));
  if (fresh.length === 0) return;
  const separator = prior.length > 0 && !prior.endsWith('\n') ? '\n' : '';
  appendFileSync(filePath, `${separator}${fresh.map((k) => `${k}=`).join('\n')}\n`, 'utf8');
}
