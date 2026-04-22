import { Router } from 'express';

import { metrics } from '../lib/metrics.js';

const router = Router();

router.get('/metrics', (_req, res) => {
  res.status(200).json(metrics.snapshot());
});

export default router;
