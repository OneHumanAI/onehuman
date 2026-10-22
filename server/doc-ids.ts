// SPDX-License-Identifier: BUSL-1.1
/** Document ids for stores that are not SQL (server/fire-store.ts): any caller's id becomes a valid one. */
import { createHash } from 'node:crypto';

/** a document id from parts that may hold any character (ids cannot contain "/") */
export const docId = (...parts: (string | number)[]) => createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 40);

/** a caller's id as a document id: itself when it is a plain token, a hash otherwise (ids cannot hold "/", ".." or "__") */
export const safe = (id: string) => (/^[A-Za-z0-9_.:-]{1,200}$/.test(id) && !/^\.\.?$/.test(id) && !id.startsWith('__') ? id : docId(id));
