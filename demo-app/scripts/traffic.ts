const TARGET_URL = process.env['TRAFFIC_URL'] ?? 'http://localhost:8080';
const RPS = Number(process.env['RPS'] ?? 20);
const DURATION_MS = Number(process.env['DURATION_MS'] ?? 30_000);

interface Result {
  ok: number;
  err: number;
  latencies: number[];
}

async function main() {
  console.log(`hammering ${TARGET_URL} at ~${RPS} req/s for ${DURATION_MS / 1000}s...`);

  const result: Result = { ok: 0, err: 0, latencies: [] };
  const deadline = Date.now() + DURATION_MS;
  const gap = 1000 / RPS;

  const pending: Promise<void>[] = [];

  while (Date.now() < deadline) {
    pending.push(hit(result));
    await sleep(gap);
  }

  await Promise.allSettled(pending);

  const sorted = [...result.latencies].sort((a, b) => a - b);
  const p = (q: number) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

  console.log('\n--- result ---');
  console.log(`requests: ${result.ok + result.err}`);
  console.log(`ok:       ${result.ok}`);
  console.log(`errors:   ${result.err} (${(100 * result.err / Math.max(1, result.ok + result.err)).toFixed(2)}%)`);
  console.log(`p50:      ${p(0.5)}ms`);
  console.log(`p95:      ${p(0.95)}ms`);
  console.log(`p99:      ${p(0.99)}ms`);
}

async function hit(result: Result): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${TARGET_URL}/orders?page=1&pageSize=20`);
    const latency = Date.now() - start;
    result.latencies.push(latency);
    if (res.ok) result.ok += 1;
    else result.err += 1;
  } catch {
    result.err += 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
