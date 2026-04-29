'use client';

import { useMemo, useState, useTransition } from 'react';

import { submitStagedSecrets, type SecretAction } from '@/app/actions';

type MissingKey = {
  key: string;
  severity: 'critical' | 'standard';
  purpose: string;
};

type Platform = 'fly' | 'vercel' | 'cloudrun' | 'railway';

type Resolution = 'paste' | 'already_set' | 'skip';

/**
 * Inline staging form for the stage_secrets approval. Each missing key
 * gets its own row with three resolution paths (paste / already-set /
 * skip). Submit collects the per-key actions and posts them through the
 * server action — the action writes to .env.convoy-secrets, pushes to
 * the platform CLI for pasted values, and approves the approval gate so
 * the orchestrator unblocks.
 *
 * The form is built so a screenshot of it makes the operator's choice
 * unambiguous: critical keys glow danger-magenta, the resolution radio
 * group shows the active choice with an accent border, pasted values
 * masked but not obscured, and the bottom bar surfaces a per-key result
 * count after submit ("3 staged · 1 declared · 0 errors").
 */
export function SecretStagingForm({
  runId,
  approvalId,
  planId,
  missing,
  platform,
  flyApp,
  targetCwd,
  laneLabel,
  projectBinding,
  railwayService,
  railwayEnvironment,
  cloudRunService,
  cloudRunRegion,
}: {
  runId: string;
  approvalId: string;
  planId: string;
  missing: MissingKey[];
  platform: Platform;
  flyApp: string | null;
  targetCwd: string;
  laneLabel?: string | null;
  projectBinding?: string | null;
  railwayService?: string | null;
  railwayEnvironment?: string | null;
  cloudRunService?: string | null;
  cloudRunRegion?: string | null;
}) {
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>(
    () =>
      Object.fromEntries(
        missing.map((m) => [m.key, m.severity === 'critical' ? 'paste' : 'paste']),
      ) as Record<string, Resolution>,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();
  const [results, setResults] = useState<
    | null
    | {
        key: string;
        status: 'staged' | 'declared' | 'skipped' | 'error';
        message?: string;
      }[]
  >(null);
  const [topError, setTopError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return missing.every((m) => {
      const r = resolutions[m.key];
      if (r === 'paste') {
        return (values[m.key] ?? '').length > 0;
      }
      return r === 'already_set' || r === 'skip';
    });
  }, [missing, resolutions, values]);

  function handleSubmit() {
    setTopError(null);
    setResults(null);
    const actions: SecretAction[] = missing.map((m) => {
      const r = resolutions[m.key]!;
      if (r === 'paste') return { kind: 'paste', key: m.key, value: values[m.key] ?? '' };
      if (r === 'already_set') return { kind: 'already_set', key: m.key };
      return { kind: 'skip', key: m.key };
    });
    startTransition(async () => {
      const res = await submitStagedSecrets(runId, approvalId, planId, actions, {
        platform,
        flyApp,
        targetCwd,
        projectBinding,
        railwayService,
        railwayEnvironment,
        cloudRunService,
        cloudRunRegion,
      });
      if (!res.ok) {
        setTopError(res.reason ?? 'submit failed');
      }
      setResults(res.results);
    });
  }

  const submitted = results !== null;
  const counts = useMemo(() => {
    if (!results) return null;
    const c = { staged: 0, declared: 0, skipped: 0, errors: 0 };
    for (const r of results) {
      if (r.status === 'staged') c.staged += 1;
      else if (r.status === 'declared') c.declared += 1;
      else if (r.status === 'skipped') c.skipped += 1;
      else c.errors += 1;
    }
    return c;
  }, [results]);

  return (
    <div className="space-y-4">
      {(laneLabel || projectBinding) ? (
        <p className="text-xs text-muted">
          {laneLabel ? `${laneLabel}` : 'lane'}{projectBinding ? ` · ${projectBinding}` : ''}.
        </p>
      ) : null}
      <ul className="space-y-3">
        {missing.map((m) => {
          const resolution = resolutions[m.key] ?? 'paste';
          const value = values[m.key] ?? '';
          const result = results?.find((r) => r.key === m.key);
          return (
            <li
              key={m.key}
              className={`rounded-lg border p-4 transition-colors ${
                result?.status === 'staged'
                  ? 'border-success/50 bg-success/5'
                  : result?.status === 'declared'
                    ? 'border-accent/50 bg-accent/5'
                    : result?.status === 'error'
                      ? 'border-danger/50 bg-danger/5'
                      : result?.status === 'skipped'
                        ? 'border-muted/30 bg-card/40'
                        : m.severity === 'critical'
                          ? 'border-danger/40 bg-danger/[0.04]'
                          : 'border-rule/40 bg-card/60'
              }`}
            >
              <div className="flex items-baseline gap-3 flex-wrap">
                <code className={`text-sm font-mono font-semibold ${m.severity === 'critical' ? 'text-danger' : 'text-ink'}`}>
                  {m.key}
                </code>
                {m.severity === 'critical' ? (
                  <span className="text-[10px] uppercase tracking-[0.16em] font-semibold text-danger">
                    critical
                  </span>
                ) : null}
                <span className="text-xs text-muted">{m.purpose}</span>
                {result ? (
                  <span
                    className={`text-xs ml-auto ${
                      result.status === 'staged' ? 'text-success' :
                      result.status === 'declared' ? 'text-accent' :
                      result.status === 'error' ? 'text-danger' :
                      'text-muted'
                    }`}
                  >
                    {result.status === 'staged' ? `✓ pushed to ${platform}` :
                     result.status === 'declared' ? '✓ declared' :
                     result.status === 'error' ? `✗ ${result.message ?? 'failed'}` :
                     '— skipped'}
                  </span>
                ) : null}
              </div>

              {!submitted ? (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2 flex-wrap text-xs">
                    {(['paste', 'already_set', 'skip'] as const).map((r) => (
                      <label
                        key={r}
                        className={`px-2.5 py-1 rounded-md border cursor-pointer transition-colors ${
                          resolution === r
                            ? 'border-accent/60 bg-accent/10 text-accent'
                            : 'border-rule/40 text-muted hover:border-rule hover:text-ink'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`resolution-${m.key}`}
                          value={r}
                          checked={resolution === r}
                          onChange={() => setResolutions({ ...resolutions, [m.key]: r })}
                          className="sr-only"
                        />
                        {r === 'paste' ? 'paste value' : r === 'already_set' ? 'already set on platform' : 'skip (accept risk)'}
                      </label>
                    ))}
                  </div>

                  {resolution === 'paste' ? (
                    <div className="flex gap-2">
                      <input
                        type={reveal[m.key] ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={`paste ${m.key} value…`}
                        value={value}
                        onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}
                        className="flex-1 px-3 py-1.5 rounded-md border border-rule/60 bg-paper/60 text-sm font-mono focus:outline-none focus:border-accent/60"
                      />
                      <button
                        type="button"
                        onClick={() => setReveal({ ...reveal, [m.key]: !reveal[m.key] })}
                        className="px-2 text-xs text-muted hover:text-ink"
                      >
                        {reveal[m.key] ? 'hide' : 'show'}
                      </button>
                    </div>
                  ) : null}

                  {resolution === 'already_set' ? (
                    <p className="text-xs text-muted">
                      Convoy will record that you set <code>{m.key}</code> on {platform} via dashboard / CLI. Future runs won&apos;t prompt for this key.
                    </p>
                  ) : null}

                  {resolution === 'skip' ? (
                    <p className="text-xs text-warn">
                      The deploy will proceed without <code>{m.key}</code>. If your app needs it at runtime, it will fail.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {topError ? (
        <div className="text-sm text-danger">{topError}</div>
      ) : null}

      {counts ? (
        <div className="text-xs text-muted flex items-center gap-3 flex-wrap">
          <span>{counts.staged} pushed to {platform}</span>
          <span>·</span>
          <span>{counts.declared} declared</span>
          <span>·</span>
          <span>{counts.skipped} skipped</span>
          {counts.errors > 0 ? (
            <>
              <span>·</span>
              <span className="text-danger">{counts.errors} error{counts.errors === 1 ? '' : 's'}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {!submitted ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending || !canSubmit}
            onClick={handleSubmit}
            className="px-4 py-2 rounded-md bg-accent text-paper text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? 'Staging…' : 'Stage and continue'}
          </button>
          <span className="text-xs text-muted">
            Convoy writes pasted values to <code>.env.convoy-secrets</code> AND pushes them to {platform} before the deploy starts.
          </span>
        </div>
      ) : counts && counts.errors === 0 ? (
        <div className="text-sm text-success">
          ✓ All keys resolved. Convoy is continuing the run.
        </div>
      ) : (
        <div className="text-sm text-warn">
          Approval submitted with errors above. Convoy is continuing the run; the deploy will fail loudly if a critical key wasn&apos;t pushed.
        </div>
      )}
    </div>
  );
}
