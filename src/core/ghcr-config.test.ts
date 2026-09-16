import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionEnvironment, prepareGhcrConfig, resolveGhcrConfig } from './ghcr-config.js';
import { authorizeTool } from '../mcp/access.js';

const input = { host: 'deploy@example.test', cwd: '/work', deployRoot: '/opt/app', appName: 'app', imageRef: 'ghcr.io/test/app', ghcrUsername: 'test' };
test('GHCR config persists only a reference and resolves it in the child', () => {
  const prepared = prepareGhcrConfig({ ...input, ghcrTokenEnv: 'GH_TOKEN' }, { GH_TOKEN: 'example-secret' });
  assert(!JSON.stringify(prepared.config).includes('example-secret'));
  assert.equal(resolveGhcrConfig(prepared.config, prepared.env).ghcrToken, 'example-secret');
  assert.equal(prepareGhcrConfig({ ...input, ghcrToken: 'local-token' }, {}).env.GHCR_TOKEN, 'local-token');
  assert.throws(() => resolveGhcrConfig(input, {}), /Missing GHCR/);
  assert.throws(() => resolveGhcrConfig({ ...input, ghcrTokenEnv: 'CONVOY_MCP_APPROVAL_TOKEN' }, {}), /ghcrTokenEnv/);
  assert.throws(() => authorizeTool({ role: 'execute' }, 'convoy_apply', { realVpsGhcr: { ...input, ghcrToken: 'raw' } }), /ghcrTokenEnv/);
});
test('execution children do not inherit MCP bearer credentials', () => {
  assert.deepEqual(executionEnvironment({ PATH: '/bin', GHCR_TOKEN: 'ghcr', CONVOY_MCP_TOKEN: 'legacy', CONVOY_MCP_READ_TOKEN: 'read', CONVOY_MCP_EXECUTE_TOKEN: 'execute', CONVOY_MCP_APPROVAL_TOKEN: 'approval' }), { PATH: '/bin', GHCR_TOKEN: 'ghcr' });
});
