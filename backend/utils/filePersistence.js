import fs from 'fs/promises';
import path from 'path';

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });

const isLockBusyError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  return code === 'EEXIST' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
};

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const normalizeRetryOptions = (retry = {}) => ({
  attempts: toPositiveInt(retry?.attempts, 80, 1, 10_000),
  baseDelayMs: toPositiveInt(retry?.baseDelayMs, 12, 1, 10_000),
  maxDelayMs: toPositiveInt(retry?.maxDelayMs, 180, 1, 10_000),
  staleMs: toPositiveInt(retry?.staleMs, 60_000, 1_000, 10 * 60_000),
});

export const withFileLock = async (lockPath, task, options = {}) => {
  if (typeof task !== 'function') {
    throw new TypeError('withFileLock requires a task function.');
  }
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    return task();
  }
  const safeLockPath = lockPath.trim();
  const retry = normalizeRetryOptions(options.retry);
  await fs.mkdir(path.dirname(safeLockPath), { recursive: true });

  let handle = null;
  let lastError = null;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      handle = await fs.open(safeLockPath, 'wx');
      break;
    } catch (error) {
      lastError = error;
      if (!isLockBusyError(error)) {
        throw error;
      }
      try {
        const stat = await fs.stat(safeLockPath);
        const ageMs = Date.now() - Number(stat?.mtimeMs || 0);
        if (ageMs > retry.staleMs) {
          await fs.unlink(safeLockPath).catch(() => undefined);
        }
      } catch {
        // ignore stat/unlink race
      }
      const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * (attempt + 1));
      await sleep(delay);
    }
  }

  if (!handle) {
    throw lastError || new Error(`lock_acquire_failed:${safeLockPath}`);
  }

  try {
    return await task();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore close error
    }
    await fs.unlink(safeLockPath).catch(() => undefined);
  }
};

export const atomicWriteFile = async (targetPath, payload, options = {}) => {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('atomicWriteFile requires a target path.');
  }
  const safeTargetPath = targetPath.trim();
  const encoding = Object.prototype.hasOwnProperty.call(options, 'encoding')
    ? options.encoding
    : 'utf-8';
  const lockPath =
    typeof options?.lockPath === 'string' && options.lockPath.trim()
      ? options.lockPath.trim()
      : '';
  const retry = normalizeRetryOptions(options.retry);
  const tempPath = `${safeTargetPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await fs.mkdir(path.dirname(safeTargetPath), { recursive: true });

  const writeOp = async () => {
    await fs.writeFile(tempPath, payload, encoding ? { encoding } : undefined);
    await fs.rename(tempPath, safeTargetPath);
  };

  let lastError = null;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      if (lockPath) {
        await withFileLock(lockPath, writeOp, { retry });
      } else {
        await writeOp();
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isLockBusyError(error)) {
        break;
      }
      const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * (attempt + 1));
      await sleep(delay);
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }

  throw lastError || new Error(`atomic_write_failed:${safeTargetPath}`);
};

export const createSerialQueue = ({
  maxPending = Number.MAX_SAFE_INTEGER,
  overflowError = 'queue_overflow',
} = {}) => {
  const safeMaxPending = toPositiveInt(maxPending, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  let tail = Promise.resolve();
  let pending = 0;
  let dropped = 0;

  const enqueue = (task) => {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Queue task must be a function.'));
    }
    if (pending >= safeMaxPending) {
      dropped += 1;
      return Promise.reject(new Error(overflowError));
    }
    pending += 1;
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run.finally(() => {
      pending = Math.max(0, pending - 1);
    });
  };

  const stats = () => ({
    pending,
    dropped,
    maxPending: safeMaxPending,
  });

  return { enqueue, stats };
};

