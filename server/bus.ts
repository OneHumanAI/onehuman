// SPDX-License-Identifier: BUSL-1.1
/**
 * In-process event bus so integrations can react the moment something happens:
 * an agent attaching to a session, or a decision being made. Served to browsers
 * and backends as Server-Sent Events by `/api/v1/stream`.
 */
import { EventEmitter } from 'node:events';
import type { Connection } from './connection.ts';

export type BusEvent =
  | { type: 'attach'; room: string; session: string; at: number; sinceStartMs: number; connection: Connection }
  | { type: 'decision'; room: string; session: string; at: number; id: string; resource: string; decision: string; actor: string; reasonCodes: string[] };

class Bus extends EventEmitter {
  publish(e: BusEvent) {
    this.emit('event', e);
  }
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);
