// SPDX-License-Identifier: BUSL-1.1
/**
 * A test that has to reach past the store (tamper with a row, move a clock, count what is left) does it here, so the
 * same test runs on SQLite and on Firestore (tests/fire-setup.ts).
 */
import type { Store } from '../server/db.ts';
import { docId, safe } from '../server/doc-ids.ts';

type Fields = Record<string, string | number | null>;
/** the Firestore store (server/fire-store.ts) is not part of the engine: recognised by its shape, never imported */
type FireLike = Store & { db: { collection(name: string): any }; prefix: string };
const isFire = (s: Store): s is FireLike => typeof (s as Partial<FireLike>).prefix === 'string' && !!(s as Partial<FireLike>).db;
const fireDoc = (s: FireLike, table: string, id: string) => s.db.collection(s.prefix + table).doc(table === 'decisions' ? docId(id) : safe(id));

export async function getRow(store: Store, table: string, id: string): Promise<Fields | null> {
  if (isFire(store)) { const d = await fireDoc(store, table, id).get(); return d.exists ? (d.data() as Fields) : null; }
  return ((await store.exec(`SELECT * FROM ${table} WHERE id = ?`, [id])).rows[0] as Fields | undefined) ?? null;
}
export async function setRow(store: Store, table: string, id: string, fields: Fields): Promise<void> {
  if (isFire(store)) { await fireDoc(store, table, id).update(fields); return; }
  const cols = Object.keys(fields);
  await store.exec(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fields[c]!), id]);
}
export async function countRows(store: Store, table: string, column: string, value: string): Promise<number> {
  if (isFire(store)) return (await store.db.collection(store.prefix + table).where(column, '==', value).count().get()).data().count;
  return Number((await store.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [value])).rows[0]!.n);
}
