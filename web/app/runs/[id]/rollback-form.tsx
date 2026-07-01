'use client';

import { useCallback, useState } from 'react';

import type { RollbackPreviewResult } from '@/app/actions';
import { rollbackPreview, executeRollback } from '@/app/actions';

interface RollbackFormProps {
  appName: string;
  onComplete?: () => void;
}

/**
 * Two-step rollback form:
 * 1. "Show preview" → fetches current vs target release info, shows diff
 * 2. "Confirm & roll back" → executes the rollback, reloads the page
 */
export function RollbackForm({ appName, onComplete }: RollbackFormProps) {
  const [preview, setPreview] = useState<RollbackPreviewResult | null>(null);
  const [loading, setLoading] = useState<'idle' | 'previewing' | 'rolling'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [rolledBack, setRolledBack] = useState(false);

  const handleShowPreview = useCallback(async () => {
    setLoading('previewing');
    setError(null);
    const result = await rollbackPreview(appName);
    if (!result.ok) {
      setError(result.reason);
      setLoading('idle');
      return;
    }
    setPreview(result.preview);
    setLoading('idle');
  }, [appName]);

  const handleExecute = useCallback(async () => {
    if (!preview) return;
    setLoading('rolling');
    setError(null);
    const result = await executeRollback(appName, preview.targetVersion);
    if (!result.ok) {
      setError(result.reason);
      setLoading('idle');
      return;
    }
    setRolledBack(true);
    onComplete?.();
    setTimeout(() => window.location.reload(), 1200);
  }, [appName, preview, onComplete]);

  if (rolledBack) {
    return (
      <div className="rounded-lg border border-green/50 bg-green/5 p-4 text-center">
        <span className="text-green text-lg font-semibold">✓ Rolled back to v{preview?.targetVersion}</span>
        <p className="text-sm text-muted mt-1">Reloading...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-warn text-lg">↺</span>
        <h3 className="font-semibold text-sm">Rollback</h3>
      </div>

      {error ? (
        <div className="text-sm bg-danger/10 border border-danger/30 rounded-md p-2.5 text-danger">
          {error}
        </div>
      ) : null}

      {!preview ? (
        <div>
          <p className="text-xs text-muted mb-3">
            Roll back <span className="font-mono">{appName}</span> to the previous healthy release.
            A preview will show what version and image will be restored.
          </p>
          <button
            type="button"
            disabled={loading === 'previewing'}
            onClick={handleShowPreview}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-rule/50 bg-card hover:bg-card/80 transition-colors disabled:opacity-50"
          >
            {loading === 'previewing' ? (
              <>
                <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                Fetching preview...
              </>
            ) : (
              'Show preview'
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Preview diff */}
          <div className="bg-card rounded-md border border-rule/40 p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs font-semibold uppercase tracking-wider">Current</span>
              <span className="font-mono text-xs">v{preview.currentVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs font-semibold uppercase tracking-wider">Target</span>
              <span className="font-mono text-xs font-semibold">v{preview.targetVersion}</span>
            </div>
            {preview.currentImage || preview.targetImage ? (
              <div className="border-t border-rule/30 pt-2 mt-2">
                <div className="text-[11px] text-muted mb-1 font-semibold uppercase tracking-wider">Image</div>
                {preview.currentImage ? (
                  <div className="font-mono text-[11px] text-muted truncate">{preview.currentImage}</div>
                ) : null}
                <div className="text-muted/50 text-[11px]">↓</div>
                {preview.targetImage ? (
                  <div className="font-mono text-[11px] text-ink truncate">{preview.targetImage}</div>
                ) : null}
                {preview.imageChanged ? (
                  <span className="inline-block mt-1 text-[11px] text-warn font-medium">Image will change</span>
                ) : (
                  <span className="inline-block mt-1 text-[11px] text-muted">Same image (config-only)</span>
                )}
              </div>
            ) : null}
          </div>

          <p className="text-xs text-muted">
            This will restore v{preview.targetVersion} as the live deployment for{' '}
            <span className="font-mono">{preview.appName}</span>.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading === 'rolling'}
              onClick={handleExecute}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-warn text-white hover:bg-warn/90 transition-colors disabled:opacity-50"
            >
              {loading === 'rolling' ? (
                <>
                  <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Rolling back...
                </>
              ) : (
                'Confirm & roll back'
              )}
            </button>
            <button
              type="button"
              disabled={loading !== 'idle'}
              onClick={() => { setPreview(null); setError(null); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-rule/50 bg-card hover:bg-card/80 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
