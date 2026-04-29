import type { Platform } from '../core/types.js';

export interface DeploymentConfig {
  appName: string;
  region?: string;
  image?: string;
  env?: Record<string, string>;
  healthCheckPath?: string;
}

export interface Deployment {
  id: string;
  platform: Platform;
  url: string | null;
  release: string;
  createdAt: Date;
}

export interface EphemeralEnvironment {
  id: string;
  platform: Platform;
  url: string | null;
  appName: string;
  expiresAt: Date;
}

export interface LogLine {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

export interface HealthResult {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface RollbackResult {
  ok: boolean;
  restoredRelease: string;
  durationMs: number;
}

export interface PlatformCapability {
  cliAvailable: boolean;
  authenticated: boolean;
  projectLinked: boolean;
  rollbackReady: boolean;
}

export interface ConnectionStatus {
  platform: Platform;
  cliAvailable: boolean;
  authenticated: boolean;
  projectLinked: boolean;
  rollbackReady: boolean;
  account?: string;
  projectBinding?: string;
  envKeys: string[];
  recommendedRemedy?: string;
  raw?: Record<string, unknown>;
}

/**
 * Every platform adapter implements this interface.
 * agent-core is platform-neutral; platform specifics live behind this seam.
 */
export interface Adapter {
  readonly platform: Platform;

  deploy(config: DeploymentConfig): Promise<Deployment>;

  createEphemeral(config: DeploymentConfig): Promise<EphemeralEnvironment>;
  destroyEphemeral(id: string): Promise<void>;

  rollback(deploymentId: string, targetRelease?: string): Promise<RollbackResult>;

  readLogs(deploymentId: string, since?: Date): AsyncIterable<LogLine>;

  healthCheck(deploymentId: string): Promise<HealthResult>;
}
