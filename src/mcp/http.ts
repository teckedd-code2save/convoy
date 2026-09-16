#!/usr/bin/env node
/** Streamable HTTP for a single trusted Convoy workspace. See docs/mcp.md. */
import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateHttp, loadHttpCredentials } from './access.js';
import { createConvoyServer } from './server.js';

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_048_576) throw new RequestError(413, 'Request exceeds 1 MiB');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON body'); }
}

export function createConvoyHttpServer(env: NodeJS.ProcessEnv = process.env) {
  // Refuse startup with an exposed, unauthenticated MCP endpoint.
  loadHttpCredentials(env);
  const allowedOrigins = new Set((env['CONVOY_MCP_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transport: 'http', version: '0.0.1' }));
      return;
    }
    if (path !== '/mcp') { res.writeHead(404); res.end(); return; }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.writeHead(403); res.end('Origin is not allowed'); return;
    }
    let access;
    try { access = authenticateHttp(req.headers.authorization, loadHttpCredentials(env)); }
    catch { res.writeHead(503); res.end('MCP authentication is not configured'); return; }
    if (!access) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="convoy"', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid bearer credential required' })); return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }); res.end(); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > 1_048_576) {
      res.writeHead(413); res.end('Request exceeds 1 MiB'); return;
    }
    // A stateless transport handles ONE request. Sharing it breaks subsequent
    // and concurrent calls and can mix the principals of different requests.
    let server: ReturnType<typeof createConvoyServer> | undefined;
    try {
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      server = createConvoyServer(access);
      const close = () => { void server?.close().catch(() => undefined); };
      res.once('close', close);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(err instanceof RequestError ? err.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof RequestError ? err.message : 'MCP request failed' }));
      }
      await server?.close().catch(() => undefined);
    }
  });
}

function main() {
  const port = Number(process.env['CONVOY_MCP_PORT'] ?? 3738);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONVOY_MCP_PORT');
  const host = process.env['CONVOY_MCP_HOST'] ?? '127.0.0.1';
  const server = createConvoyHttpServer();
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(port, host, () => console.error('Convoy MCP HTTP listening on ' + host + ':' + port));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}
