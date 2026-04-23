'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import {
  bulkMarkAlreadySet,
  bulkUnstage,
  changePlanPlatform,
  importEnvVars,
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

  // Per-row editing is driven from the panel (rather than each row) so
  // "edit in place" can persist across the transient pending state of the
  // server action. After save the row re-renders fresh from server props.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const allKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const selectedCount = selected.size;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = (filter: (r: PanelRow) => boolean) => {
    setSelected(new Set(rows.filter(filter).map((r) => r.key)));
  };

  const clearSelection = () => setSelected(new Set());

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
          <div className="space-y-3">
            <ImportSection planId={planId} allKeys={allKeys} />

            <BulkBar
              totalRows={rows.length}
              missing={missing}
              staged={staged}
              selected={selected}
              rows={rows}
              planId={planId}
              onSelectMissing={() => selectAll((r) => r.state === 'missing')}
              onSelectStaged={() => selectAll((r) => r.state !== 'missing')}
              onClear={clearSelection}
            />

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                Configuration ({missing > 0 ? `${missing} still missing` : 'all declared'})
              </div>
              {selectedCount === 0 ? (
                <div className="text-xs text-muted">
                  tip: check rows to bulk-clear or bulk-mark-already-set
                </div>
              ) : null}
            </div>

            <ul className="divide-y divide-rule/60 border border-rule rounded-md bg-paper">
              {rows.map((row) => (
                <li key={row.key}>
                  <EnvRow
                    planId={planId}
                    row={row}
                    checked={selected.has(row.key)}
                    editing={editingKey === row.key}
                    onToggle={() => toggle(row.key)}
                    onStartEdit={() => setEditingKey(row.key)}
                    onFinishEdit={() => setEditingKey(null)}
                  />
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

function ImportSection({
  planId,
  allKeys,
}: {
  planId: string;
  allKeys: string[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'matching' | 'all'>('matching');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | null
    | {
        stagedCount: number;
        skippedCount: number;
        unknownKeys: string[];
        invalidKeys: string[];
      }
  >(null);
  const [error, setError] = useState<string | null>(null);

  // Cheap preview — parsed client-side so the operator sees "will stage N
  // of M keys" before hitting the server.
  const preview = useMemo(() => analyseImport(text, allKeys), [text, allKeys]);

  const submit = () => {
    if (pending || text.trim().length === 0) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await importEnvVars(planId, text, mode);
      if (!res.ok) {
        setError(res.reason ?? 'import failed');
        return;
      }
      setResult({
        stagedCount: res.stagedCount ?? 0,
        skippedCount: res.skippedCount ?? 0,
        unknownKeys: res.unknownKeys ?? [],
        invalidKeys: res.invalidKeys ?? [],
      });
      setText('');
    });
  };

  return (
    <div className="border border-rule rounded-md bg-paper">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-rule/20 transition"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted flex-1">
          Import from .env file
        </span>
        <span className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-accent/10 text-accent">
          bulk prefill
        </span>
        <span className="text-xs text-muted">{open ? 'hide ▴' : 'show ▾'}</span>
      </button>
      {open ? (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-rule/60">
          <p className="text-xs text-muted leading-relaxed">
            Paste the contents of a .env file. Convoy parses KEY=value (and
            export KEY=...) line by line, strips quotes, and stages each value
            locally. Values never leave this machine — they append to the same
            .env.convoy-secrets the Stage button writes to.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={`DATABASE_URL=postgres://...\nCLERK_SECRET_KEY=sk_test_...\nSTRIPE_KEY=...`}
            disabled={pending}
            spellCheck={false}
            className="w-full text-xs font-mono bg-card border border-rule rounded-md p-3 focus:border-accent focus:outline-none disabled:opacity-50 resize-y"
          />

          {text.trim().length > 0 ? (
            <div className="text-xs text-muted leading-relaxed">
              Preview: <span className="font-medium text-ink">{preview.parsed}</span> parseable
              key{preview.parsed === 1 ? '' : 's'} ·{' '}
              <span className="font-medium text-success">{preview.matching}</span> match the
              expected set
              {preview.unmatched > 0 ? (
                <>
                  {' '}
                  · <span className="font-medium text-warn">{preview.unmatched}</span> not in
                  the expected set
                </>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name={`import-mode-${planId}`}
                  value="matching"
                  checked={mode === 'matching'}
                  onChange={() => setMode('matching')}
                  disabled={pending}
                  className="accent-accent"
                />
                only keys in the expected set
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer ml-3">
                <input
                  type="radio"
                  name={`import-mode-${planId}`}
                  value="all"
                  checked={mode === 'all'}
                  onChange={() => setMode('all')}
                  disabled={pending}
                  className="accent-accent"
                />
                everything in the paste
              </label>
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={pending || text.trim().length === 0}
              className="ml-auto text-xs font-medium px-3 py-1.5 rounded-md bg-ink text-paper hover:bg-ink/80 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {pending ? 'importing…' : 'import'}
            </button>
          </div>

          {error ? <div className="text-xs text-danger">{error}</div> : null}
          {result ? (
            <div className="text-xs space-y-1">
              <div>
                <span className="text-success font-medium">Staged {result.stagedCount}</span>
                {result.skippedCount > 0 ? (
                  <>
                    {' '}
                    · skipped {result.skippedCount} not in expected set:{' '}
                    <span className="font-mono">{result.unknownKeys.join(', ')}</span>
                  </>
                ) : null}
              </div>
              {result.invalidKeys.length > 0 ? (
                <div className="text-warn">
                  Rejected as invalid:{' '}
                  <span className="font-mono">{result.invalidKeys.join(', ')}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function analyseImport(text: string, allKeys: string[]): { parsed: number; matching: number; unmatched: number } {
  if (text.trim().length === 0) return { parsed: 0, matching: 0, unmatched: 0 };
  const expected = new Set(allKeys);
  let parsed = 0;
  let matching = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length === 0) continue;
    parsed += 1;
    if (expected.has(key)) matching += 1;
  }
  return { parsed, matching, unmatched: parsed - matching };
}

function BulkBar({
  totalRows,
  missing,
  staged,
  selected,
  rows,
  planId,
  onSelectMissing,
  onSelectStaged,
  onClear,
}: {
  totalRows: number;
  missing: number;
  staged: number;
  selected: Set<string>;
  rows: PanelRow[];
  planId: string;
  onSelectMissing: () => void;
  onSelectStaged: () => void;
  onClear: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const selectedCount = selected.size;
  const selectedStagedCount = rows.filter(
    (r) => selected.has(r.key) && r.state !== 'missing',
  ).length;

  const runAction = (fn: () => Promise<{ ok: boolean; reason?: string }>, clear = true) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.reason ?? 'failed');
        return;
      }
      if (clear) onClear();
    });
  };

  if (selectedCount === 0) {
    return (
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted">select:</span>
        <button
          type="button"
          onClick={onSelectMissing}
          disabled={missing === 0}
          className="font-medium px-2 py-0.5 rounded border border-rule hover:bg-rule/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          all missing ({missing})
        </button>
        <button
          type="button"
          onClick={onSelectStaged}
          disabled={staged === 0}
          className="font-medium px-2 py-0.5 rounded border border-rule hover:bg-rule/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          all staged ({staged})
        </button>
        <span className="text-muted ml-auto">{totalRows} total</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs bg-accent/5 border border-accent/30 rounded-md px-3 py-2">
      <span className="font-semibold text-accent">{selectedCount} selected</span>
      <button
        type="button"
        onClick={() =>
          runAction(() => bulkUnstage(planId, [...selected]))
        }
        disabled={pending || selectedStagedCount === 0}
        className="font-medium px-2 py-0.5 rounded border border-rule bg-paper hover:bg-rule/30 disabled:opacity-40 disabled:cursor-not-allowed"
        title={
          selectedStagedCount === 0
            ? 'only staged or already-set rows can be cleared'
            : `clear ${selectedStagedCount} staged / already-set rows`
        }
      >
        clear ({selectedStagedCount})
      </button>
      <button
        type="button"
        onClick={() =>
          runAction(() => bulkMarkAlreadySet(planId, [...selected]))
        }
        disabled={pending}
        className="font-medium px-2 py-0.5 rounded border border-rule bg-paper hover:bg-rule/30 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        mark already-set
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={pending}
        className="font-medium px-2 py-0.5 text-muted hover:text-ink"
      >
        cancel
      </button>
      {pending ? <span className="text-muted">working…</span> : null}
      {error ? <span className="text-danger ml-2">{error}</span> : null}
    </div>
  );
}

function EnvRow({
  planId,
  row,
  checked,
  editing,
  onToggle,
  onStartEdit,
  onFinishEdit,
}: {
  planId: string;
  row: PanelRow;
  checked: boolean;
  editing: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onFinishEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const runAction = (action: () => Promise<{ ok: boolean; reason?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.reason ?? 'failed');
      else {
        setValue('');
        onFinishEdit();
      }
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

  // A row is in "input mode" when it's missing, or when the operator
  // clicked edit on a staged/already-set row.
  const showInput = row.state === 'missing' || editing;

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="w-3.5 h-3.5 accent-accent cursor-pointer self-center"
          aria-label={`select ${row.key}`}
        />
        <span className="font-mono text-sm font-medium">{row.key}</span>
        {badge}
        <span className="text-[10px] uppercase tracking-wider font-medium text-muted">
          from {row.source === 'schema' ? '.env.schema' : '.env.example'}
        </span>
        {!showInput ? (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onStartEdit}
              disabled={pending}
              className="text-[10px] uppercase tracking-wider text-muted hover:text-ink disabled:opacity-40"
            >
              edit
            </button>
            <button
              type="button"
              onClick={() => runAction(() => unstageEnvVar(planId, row.key))}
              disabled={pending}
              className="text-[10px] uppercase tracking-wider text-muted hover:text-danger disabled:opacity-40"
            >
              clear
            </button>
          </div>
        ) : null}
      </div>

      {showInput ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              row.state === 'staged'
                ? 'new value will replace the current staged value'
                : row.state === 'already-set'
                  ? 'enter value to stage locally instead of already-set'
                  : 'enter value to stage locally'
            }
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
            {row.state === 'staged' || editing ? 'save' : 'stage'}
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
          {row.state !== 'missing' ? (
            <button
              type="button"
              onClick={() => {
                setValue('');
                setError(null);
                onFinishEdit();
              }}
              disabled={pending}
              className="text-xs font-medium px-3 py-1.5 text-muted hover:text-ink disabled:opacity-40"
            >
              cancel
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </div>
  );
}
