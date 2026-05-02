import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    return await createLock(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }

  const pid = await readLockPid(lockPath);
  if (pid !== undefined && isProcessAlive(pid)) {
    throw new Error(`discord-bridge is already running with pid ${pid}`);
  }

  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  return createLock(lockPath);
}

async function createLock(lockPath: string): Promise<() => Promise<void>> {
  const handle = await open(lockPath, 'wx');

  try {
    await handle.writeFile(String(process.pid), 'utf8');
  } finally {
    await handle.close();
  }

  return async () => {
    const ownerPid = await readLockPid(lockPath);
    if (ownerPid !== process.pid) {
      return;
    }

    try {
      await unlink(lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  };
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const content = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      return false;
    }

    return true;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
