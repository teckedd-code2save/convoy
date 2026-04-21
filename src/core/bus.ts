import { EventEmitter } from 'node:events';

import type { Approval, Run, RunEvent } from './types.js';

export type ConvoyBusEvent =
  | { type: 'run.created'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'event.appended'; event: RunEvent }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.decided'; approval: Approval };

export type ConvoyBusListener = (event: ConvoyBusEvent) => void;

/**
 * Typed event bus used by stages, orchestrator, and UI surfaces (CLI, SSE).
 * Emits domain events; does not persist. State lives in RunStateStore.
 */
export class ConvoyBus {
  readonly #emitter = new EventEmitter();

  emit(event: ConvoyBusEvent): void {
    this.#emitter.emit('convoy', event);
  }

  subscribe(listener: ConvoyBusListener): () => void {
    this.#emitter.on('convoy', listener);
    return () => this.#emitter.off('convoy', listener);
  }
}
