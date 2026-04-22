import express from 'express';

import { log } from './lib/logger.js';
import { metrics } from './lib/metrics.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import ordersRouter from './routes/orders.js';

const PORT = Number(process.env['PORT'] ?? 8080);
const DEMO_MODE = process.env['DEMO_MODE'] ?? 'stable';

const app = express();
app.use(express.json());

// Latency + status measurement middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.record(duration, res.statusCode);
  });
  next();
});

app.use(healthRouter);
app.use(metricsRouter);
app.use(ordersRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log({ level: 'error', message: 'unhandled_error', error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  log({
    level: 'info',
    message: 'server_started',
    port: PORT,
    mode: DEMO_MODE,
    pid: process.pid,
  });
});
