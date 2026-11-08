import fs from 'fs';
import path from 'path';
import type { Db, Queryable } from './db';

export type ScriptQueryable = Queryable & {
  exec(sql: string): Promise<void>;
};

export const ADVISORY_LOCK_ID = BigInt('723948192847192841');

export interface InternalScriptDb extends Db {
  transactionScript<T>(fn: (sq: ScriptQueryable) => Promise<T>): Promise<T>;
}

export async function migrate(db: Db): Promise<string[]> {
  const migrationsDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'db/migrations');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const scriptDb = db as InternalScriptDb;
  if (typeof scriptDb.transactionScript !== 'function') {
    throw new Error('Database instance does not support transactionScript');
  }

  return scriptDb.transactionScript(async (sq: ScriptQueryable) => {
    if (db.kind === 'pg') {
      await sq.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_ID})`);
    }

    await sq.exec(
      'create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())'
    );

    const res = await sq.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(res.rows.map((r) => r.name));
    const justApplied: string[] = [];

    for (const file of files) {
      if (!applied.has(file)) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await sq.exec(sql);
        await sq.query('insert into schema_migrations(name) values ($1)', [file]);
        justApplied.push(file);
      }
    }

    return justApplied;
  });
}
