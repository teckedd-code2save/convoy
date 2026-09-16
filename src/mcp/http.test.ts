import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createConvoyHttpServer } from './http.js';
import { loadHttpCredentials } from './access.js';

const readToken = 'r'.repeat(40);
const executeToken = 'e'.repeat(40);
const approveToken = 'a'.repeat(40);

test('HTTP refuses missing, short, and shared role credentials', () => {
  assert.throws(() => createConvoyHttpServer({}), /Configure/);
  assert.throws(() => loadHttpCredentials({ CONVOY_MCP_TOKEN: 'short' }), /32/);
  assert.throws(() => loadHttpCredentials({ CONVOY_MCP_READ_TOKEN: readToken, CONVOY_MCP_APPROVAL_TOKEN: readToken }), /different/);
});

test('HTTP authenticates every request, isolates role toolsets, and handles repeated concurrent calls', async () => {
  const env = { CONVOY_MCP_READ_TOKEN: readToken, CONVOY_MCP_EXECUTE_TOKEN: executeToken, CONVOY_MCP_APPROVAL_TOKEN: approveToken };
  const server = createConvoyHttpServer(env);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const headers = (token?: string) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const rpc = (token: string, method = 'tools/list', params?: unknown) => fetch(url, { method: 'POST', headers: headers(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: headers(), body: '{}' })).status, 401);
    assert.equal((await rpc('invalid')).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers(readToken), Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { headers: headers(readToken) })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: headers(readToken), body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: headers(readToken), body: 'x'.repeat(1_048_577) })).status, 413);
    const lists = await Promise.all([readToken, executeToken, approveToken, readToken, executeToken].map(async (token) => {
      const response = await rpc(token);
      assert.equal(response.status, 200);
      const data = await response.json() as { result: { tools: { name: string }[] } };
      return data.result.tools.map((tool) => tool.name);
    }));
    assert(lists[0]!.includes('convoy_status'));
    assert(!lists[0]!.includes('convoy_apply'));
    assert(lists[1]!.includes('convoy_apply'));
    assert(!lists[1]!.includes('convoy_approve'));
    assert(!lists[1]!.includes('convoy_rollback_apply'));
    assert(lists[2]!.includes('convoy_approve'));
    assert(!lists[2]!.includes('convoy_apply'));
    for (const token of [readToken, executeToken]) {
      const denied = await (await rpc(token, 'tools/call', { name: 'convoy_approve', arguments: { runId: 'fake', decision: 'approve' } })).json() as { result?: { isError?: boolean }; error?: unknown };
      assert(denied.error || denied.result?.isError);
    }
    for (const [args, message] of [
      [{ autoApprove: true }, /auto-approve/],
      [{ realRehearsal: true }, /isolated worker/],
    ] as const) {
      const denied = await (await rpc(executeToken, 'tools/call', { name: 'convoy_apply', arguments: { planId: 'fake', ...args } })).json() as { result: { isError: boolean; content: { text: string }[] } };
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0]!.text, message);
    }
    env.CONVOY_MCP_READ_TOKEN = 'n'.repeat(40);
    assert.equal((await rpc(readToken)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
