import { createHash, timingSafeEqual } from 'node:crypto';

export type McpRole = 'read' | 'execute' | 'approve' | 'local';
export interface McpAccess { role: McpRole }
const READ_TOOLS = new Set(['convoy_list_plans', 'convoy_status', 'convoy_diagnose', 'convoy_list_runs', 'convoy_rollback_preview']);
const EXECUTE_TOOLS = new Set(['convoy_plan', 'convoy_apply', 'convoy_orient']);

export function canCallTool(access: McpAccess, name: string): boolean {
  if (access.role === 'local') return true;
  if (READ_TOOLS.has(name)) return true;
  if (access.role === 'approve') return name === 'convoy_approve';
  return access.role === 'execute' && EXECUTE_TOOLS.has(name);
}

export function authorizeTool(access: McpAccess, name: string, args: unknown): void {
  if (!canCallTool(access, name)) throw new Error('This credential is not permitted to call ' + name);
  const input = args as Record<string, unknown> | undefined;
  if (access.role !== 'local' && name === 'convoy_apply') {
    if (input?.['autoApprove'] === true) throw new Error('Remote execution cannot auto-approve gates. Use a separate approval credential.');
    if (input?.['realRehearsal'] === true) throw new Error('Remote local-process rehearsal is disabled until an isolated worker is configured. Use the trusted local CLI for local rehearsal.');
    if ((input?.['realVpsGhcr'] as Record<string, unknown> | undefined)?.['ghcrToken']) {
      throw new Error('Use ghcrTokenEnv to reference a server-side credential; do not send a raw GHCR token.');
    }
  }
}

export interface HttpCredential { role: Exclude<McpRole, 'local'>; token: string }

export function loadHttpCredentials(env: NodeJS.ProcessEnv = process.env): HttpCredential[] {
  const entries: [Exclude<McpRole, 'local'>, string | undefined][] = [
    ['read', env['CONVOY_MCP_READ_TOKEN']],
    ['execute', env['CONVOY_MCP_EXECUTE_TOKEN'] ?? env['CONVOY_MCP_TOKEN']],
    ['approve', env['CONVOY_MCP_APPROVAL_TOKEN']],
  ];
  const credentials = entries.filter((entry): entry is [Exclude<McpRole, 'local'>, string] => Boolean(entry[1]))
    .map(([role, token]) => ({ role, token }));
  if (!credentials.length) throw new Error('Configure CONVOY_MCP_READ_TOKEN, CONVOY_MCP_EXECUTE_TOKEN, or CONVOY_MCP_APPROVAL_TOKEN before starting HTTP.');
  if (credentials.some((c) => c.token.length < 32 || /\s/.test(c.token))) throw new Error('MCP credentials must contain at least 32 non-whitespace characters.');
  if (new Set(credentials.map((c) => c.token)).size !== credentials.length) throw new Error('Use different MCP credentials for each role.');
  return credentials;
}

export function authenticateHttp(header: string | undefined, credentials: HttpCredential[]): McpAccess | null {
  if (!header?.startsWith('Bearer ')) return null;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  const matched = credentials.find((c) => timingSafeEqual(supplied, createHash('sha256').update(c.token).digest()));
  return matched ? { role: matched.role } : null;
}
