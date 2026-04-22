import { Router } from 'express';

const router = Router();

router.get('/health', async (_req, res) => {
  // Env-gated failure injection for testing Convoy's observe → rollback path.
  // Default off. Set DEMO_HEALTH_FAIL=1 to return 500 on every probe, or
  // DEMO_HEALTH_DELAY_MS=<n> to add artificial latency so p99 breaches.
  if (process.env['DEMO_HEALTH_FAIL'] === '1') {
    res.status(500).json({ status: 'err', mode: 'DEMO_HEALTH_FAIL' });
    return;
  }
  const delay = Number(process.env['DEMO_HEALTH_DELAY_MS'] ?? '0');
  if (delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  res.status(200).json({ status: 'ok' });
});

export default router;
