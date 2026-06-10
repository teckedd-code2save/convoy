import { Router, type Request, type Response } from 'express';

import { log } from '../lib/logger.js';

const DEMO_MODE = process.env['DEMO_MODE'] ?? 'stable';

const router = Router();

// Global serialisation lock. Only one report renders at a time because the
// underlying PDF library is not thread-safe. This was fine at 1-2 concurrent
// users; at 30 it means the last request waits 30 × RENDER_MS before it even
// starts.
//
// TODO: replace with a bounded worker pool (limit=4) — this single lock
// serialises all render requests through one queue.
let renderLock: Promise<void> = Promise.resolve();

const RENDER_MS = 300; // realistic single-page PDF render time

router.post('/render', async (req: Request, res: Response) => {
  const { reportId = 'unknown', pages = 1 } = (req.body ?? {}) as {
    reportId?: string;
    pages?: number;
  };

  const queued = Date.now();

  if (DEMO_MODE === 'concurrent') {
    // Acquire the global lock — block until the previous render finishes.
    const prev = renderLock;
    let release!: () => void;
    renderLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const waitMs = await prev.then(() => Date.now() - queued);
    log({
      level: 'info',
      message: 'render_lock_acquired',
      reportId,
      waited_ms: waitMs,
    });

    const renderStart = Date.now();
    await sleep(RENDER_MS * Number(pages));
    const renderMs = Date.now() - renderStart;

    release();

    const totalMs = Date.now() - queued;
    log({
      level: 'info',
      message: 'render_complete',
      reportId,
      pages,
      render_ms: renderMs,
      total_ms: totalMs,
    });

    res.status(200).json({
      reportId,
      pages,
      render_ms: renderMs,
      total_ms: totalMs,
      url: `/reports/${reportId}.pdf`,
    });
  } else {
    // Stable mode: renders are independent and fast.
    await sleep(20 + Math.random() * 20);
    const duration = Date.now() - queued;
    log({ level: 'info', message: 'render_complete', reportId, pages, total_ms: duration });
    res.status(200).json({
      reportId,
      pages,
      render_ms: duration,
      total_ms: duration,
      url: `/reports/${reportId}.pdf`,
    });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
