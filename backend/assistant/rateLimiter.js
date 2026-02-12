/**
 * Tiny in-memory fixed-window rate limiter for low-cost API protection.
 */

const createMemoryRateLimiter = ({ windowMs = 60_000, max = 60, maxKeys = 20_000 } = {}) => {
  const safeWindowMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 60_000;
  const safeMax = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 60;
  const safeMaxKeys =
    Number.isFinite(Number(maxKeys)) && Number(maxKeys) >= 100 ? Number(maxKeys) : 20_000;
  const store = new Map();

  const prune = (nowMs) => {
    if (store.size <= safeMaxKeys) return;
    for (const [key, entry] of store.entries()) {
      if (!entry || nowMs - Number(entry.windowStart || 0) >= safeWindowMs * 2) {
        store.delete(key);
      }
      if (store.size <= safeMaxKeys) break;
    }
  };

  const consume = (rawKey) => {
    const key = String(rawKey || '').trim();
    if (!key) return false;
    const nowMs = Date.now();
    prune(nowMs);
    const existing = store.get(key);
    if (!existing || nowMs - Number(existing.windowStart || 0) >= safeWindowMs) {
      store.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (existing.count >= safeMax) {
      return false;
    }
    existing.count += 1;
    store.set(key, existing);
    return true;
  };

  const snapshot = () => ({
    windowMs: safeWindowMs,
    max: safeMax,
    keys: store.size,
  });

  return { consume, snapshot };
};

export { createMemoryRateLimiter };
