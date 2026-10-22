// SPDX-License-Identifier: BUSL-1.1
/**
 * Hash-chained audit log for decisions.
 *
 * Each decision hashes its own body together with the previous decision's
 * hash. Editing or deleting a row breaks every later hash. This detects
 * tampering; it does not prevent it. Production needs a separately protected
 * checkpoint (WORM storage or an external anchor) and access control.
 */
import { createHash } from 'node:crypto';
import type { DecisionRow, Store } from './db.ts';

/**
 * Canonical JSON: object keys sorted at every level, arrays in order, undefined dropped, non-finite numbers as null.
 * For the values a decision holds (strings, finite numbers, booleans, null, arrays, objects) this is the RFC 8785
 * serialisation. v1 used JSON.stringify's key-array replacer, which filters keys at every level and so left the
 * nested evidence (assessment.reasons, metrics, version) out of the hash.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

const V2 = 'v2:';

/** The chain hash of one decision. New rows are v2 (`v2:` + hex, the whole body); v1 rows still verify as they were written. */
export function hashDecision(prevHash: string, body: Omit<DecisionRow, 'prevHash' | 'hash'>, version: 1 | 2 = 2): string {
  if (version === 1) {
    const legacy = JSON.stringify(body, Object.keys(body).sort());
    return createHash('sha256').update(prevHash).update('\n').update(legacy).digest('hex');
  }
  return V2 + createHash('sha256').update(prevHash).update('\n').update(canonical(body)).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isConflict = (e: unknown) => /UNIQUE|constraint/i.test(String((e as Error)?.message ?? e));

/**
 * One append without the in-process queue: read the head, hash, insert; on a (room, seq) conflict, another writer
 * got there first (a parallel request on another instance), so read the new head and try again. Exported for the
 * test that plays two instances.
 */
export async function appendDecisionOnce(store: Store, body: Omit<DecisionRow, 'prevHash' | 'hash'>, seal?: (row: DecisionRow, seq: number) => string): Promise<DecisionRow & { seq: number; proof: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const last = await store.lastDecision(body.room);
    const hash = hashDecision(last.hash, body);
    const row: DecisionRow = { ...body, prevHash: last.hash, hash };
    const seq = last.seq + 1;
    const proof = seal ? seal(row, seq) : null;
    try {
      await store.insertDecision(row, seq, proof);
      return { ...row, seq, proof };
    } catch (e) {
      if (attempt >= 12 || !isConflict(e)) throw e;
      await sleep(2 + Math.random() * 8 * (attempt + 1));
    }
  }
}

/** Appends to one room's chain run one after another in this process; across processes the unique (room, seq) index and the retry keep the chain whole. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Append a decision to its room's chain. With a `seal`, the decision is also signed (see proof.ts): the
 * proof covers the row's chain hash, so it is made after hashing and stored in the same insert.
 */
export function appendDecision(store: Store, body: Omit<DecisionRow, 'prevHash' | 'hash'>, seal?: (row: DecisionRow, seq: number) => string): Promise<DecisionRow & { seq: number; proof: string | null }> {
  const before = queues.get(body.room) ?? Promise.resolve();
  const run = before.then(() => appendDecisionOnce(store, body, seal));
  const tail = run.then(() => undefined, () => undefined);
  queues.set(body.room, tail);
  void tail.then(() => { if (queues.get(body.room) === tail) queues.delete(body.room); });
  return run;
}

export type ChainReport = { ok: boolean; checked: number; brokenAt: number | null };

export async function verifyChain(store: Store, room: string): Promise<ChainReport> {
  const rows = (await store.listDecisions(room, 100000)).sort((a, b) => a.seq - b.seq);
  let prev = 'genesis';
  let lastSeq = 0;
  for (const r of rows) {
    const { prevHash, hash, seq, ...body } = r;
    if (seq !== lastSeq + 1 || prevHash !== prev) return { ok: false, checked: rows.length, brokenAt: seq };
    if (hashDecision(prev, body, hash.startsWith(V2) ? 2 : 1) !== hash) return { ok: false, checked: rows.length, brokenAt: seq };
    prev = hash;
    lastSeq = seq;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
