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

/**
 * VPS Adapter — thin shim over runner.ts. Most of the real work lives in
 * the orchestrator stages (CanaryStage, PromoteStage, ObserveStage), which
 * call into the runner directly with the operator-supplied VpsTarget.
 *
 * The Adapter interface is generic across platforms; for VPS we mostly
 * pass through to the runner. The interface methods stay throw-on-call
 * here because the stages bypass the adapter for VPS-specific blue/green
 * orchestration — same pattern as FlyAdapter, where the real work is in
 * src/adapters/fly/runner.ts.
 */
export class VpsAdapter implements Adapter {
  readonly platform: Platform = 'vps';

  async deploy(_config: DeploymentConfig): Promise<Deployment> {
    throw new Error('VpsAdapter.deploy: not implemented (stages drive runner directly)');
  }

  async createEphemeral(_config: DeploymentConfig): Promise<EphemeralEnvironment> {
    throw new Error('VpsAdapter.createEphemeral: not implemented');
  }

  async destroyEphemeral(_id: string): Promise<void> {
    throw new Error('VpsAdapter.destroyEphemeral: not implemented');
  }

  async rollback(_deploymentId: string, _targetRelease?: string): Promise<RollbackResult> {
    throw new Error('VpsAdapter.rollback: not implemented (stages drive runner directly)');
  }

  async *readLogs(_deploymentId: string, _since?: Date): AsyncIterable<LogLine> {
    throw new Error('VpsAdapter.readLogs: not implemented (stages drive runner directly)');
  }

  async healthCheck(_deploymentId: string): Promise<HealthResult> {
    throw new Error('VpsAdapter.healthCheck: not implemented');
  }
}
