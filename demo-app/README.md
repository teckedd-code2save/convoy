# convoy-demo-orders

Tiny Express orders service used as the target of Convoy demos. Convoy scans this repo, plans a deployment to it, and rehearses on an ephemeral twin.

## Modes

The service has two modes, controlled by the `DEMO_MODE` env var:

- `stable` (default) — healthy, consistent latency, no errors.
- `buggy` — returns HTTP 500 on every 10th `/orders` request and injects ~400ms latency spikes. The bug is in `src/routes/orders.ts:44`. This is what medic diagnoses during the rehearsal demo.

## Routes

- `GET /health` — returns 200 `{ status: "ok" }`.
- `GET /metrics` — returns current-minute p50 / p95 / p99 / error rate over a rolling window.
- `GET /orders` — paginated orders list. Buggy under `DEMO_MODE=buggy`.
- `POST /orders` — append order. Stable in both modes.

## Run locally

```bash
npm install
npm run dev                 # stable mode
DEMO_MODE=buggy npm run dev # buggy mode

# In another terminal, hammer it:
npm run traffic
```

## Env

```
PORT=8080
DEMO_MODE=stable
```

## Convoy

```bash
cd ..
npm run convoy -- plan demo-app --save
npm run convoy -- apply <plan-id> --no-auto-approve
```
