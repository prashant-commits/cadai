import type { TestProject } from 'vitest/node';
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'fs';
import path from 'path';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.DATABASE_URL_TEST) {
    const url = process.env.DATABASE_URL_TEST;
    project.provide('databaseUrl', url);
    return async () => {};
  }

  const repo = path.resolve(__dirname);
  const dataDir = path.join(repo, '.cadai/pg-test/data');
  const sockDir = path.join(repo, '.cadai/pg-test/sock');
  fs.mkdirSync(sockDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // ignore
    }
  }

  const epg = new EmbeddedPostgres({
    databaseDir: dataDir,
    postgresFlags: ['-c', `unix_socket_directories=${sockDir}`],
    port: 54329,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    onLog: () => {},
  });

  const versionFile = path.join(dataDir, 'PG_VERSION');
  if (!fs.existsSync(versionFile)) {
    await epg.initialise();
  }

  await epg.start();

  const client = epg.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  try {
    await client.query('DROP DATABASE IF EXISTS cadai_test WITH (FORCE)');
    await client.query('CREATE DATABASE cadai_test');
  } finally {
    await client.end();
  }

  const url = 'postgres://postgres:postgres@127.0.0.1:54329/cadai_test';
  project.provide('databaseUrl', url);
  process.env.DATABASE_URL_TEST = url;

  return async () => {
    await epg.stop();
  };
}
