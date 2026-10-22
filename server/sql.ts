// SPDX-License-Identifier: BUSL-1.1
/**
 * Tiny SQL client abstraction so the same SQLite-dialect store runs on
 *   - node:sqlite (local file or in-memory; dev, tests, self-hosted)
 *   - libSQL / Turso over HTTP (serverless deployments such as Vercel)
 */
export type Row = Record<string, unknown>;
export type SqlResult = { rows: Row[]; rowsAffected: number; lastInsertRowid: number | null };
export type SqlArg = string | number | bigint | boolean | null | undefined;

export interface SqlClient {
  execute(sql: string, args?: SqlArg[]): Promise<SqlResult>;
  batch(stmts: { sql: string; args?: SqlArg[] }[]): Promise<void>;
  executeMultiple(sql: string): Promise<void>;
  close(): void;
}

const norm = (args: SqlArg[] = []) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));

/** node:sqlite client. Loaded lazily so serverless bundles never touch node:sqlite. */
export async function sqliteClient(path = ':memory:'): Promise<SqlClient> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const isQuery = (sql: string) => /^\s*(select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
  return {
    async execute(sql, args) {
      const stmt = db.prepare(sql);
      if (isQuery(sql)) return { rows: stmt.all(...(norm(args) as never[])) as Row[], rowsAffected: 0, lastInsertRowid: null };
      const r = stmt.run(...(norm(args) as never[]));
      return { rows: [], rowsAffected: Number(r.changes), lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...(norm(s.args) as never[]));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async executeMultiple(sql) { db.exec(sql); },
    close() { db.close(); },
  };
}

/** libSQL (Turso) over HTTP. */
export async function libsqlClient(url: string, authToken?: string): Promise<SqlClient> {
  const { createClient } = await import('@libsql/client/web');
  const c = createClient({ url, authToken });
  const toRows = (rs: { rows: ArrayLike<Row>; columns: string[] }): Row[] => Array.from(rs.rows, (r) => { const o: Row = {}; for (const col of rs.columns) o[col] = (r as Row)[col]; return o; });
  return {
    async execute(sql, args) {
      const rs = await c.execute({ sql, args: norm(args) as never[] });
      return { rows: toRows(rs), rowsAffected: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
    },
    async batch(stmts) { await c.batch(stmts.map((s) => ({ sql: s.sql, args: norm(s.args) as never[] })), 'write'); },
    async executeMultiple(sql) { await c.executeMultiple(sql); },
    close() { c.close(); },
  };
}

/** Pick a client from the environment: TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) or a local sqlite path. */
export async function clientFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ client: SqlClient; kind: 'libsql' | 'sqlite'; label: string }> {
  const url = env.TURSO_DATABASE_URL || env.LIBSQL_URL;
  if (url) return { client: await libsqlClient(url, env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN), kind: 'libsql', label: url.replace(/\?.*$/, '') };
  const path = env.ONEHUMAN_DB ?? 'data/lab.db';
  return { client: await sqliteClient(path), kind: 'sqlite', label: path };
}
