import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Thin database facade over a `pg`-compatible driver.
 *
 * Two interchangeable backends, identical SQL:
 *   - Real Postgres / Supabase, when DATABASE_URL is set.
 *   - In-memory Postgres (pg-mem), otherwise — so the project runs with zero
 *     external setup for the demo and for reviewers.
 *
 * The only behavioural difference we care about is row-level locking: real
 * Postgres supports `FOR UPDATE SKIP LOCKED` (needed for a horizontally
 * scalable job queue); pg-mem is single-process so locking is a no-op. We
 * expose `supportsSkipLocked` and let the job repository pick the right query.
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a function inside a transaction; rolls back on throw. */
  tx<T>(fn: (client: Db) => Promise<T>): Promise<T>;
  supportsSkipLocked: boolean;
  backend: 'postgres' | 'pg-mem';
  close(): Promise<void>;
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  if (singleton) return singleton;
  singleton = config.databaseUrl ? await createPostgres(config.databaseUrl) : await createPgMem();
  log.info('db.ready', { backend: singleton.backend });
  return singleton;
}

async function createPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10 });

  const wrap = (runner: { query: Function }): Db => ({
    backend: 'postgres',
    supportsSkipLocked: true,
    async query(sql, params) {
      const res = await runner.query(sql, params as any[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  });

  return wrap(pool);
}

async function createPgMem(): Promise<Db> {
  const { newDb, DataType } = await import('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // Functions the provided schema relies on that pg-mem doesn't ship natively.
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  mem.public.registerFunction({
    name: 'left',
    args: [DataType.text, DataType.integer],
    returns: DataType.text,
    implementation: (s: string | null, n: number) => (s == null ? null : s.slice(0, n)),
  });
  mem.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (s: string | null) => (s == null ? null : s.length),
  });

  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();

  const wrap = (runner: { query: Function }): Db => ({
    backend: 'pg-mem',
    supportsSkipLocked: false,
    async query(sql, params) {
      const res = await runner.query(sql, params as any[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async tx(fn) {
      // pg-mem is single-process; a logical transaction is sufficient and keeps
      // the same call shape as Postgres.
      await runner.query('BEGIN');
      try {
        const out = await fn(wrap(runner));
        await runner.query('COMMIT');
        return out;
      } catch (err) {
        await runner.query('ROLLBACK');
        throw err;
      }
    },
    async close() {
      /* in-memory: nothing to close */
    },
  });

  return wrap(pool);
}
