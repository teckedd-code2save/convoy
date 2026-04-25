import type { ConvoyBus } from './bus.js';
import type { RunStateStore } from './state.js';
import {
  RehearsalBreachError,
  RollbackTriggeredError,
  type Stage,
  type StageContext,
  type OrchestratorOpts,
} from './stages.js';
import type { Run, RunEvent, RunStatus, StageName } from './types.js';

/**
 * Runs stages sequentially. Each stage's output becomes available to the next
 * via the `prior` map. Failures short-circuit the run and are recorded; the
 * caller is responsible for invoking medic or rollback in later revisions.
 *
 * Continuation: when `opts.continueRunId` is set, the orchestrator reuses
 * that run row instead of creating a new one. Stages whose last event is
 * `finished` are skipped — their prior payload is replayed into the `prior`
 * map and a `skipped` event is appended so the timeline shows the truth.
 * The first stage whose last terminal event is `failed`/`started`/absent
 * runs from scratch, and everything after it follows normally. This is
 * what gives `convoy resume` its "sound memory" — successful stages are
 * not redone, and the run row stays the same so history is preserved.
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
    const continued = opts.continueRunId
      ? this.#prepareContinuation(opts.continueRunId)
      : null;

    const created = continued
      ? continued.run
      : this.#store.createRun(repoUrl, opts.planId ?? null);
    if (!continued) {
      this.#bus.emit({ type: 'run.created', run: created });
    } else {
      // Re-emit run.created so the renderer prints the banner + watch URL
      // for the continued run. The renderer can tell continuation from
      // first-attempt by reading the priorEvents we stash on opts (or via
      // a future flag); for now the banner is the same shape.
      this.#bus.emit({ type: 'run.created', run: created });
    }

    const started = this.#store.updateRun(created.id, {
      status: 'running',
      // Clear prior terminal markers so the run reads as live.
      // updateRun only sets fields explicitly listed, so we touch them all.
      completedAt: null,
      outcomeReason: null,
      outcomeRestoredVersion: null,
    });
    this.#bus.emit({ type: 'run.updated', run: started });

    const controller = new AbortController();
    const prior: Record<string, unknown> = {};
    let currentStageName: StageName = this.#stages[0]?.name ?? 'scan';

    // Build a per-stage "last terminal event" map once so each stage's
    // skip-or-replay decision is deterministic and based on history at the
    // start of THIS attempt (we don't want a stage we just skipped to look
    // skipped to a later stage's check).
    const priorTerminals = continued?.terminals ?? new Map<StageName, RunEvent>();

    try {
      for (const stage of this.#stages) {
        currentStageName = stage.name;

        const lastTerminal = priorTerminals.get(stage.name);
        if (lastTerminal && lastTerminal.kind === 'finished') {
          const skipped = this.#store.appendEvent(created.id, stage.name, 'skipped', {
            reason: 'already_finished_in_prior_attempt',
            replayed_from_event_id: lastTerminal.id,
            replayed_payload: lastTerminal.payload,
          });
          this.#bus.emit({ type: 'event.appended', event: skipped });
          prior[stage.name] = lastTerminal.payload;
          continue;
        }

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

  /**
   * Resolve the run row to continue and compute, for each stage, the most
   * recent terminal event (`finished` or `failed`). Stages with no terminal
   * event are absent from the map and will run from scratch.
   *
   * Throws when the runId can't be loaded — the caller (the CLI) should
   * have already validated the run is resumable; reaching here with an
   * unloadable id is a programmer error.
   */
  #prepareContinuation(runId: string): { run: Run; terminals: Map<StageName, RunEvent> } {
    const run = this.#store.getRun(runId);
    if (!run) {
      throw new Error(`continueRunId=${runId}: run not found in state store`);
    }
    const events = this.#store.listEvents(run.id);
    const terminals = new Map<StageName, RunEvent>();
    // Walk in chronological order; the last terminal we see per stage wins.
    for (const event of events) {
      if (event.kind === 'finished' || event.kind === 'failed') {
        terminals.set(event.stage, event);
      }
    }
    return { run, terminals };
  }
}
