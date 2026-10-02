import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// bigint columns come back as JS numbers; balances stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Q = Db | Tx;

export function makePool(dsn = process.env.DATABASE_URL ?? 'postgresql:///hermescity?host=/var/run/postgresql'): Db {
  return new pg.Pool({ connectionString: dsn, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const out = await fn(tx);
    await tx.query('commit');
    return out;
  } catch (e) {
    await tx.query('rollback').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export async function migrate(db: Db): Promise<void> {
  await db.query('create table if not exists schema_migrations (name text primary key, at timestamptz default now())');
  const done = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await withTx(db, async (tx) => {
      await tx.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
      await tx.query('insert into schema_migrations (name) values ($1)', [f]);
    });
  }
}
