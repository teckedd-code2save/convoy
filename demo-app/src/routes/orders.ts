import { Router, type Request, type Response } from 'express';

import { log } from '../lib/logger.js';

const DEMO_MODE = process.env['DEMO_MODE'] ?? 'stable';

interface Order {
  id: number;
  customer: string;
  amount: number;
  createdAt: string;
}

const orders: Order[] = Array.from({ length: 127 }, (_i, i) => ({
  id: i + 1,
  customer: `customer-${i + 1}`,
  amount: Math.round(Math.random() * 10000) / 100,
  createdAt: new Date(Date.now() - (127 - i) * 60_000).toISOString(),
}));

const router = Router();
let counter = 0;

router.get('/orders', async (req: Request, res: Response) => {
  counter += 1;
  const pageSize = Number(req.query['pageSize'] ?? 20);
  const page = Number(req.query['page'] ?? 1);

  // DEMO_MODE=buggy — every 10th request, return 500 with high latency.
  // Looks like a real stuck-dependency failure mode under load. Medic's job
  // is to diagnose this from logs.
  if (DEMO_MODE === 'buggy' && counter % 10 === 0) {
    const spike = 350 + Math.random() * 150;
    await sleep(spike);
    log({
      level: 'error',
      message: 'orders_query_timeout',
      latency_ms: Math.round(spike),
      endpoint: '/orders',
      page,
      pageSize,
      note: 'downstream orders-db call exceeded deadline',
    });
    res.status(500).json({ error: 'orders service unavailable — upstream timeout' });
    return;
  }

  const base = 12 + Math.random() * 8;
  await sleep(base);

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const slice = orders.slice(start, end);

  log({
    level: 'info',
    message: 'orders_served',
    count: slice.length,
    page,
    pageSize,
    latency_ms: Math.round(base),
  });

  res.status(200).json({
    page,
    pageSize,
    total: orders.length,
    orders: slice,
  });
});

router.post('/orders', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<Order>;
  const order: Order = {
    id: orders.length + 1,
    customer: body.customer ?? 'anonymous',
    amount: Number(body.amount ?? 0),
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  log({ level: 'info', message: 'orders_created', id: order.id });
  res.status(201).json(order);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
