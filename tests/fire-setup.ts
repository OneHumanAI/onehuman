// SPDX-License-Identifier: BUSL-1.1
/**
 * The whole suite on Firestore: `npm run test:firestore` starts the Firestore emulator and loads this file first.
 * Every store a test opens without a SQL client of its own becomes a Firestore store with collections of its own, so
 * the tests that pass on SQLite must pass, unchanged, on the database production runs on.
 */
import { Firestore } from '@google-cloud/firestore';
import { Store, SERVER_LIMITS, type StoreLimits } from '../server/db.ts';
import { SiteStore, LAB_LIMITS } from '../server/site-db.ts';
import { FireSiteStore } from '../server/fire-store.ts';
import type { SqlClient } from '../server/sql.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const db = new Firestore({ projectId: 'onehuman-test', ignoreUndefinedProperties: true });
  const sqlSite = SiteStore.open.bind(SiteStore);
  const sqlEngine = Store.open.bind(Store);
  let n = 0;
  const fresh = (limits: StoreLimits) => FireSiteStore.connect(db, { prefix: `t${process.pid}_${++n}_`, limits });
  SiteStore.open = (async (client?: SqlClient, opts: { migrate?: boolean; limits?: StoreLimits } = {}) => (client ? sqlSite(client, opts) : fresh(opts.limits ?? LAB_LIMITS))) as typeof SiteStore.open;
  Store.open = (async (client?: SqlClient, opts: { migrate?: boolean; limits?: StoreLimits } = {}) => (client ? sqlEngine(client, opts) : fresh(opts.limits ?? SERVER_LIMITS))) as typeof Store.open;
}
