'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  changePlanPlatform,
  markEnvVarAlreadySet,
  setRecurring,
  stageEnvVar,
  unstageEnvVar,
} from '@/app/actions';

export interface PanelRow {
  key: string;
  source: 'schema' | 'example';
  state: 'staged' | 'already-set' | 'missing';
}

export function ConfigPanel({
  planId,
  platform,
  rows,
  recurring,
  alternatives,
  secretsPath,
  alreadySetPath,
}: {
  planId: string;
  platform: string;
  rows: PanelRow[];
  recurring: boolean;
  alternatives: string[];
  secretsPath: string;
  alreadySetPath: string;
}) {
  const staged = rows.filter((r) => r.state !== 'missing').length;
  const missing = rows.length - staged;

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Before you apply
        </h2>
        <span className="text-xs text-muted">
          {staged}/{rows.length} expected vars staged or declared · no platform queries
        </span>
      </div>

      <div className="border border-rule rounded-lg bg-card p-5 space-y-5">
        <DeploymentModeRow planId={planId} recurring={recurring} />

        <PlatformSwitchRow
          planId={planId}
          current={platform}
          alternatives={alternatives}
        />

        {rows.length === 0 ? (
          <p className="text-sm text-muted leading-relaxed">
            No expected env vars — the plan has neither a .env.schema nor a
            discoverable .env.example. Convoy will apply without the staging check.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Configuration ({missing > 0 ? `${missing} still missing` : 'all declared'})
            </div>
            <ul className="divide-y divide-rule/60 border border-rule rounded-md bg-paper">
              {rows.map((row) => (
                <li key={row.key}>
                  <EnvRow planId={planId} row={row} />
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted leading-relaxed mt-3">
              Staged values land in {' '}
              <code className="font-mono text-[11px]">{secretsPath}</code>.
              Keys marked already-set go to{' '}
              <code className="font-mono text-[11px]">{alreadySetPath}</code>.
              Both are gitignored.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function DeploymentModeRow({
  planId,
  recurring,
}: {
  planId: string;
  recurring: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [local, setLocal] = useState(recurring);
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setError(null);
    setLocal(next);
    startTransition(async () => {
      const result = await setRecurring(planId, next);
      if (!result.ok) {
        setError(result.reason ?? 'failed');
        setLocal(!next);
      }
    });
  };

  return (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        id={`recurring-${planId}`}
        checked={local}
        onChange={(e) => toggle(e.target.checked)}
        disabled={pending}
        className="mt-0.5 w-4 h-4 accent-accent cursor-pointer disabled:opacity-40"
      />
      <div className="flex-1">
        <label
          htmlFor={`recurring-${planId}`}
          className="text-sm font-medium cursor-pointer"
        >
          This is an update to a service that is already live
        </label>
        <p className="text-xs text-muted mt-0.5 leading-relaxed">
          Tells Convoy you&apos;re shipping a change, not a first deploy. The
          preflight tone adjusts. Convoy does not probe the platform; it trusts
          your declaration here.
          {error ? <span className="text-danger ml-2">({error})</span> : null}
        </p>
      </div>
    </div>
  );
}

function PlatformSwitchRow({
  planId,
  current,
  alternatives,
}: {
  planId: string;
  current: string;
  alternatives: string[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(current);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (choice === current) return;
    setError(null);
    startTransition(async () => {
      const result = await changePlanPlatform(planId, choice);
      if (!result.ok) {
        setError(result.reason ?? 'failed');
        return;
      }
      if (result.newPlanId) {
        router.push(`/plans/${result.newPlanId}`);
      }
    });
  };

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 w-4 h-4 flex items-center justify-center text-xs text-muted">▾</div>
      <div className="flex-1 flex items-center gap-3 flex-wrap">
        <label htmlFor={`platform-${planId}`} className="text-sm font-medium shrink-0">
          Platform
        </label>
        <select
          id={`platform-${planId}`}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={pending}
          className="text-sm font-mono bg-paper border border-rule rounded-md px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-50"
        >
          {alternatives.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === current ? ' (current)' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={pending || choice === current}
          className="text-xs font-medium px-3 py-1.5 rounded-md bg-ink text-paper hover:bg-ink/80 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {pending ? 'replanning…' : 're-plan'}
        </button>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
        <span className="text-xs text-muted ml-auto">
          Creates a new plan — the current one stays immutable.
        </span>
      </div>
    </div>
  );
}

function EnvRow({ planId, row }: { planId: string; row: PanelRow }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const runAction = (action: () => Promise<{ ok: boolean; reason?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.reason ?? 'failed');
      else setValue('');
    });
  };

  const badge =
    row.state === 'staged' ? (
      <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-success/10 text-success">
        staged
      </span>
    ) : row.state === 'already-set' ? (
      <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
        already set
      </span>
    ) : (
      <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-warn/10 text-warn">
        missing
      </span>
    );

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-sm font-medium">{row.key}</span>
        {badge}
        <span className="text-[10px] uppercase tracking-wider font-medium text-muted">
          from {row.source === 'schema' ? '.env.schema' : '.env.example'}
        </span>
        {row.state !== 'missing' ? (
          <button
            type="button"
            onClick={() => runAction(() => unstageEnvVar(planId, row.key))}
            disabled={pending}
            className="text-[10px] uppercase tracking-wider text-muted hover:text-danger ml-auto disabled:opacity-40"
          >
            clear
          </button>
        ) : null}
      </div>

      {row.state === 'missing' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="enter value to stage locally"
            disabled={pending}
            className="flex-1 min-w-[200px] text-sm font-mono bg-paper border border-rule rounded-md px-2 py-1 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => {
              if (value.trim().length === 0) {
                setError('value required to stage');
                return;
              }
              runAction(() => stageEnvVar(planId, row.key, value));
            }}
            disabled={pending || value.trim().length === 0}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-ink text-paper hover:bg-ink/80 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            stage
          </button>
          <button
            type="button"
            onClick={() => runAction(() => markEnvVarAlreadySet(planId, row.key))}
            disabled={pending}
            className="text-xs font-medium px-3 py-1.5 rounded-md border border-rule hover:bg-rule/30 disabled:opacity-40 disabled:cursor-not-allowed transition"
            title="Declare this var is already set on the deploy target (platform console, Fly/Vercel env). Convoy does not verify."
          >
            already set on platform
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-danger">{error}</div>
      ) : null}
    </div>
  );
}
