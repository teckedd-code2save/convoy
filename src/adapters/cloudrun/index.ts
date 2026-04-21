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

export class CloudRunAdapter implements Adapter {
  readonly platform: Platform = 'cloudrun';

  async deploy(_config: DeploymentConfig): Promise<Deployment> {
    throw new Error('CloudRunAdapter.deploy: not implemented');
  }

  async createEphemeral(_config: DeploymentConfig): Promise<EphemeralEnvironment> {
    throw new Error('CloudRunAdapter.createEphemeral: not implemented');
  }

  async destroyEphemeral(_id: string): Promise<void> {
    throw new Error('CloudRunAdapter.destroyEphemeral: not implemented');
  }

  async rollback(_deploymentId: string, _targetRelease?: string): Promise<RollbackResult> {
    throw new Error('CloudRunAdapter.rollback: not implemented');
  }

  async *readLogs(_deploymentId: string, _since?: Date): AsyncIterable<LogLine> {
    throw new Error('CloudRunAdapter.readLogs: not implemented');
  }

  async healthCheck(_deploymentId: string): Promise<HealthResult> {
    throw new Error('CloudRunAdapter.healthCheck: not implemented');
  }
}
