import { inject } from 'vitest';
import pg from 'pg';

export function pgTestUrl(): string {
  const url = (inject('databaseUrl') as string | undefined) || process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error('databaseUrl is not provided. Is the pg project running with vitest.pg-setup.ts?');
  }
  return url;
}

export async function freshPgDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = new URL(pgTestUrl());
  const dbName = `cadai_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const adminUrl = new URL(base.toString());
  adminUrl.pathname = '/postgres';
  const pool = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    await pool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await pool.end();
  }

  const freshUrl = new URL(base.toString());
  freshUrl.pathname = `/${dbName}`;

  return {
    url: freshUrl.toString(),
    drop: async () => {
      const dropPool = new pg.Pool({ connectionString: adminUrl.toString() });
      try {
        await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await dropPool.end();
      }
    },
  };
}
