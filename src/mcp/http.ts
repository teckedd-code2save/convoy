#!/usr/bin/env node
/**
 * Convoy MCP server — Streamable HTTP transport.
 *
 * Use this for CI runners, hosted Convoy instances, and Docker deployments
 * where a persistent HTTP endpoint is better than spawning a subprocess per
 * session. The stdio transport (src/mcp/index.ts) stays the recommended path
 * for Claude Code local development.
 *
 * Runs stateless: no session IDs, no in-memory state between requests. All
 * durable state lives in .convoy/state.db, so multiple HTTP clients can
 * interleave tool calls safely.
 *
 * Usage:
 *   npm run mcp-http
 *   CONVOY_MCP_PORT=3739 npm run mcp-http
 *
 * Connect a client:
 *   claude mcp add convoy-http --transport sse http://localhost:3738/mcp
 */
import { createServer, type IncomingMessage } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createConvoyServer } from './server.js';

const PORT = parseInt(process.env['CONVOY_MCP_PORT'] ?? '3738', 10);

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').trim();
      if (!body) { resolve(undefined); return; }
      try { resolve(JSON.parse(body)); }
      catch { resolve(undefined); }
    });
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  // Stateless: sessionIdGenerator undefined means no Mcp-Session-Id header is
  // sent and no per-session state is buffered. Every POST is an independent
  // JSON-RPC round-trip — correct for short-lived CI callers.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = createConvoyServer();
  await mcpServer.connect(transport);

  const httpServer = createServer(async (req, res) => {
    const url = req.url ?? '';
    if (url === '/mcp' || url.startsWith('/mcp?')) {
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transport: 'http', port: PORT, version: '0.0.1' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.listen(PORT, () => {
    console.error(`convoy mcp server (http) ready`);
    console.error(`  MCP endpoint : http://0.0.0.0:${PORT}/mcp`);
    console.error(`  Health check : http://0.0.0.0:${PORT}/health`);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.on(sig, () => {
      httpServer.close(() => {
        transport.close().catch(() => undefined).finally(() => process.exit(0));
      });
    });
  }
}

main().catch((err: unknown) => {
  console.error('convoy mcp http server failed to start:', err);
  process.exit(1);
});
