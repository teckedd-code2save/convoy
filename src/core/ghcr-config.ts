import type { RealVpsGhcrOpt } from './stages.js';

export type GhcrConfigInput = Omit<RealVpsGhcrOpt, 'ghcrToken'> & { ghcrToken?: string; ghcrTokenEnv?: string };
const ALLOWED_TOKEN_REFS = new Set(['GHCR_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);

export function resolveGhcrConfig(input: GhcrConfigInput, env: NodeJS.ProcessEnv = process.env): RealVpsGhcrOpt {
  const ref = input.ghcrTokenEnv ?? 'GHCR_TOKEN';
  if (!ALLOWED_TOKEN_REFS.has(ref)) throw new Error('ghcrTokenEnv must be GHCR_TOKEN, GH_TOKEN, or GITHUB_TOKEN');
  const token = input.ghcrToken ?? env[ref];
  if (!token?.trim()) throw new Error('Missing GHCR credential in ' + ref);
  const { ghcrTokenEnv: _ref, ...config } = input;
  return { ...config, ghcrToken: token };
}

/** Persist only the reference. Raw input is retained in child memory for local compatibility. */
export function prepareGhcrConfig(input: GhcrConfigInput, env: NodeJS.ProcessEnv = process.env) {
  const resolved = resolveGhcrConfig(input, env);
  const { ghcrToken: token, ...config } = resolved;
  return { config: { ...config, ghcrTokenEnv: 'GHCR_TOKEN' }, env: { GHCR_TOKEN: token } };
}

export function executionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^CONVOY_MCP_.*TOKEN$/.test(name)));
}
