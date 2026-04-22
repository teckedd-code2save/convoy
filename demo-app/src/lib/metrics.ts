interface Sample {
  durationMs: number;
  status: number;
  at: number;
}

const WINDOW_MS = 60_000;

class RollingMetrics {
  #samples: Sample[] = [];

  record(durationMs: number, status: number): void {
    const now = Date.now();
    this.#samples.push({ durationMs, status, at: now });
    this.#evict(now);
  }

  #evict(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.#samples.length > 0 && this.#samples[0]!.at < cutoff) {
      this.#samples.shift();
    }
  }

  snapshot(): {
    count: number;
    errorRatePct: number;
    p50: number;
    p95: number;
    p99: number;
    windowSeconds: number;
  } {
    this.#evict(Date.now());
    const count = this.#samples.length;
    if (count === 0) {
      return { count: 0, errorRatePct: 0, p50: 0, p95: 0, p99: 0, windowSeconds: WINDOW_MS / 1000 };
    }
    const sorted = [...this.#samples].sort((a, b) => a.durationMs - b.durationMs);
    const errors = this.#samples.filter((s) => s.status >= 500).length;
    return {
      count,
      errorRatePct: (errors / count) * 100,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      windowSeconds: WINDOW_MS / 1000,
    };
  }
}

function percentile(sorted: Sample[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!.durationMs;
}

export const metrics = new RollingMetrics();
