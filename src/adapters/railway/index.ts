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

export class RailwayAdapter implements Adapter {
  readonly platform: Platform = 'railway';

  async deploy(_config: DeploymentConfig): Promise<Deployment> {
    throw new Error('RailwayAdapter.deploy: not implemented');
  }

  async createEphemeral(_config: DeploymentConfig): Promise<EphemeralEnvironment> {
    throw new Error('RailwayAdapter.createEphemeral: not implemented');
  }

  async destroyEphemeral(_id: string): Promise<void> {
    throw new Error('RailwayAdapter.destroyEphemeral: not implemented');
  }

  async rollback(_deploymentId: string, _targetRelease?: string): Promise<RollbackResult> {
    throw new Error('RailwayAdapter.rollback: not implemented');
  }

  async *readLogs(_deploymentId: string, _since?: Date): AsyncIterable<LogLine> {
    throw new Error('RailwayAdapter.readLogs: not implemented');
  }

  async healthCheck(_deploymentId: string): Promise<HealthResult> {
    throw new Error('RailwayAdapter.healthCheck: not implemented');
  }
}
