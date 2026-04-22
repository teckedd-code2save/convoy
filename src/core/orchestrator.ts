import type { ConvoyBus } from './bus.js';
import type { RunStateStore } from './state.js';
import {
  RehearsalBreachError,
  RollbackTriggeredError,
  type Stage,
  type StageContext,
  type OrchestratorOpts,
} from './stages.js';
import type { Run, RunStatus, StageName } from './types.js';

/**
 * Runs stages sequentially. Each stage's output becomes available to the next
 * via the `prior` map. Failures short-circuit the run and are recorded; the
 * caller is responsible for invoking medic or rollback in later revisions.
 */
export class Orchestrator {
  readonly #store: RunStateStore;
  readonly #bus: ConvoyBus;
  readonly #stages: readonly Stage[];

  constructor(store: RunStateStore, bus: ConvoyBus, stages: readonly Stage[]) {
    this.#store = store;
    this.#bus = bus;
    this.#stages = stages;
  }

  async run(repoUrl: string, opts: OrchestratorOpts): Promise<Run> {
    const created = this.#store.createRun(repoUrl, opts.planId ?? null);
    this.#bus.emit({ type: 'run.created', run: created });

    const started = this.#store.updateRun(created.id, { status: 'running' });
    this.#bus.emit({ type: 'run.updated', run: started });

    const controller = new AbortController();
    const prior: Record<string, unknown> = {};
    let currentStageName: StageName = this.#stages[0]?.name ?? 'scan';

    try {
      for (const stage of this.#stages) {
        currentStageName = stage.name;
        const latest = this.#store.getRun(started.id) ?? started;
        const ctx: StageContext = {
          run: latest,
          store: this.#store,
          bus: this.#bus,
          opts,
          prior,
          signal: controller.signal,
        };
        const output = await stage.run(ctx);
        prior[stage.name] = output;
      }

      const finished = this.#store.updateRun(started.id, {
        status: 'succeeded',
        completedAt: new Date(),
      });
      this.#bus.emit({ type: 'run.updated', run: finished });
      return finished;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isBreach = err instanceof RehearsalBreachError;
      const isRolledBack = err instanceof RollbackTriggeredError;

      // Rolled-back runs already set their own status + outcome before
      // throwing. Don't overwrite. Just record the failure event and return
      // the finalized run as-is.
      if (isRolledBack) {
        const failureEvent = this.#store.appendEvent(
          started.id,
          currentStageName,
          'failed',
          { error: message, reason: 'rollback_triggered', restored_version: err.restoredVersion },
        );
        this.#bus.emit({ type: 'event.appended', event: failureEvent });
        const finalized = this.#store.getRun(started.id);
        if (finalized) this.#bus.emit({ type: 'run.updated', run: finalized });
        return finalized ?? started;
      }

      const nextStatus: RunStatus = isBreach ? 'awaiting_fix' : 'failed';
      const outcomeReason = isBreach
        ? ((err.diagnosis as { rootCause?: string } | undefined)?.rootCause ?? message)
        : message;

      const failureEvent = this.#store.appendEvent(
        started.id,
        currentStageName,
        'failed',
        {
          error: message,
          ...(isBreach && { reason: 'rehearsal_breach', classification: (err.diagnosis as { classification?: string } | undefined)?.classification }),
        },
      );
      this.#bus.emit({ type: 'event.appended', event: failureEvent });

      const finalized = this.#store.updateRun(started.id, {
        status: nextStatus,
        completedAt: new Date(),
        outcomeReason,
      });
      this.#bus.emit({ type: 'run.updated', run: finalized });

      // Breach is a controlled pause — developer fixes and restarts.
      // Don't rethrow, callers shouldn't treat this as a crash.
      if (isBreach) return finalized;
      throw err;
    }
  }
}
