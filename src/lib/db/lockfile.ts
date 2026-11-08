import * as fs from 'fs';
import * as path from 'path';

function tryCreateLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, String(process.pid), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const readBack = fs.readFileSync(lockPath, 'utf8').trim();
    if (readBack !== String(process.pid)) {
      throw new Error(`Lock file verification failed: expected ${process.pid}, got ${readBack}`);
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

export function acquireLock(dir: string): () => void {
  const lockPath = path.join(dir, '.cadai-lock');

  if (!tryCreateLock(lockPath)) {
    let existingPid: number | undefined;
    try {
      const content = fs.readFileSync(lockPath, 'utf8').trim();
      existingPid = parseInt(content, 10);
    } catch {
      // File may have been removed concurrently
    }

    let isStale = false;
    if (existingPid === undefined || Number.isNaN(existingPid) || existingPid === process.pid) {
      isStale = true;
    } else {
      try {
        process.kill(existingPid, 0);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          isStale = true;
        }
      }
    }

    if (isStale) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
      if (!tryCreateLock(lockPath)) {
        let secondPid: number | undefined;
        try {
          const content = fs.readFileSync(lockPath, 'utf8').trim();
          secondPid = parseInt(content, 10);
        } catch {
          // ignore
        }
        throw new Error(
          `The local database is already open in another process (pid ${secondPid ?? 'unknown'}).`
        );
      }
    } else {
      throw new Error(
        `The local database is already open in another process (pid ${existingPid}).`
      );
    }
  }

  return () => {
    try {
      if (fs.existsSync(lockPath)) {
        const content = fs.readFileSync(lockPath, 'utf8').trim();
        if (content === String(process.pid)) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // ignore
    }
  };
}
