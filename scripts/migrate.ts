import path from 'path';
import { fileURLToPath } from 'url';
import { createPgDb } from '@/lib/db/pg';
import { migrate } from '@/lib/db/migrate';

export type MigrateEnv = Record<string, string | undefined>;
export type MigrateLogger = (message: string) => void;

export async function runMigrateCli(
  env: MigrateEnv = process.env,
  log: MigrateLogger = console.log
): Promise<string[]> {
  const rawUrl = env.DATABASE_URL_MIGRATE;
  const url = rawUrl?.trim();
  if (!url) {
    throw new Error('DATABASE_URL_MIGRATE is not set.');
  }

  const db = createPgDb(url, { max: 1 });
  try {
    const applied = await migrate(db);
    if (applied.length === 0) {
      log('no pending migrations');
    } else {
      for (const file of applied) {
        log(`applied ${file}`);
      }
    }
    return applied;
  } finally {
    await db.close();
  }
}

const isDirectExecution = (): boolean => {
  if (typeof process === 'undefined' || !process.argv?.[1]) {
    return false;
  }
  if (typeof require !== 'undefined' && require.main === module) {
    return true;
  }
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
  return false;
};

if (isDirectExecution()) {
  runMigrateCli().catch((err: unknown) => {
    process.exitCode = 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`migrate failed: ${message}`);
  });
}
