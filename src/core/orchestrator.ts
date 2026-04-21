import type { ConvoyBus } from './bus.js';
import type { RunStateStore } from './state.js';
import type { Stage, StageContext, OrchestratorOpts } from './stages.js';
import type { Run, StageName } from './types.js';

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
    const created = this.#store.createRun(repoUrl);
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
      const failureEvent = this.#store.appendEvent(
        started.id,
        currentStageName,
        'failed',
        { error: message },
      );
      this.#bus.emit({ type: 'event.appended', event: failureEvent });

      const failed = this.#store.updateRun(started.id, {
        status: 'failed',
        completedAt: new Date(),
      });
      this.#bus.emit({ type: 'run.updated', run: failed });
      throw err;
    }
  }
}
