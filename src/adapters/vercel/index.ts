import type { Platform } from '../../core/types.js';
import type {
  Adapter,
  Deployment,
  DeploymentConfig,
  EphemeralEnvironment,
  HealthResult,
  LogLine,
  RollbackResult,
} from '../types.js';

export class VercelAdapter implements Adapter {
  readonly platform: Platform = 'vercel';

  async deploy(_config: DeploymentConfig): Promise<Deployment> {
    throw new Error('VercelAdapter.deploy: not implemented');
  }

  async createEphemeral(_config: DeploymentConfig): Promise<EphemeralEnvironment> {
    throw new Error('VercelAdapter.createEphemeral: not implemented');
  }

  async destroyEphemeral(_id: string): Promise<void> {
    throw new Error('VercelAdapter.destroyEphemeral: not implemented');
  }

  async rollback(_deploymentId: string, _targetRelease?: string): Promise<RollbackResult> {
    throw new Error('VercelAdapter.rollback: not implemented');
  }

  async *readLogs(_deploymentId: string, _since?: Date): AsyncIterable<LogLine> {
    throw new Error('VercelAdapter.readLogs: not implemented');
  }

  async healthCheck(_deploymentId: string): Promise<HealthResult> {
    throw new Error('VercelAdapter.healthCheck: not implemented');
  }
}
