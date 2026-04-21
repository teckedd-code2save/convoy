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

export class FlyAdapter implements Adapter {
  readonly platform: Platform = 'fly';

  async deploy(_config: DeploymentConfig): Promise<Deployment> {
    throw new Error('FlyAdapter.deploy: not implemented');
  }

  async createEphemeral(_config: DeploymentConfig): Promise<EphemeralEnvironment> {
    throw new Error('FlyAdapter.createEphemeral: not implemented');
  }

  async destroyEphemeral(_id: string): Promise<void> {
    throw new Error('FlyAdapter.destroyEphemeral: not implemented');
  }

  async rollback(_deploymentId: string, _targetRelease?: string): Promise<RollbackResult> {
    throw new Error('FlyAdapter.rollback: not implemented');
  }

  async *readLogs(_deploymentId: string, _since?: Date): AsyncIterable<LogLine> {
    throw new Error('FlyAdapter.readLogs: not implemented');
  }

  async healthCheck(_deploymentId: string): Promise<HealthResult> {
    throw new Error('FlyAdapter.healthCheck: not implemented');
  }
}
