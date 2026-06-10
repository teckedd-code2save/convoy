#!/usr/bin/env node
/**
 * Convoy MCP server entrypoint — stdio transport. Claude Code (or any MCP
 * client) spawns this as a subprocess; stdout carries JSON-RPC frames, so
 * all diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createConvoyServer } from './server.js';

async function main(): Promise<void> {
  const server = createConvoyServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('convoy mcp server connected (stdio)');
}

main().catch((err: unknown) => {
  console.error('convoy mcp server failed to start:', err);
  process.exit(1);
});
