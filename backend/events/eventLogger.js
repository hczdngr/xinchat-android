/**
 * Unified event logging:
 * - Feature gating and graceful degradation
 * - Global rate limit and global aggregation via Redis (when REDIS_URL is configured)
 * - Durable local fallback with state persistence and file rotation
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isFeatureEnabled, parseBooleanEnv } from '../featureFlags.js';
import { logger, metrics, serializeError } from '../observability.js';
import { normalizeEventType, sanitizeArray, sanitizeText } from './eventTypes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_LOG_PATH = path.join(DATA_DIR, 'event-log.ndjson');
const DEFAULT_ARCHIVE_DIR = path.join(DATA_DIR, 'event-log-archive');
const DEFAULT_STATE_PATH = path.join(DATA_DIR, 'event-log-state.json');

const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const EVENT_STATS_FIELDS = Object.freeze([
  'accepted',
  'droppedDisabled',
  'droppedInvalid',
  'droppedRateLimited',
  'droppedQueueOverflow',
  'flushed',
  'writeErrors',
  'loggerErrors',
  'rotationCount',
  'lastEnqueuedAt',
  'lastFlushedAt',
  'lastErrorAt',
  'lastRotatedAt',
]);

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const EVENT_LOG_PATH = String(process.env.EVENT_LOG_PATH || '').trim() || DEFAULT_LOG_PATH;
const EVENT_LOG_ARCHIVE_DIR =
  String(process.env.EVENT_LOG_ARCHIVE_DIR || '').trim() || DEFAULT_ARCHIVE_DIR;
const EVENT_LOG_STATE_PATH =
  String(process.env.EVENT_LOG_STATE_PATH || '').trim() || DEFAULT_STATE_PATH;

const EVENT_LOG_QUEUE_MAX = toPositiveInt(process.env.EVENT_LOG_QUEUE_MAX, 5000, 100, 200000);
const EVENT_LOG_FLUSH_INTERVAL_MS = toPositiveInt(
  process.env.EVENT_LOG_FLUSH_INTERVAL_MS,
  400,
  20,
  60_000
);
const EVENT_LOG_FLUSH_BATCH_SIZE = toPositiveInt(
  process.env.EVENT_LOG_FLUSH_BATCH_SIZE,
  200,
  1,
  2000
);
const EVENT_LOG_WRITE_TIMEOUT_MS = toPositiveInt(
  process.env.EVENT_LOG_WRITE_TIMEOUT_MS,
  2000,
  200,
  60_000
);
const EVENT_LOG_WRITE_RETRIES = toPositiveInt(process.env.EVENT_LOG_WRITE_RETRIES, 2, 0, 10);
const EVENT_LOG_RETRY_BACKOFF_MS = toPositiveInt(
  process.env.EVENT_LOG_RETRY_BACKOFF_MS,
  120,
  10,
  10_000
);

const EVENT_LOG_ROTATE_ENABLED = parseBooleanEnv(process.env.EVENT_LOG_ROTATE_ENABLED, true);
const EVENT_LOG_ROTATE_MAX_BYTES = toPositiveInt(
  process.env.EVENT_LOG_ROTATE_MAX_BYTES,
  20 * 1024 * 1024,
  1024 * 128,
  1024 * 1024 * 1024
);
const EVENT_LOG_ROTATE_MAX_FILES = toPositiveInt(
  process.env.EVENT_LOG_ROTATE_MAX_FILES,
  24,
  1,
  3650
);
const EVENT_LOG_ROTATE_CHECK_INTERVAL_MS = toPositiveInt(
  process.env.EVENT_LOG_ROTATE_CHECK_INTERVAL_MS,
  1000,
  50,
  60_000
);
const EVENT_LOG_ROTATE_LOCK_MS = toPositiveInt(
  process.env.EVENT_LOG_ROTATE_LOCK_MS,
  30_000,
  1000,
  300_000
);

const EVENT_LOG_RATE_WINDOW_MS = toPositiveInt(
  process.env.EVENT_LOG_RATE_WINDOW_MS,
  60_000,
  1_000,
  3_600_000
);
const EVENT_LOG_RATE_MAX = toPositiveInt(process.env.EVENT_LOG_RATE_MAX, 120, 1, 50_000);

const EVENT_LOG_STATE_FLUSH_INTERVAL_MS = toPositiveInt(
  process.env.EVENT_LOG_STATE_FLUSH_INTERVAL_MS,
  1000,
  50,
  60_000
);
const EVENT_LOG_REDIS_TIMEOUT_MS = toPositiveInt(
  process.env.EVENT_LOG_REDIS_TIMEOUT_MS,
  180,
  30,
  5000
);
const EVENT_LOG_REDIS_RETRY_BACKOFF_MS = toPositiveInt(
  process.env.EVENT_LOG_REDIS_RETRY_BACKOFF_MS,
  5000,
  100,
  300_000
);

const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const EVENT_REDIS_PREFIX =
  String(process.env.EVENT_REDIS_PREFIX || 'xinchat:event:')
    .trim()
    .toLowerCase() || 'xinchat:event:';
const REDIS_STATS_KEY = `${EVENT_REDIS_PREFIX}stats`;
const REDIS_STREAM_KEY = `${EVENT_REDIS_PREFIX}stream`;
const REDIS_RATE_PREFIX = `${EVENT_REDIS_PREFIX}rate:`;
const REDIS_ROTATE_LOCK_KEY = `${EVENT_REDIS_PREFIX}rotate-lock`;

const INSTANCE_ID =
  sanitizeText(
    String(process.env.EVENT_LOG_INSTANCE_ID || `${os.hostname()}-${process.pid}`),
    80
  ) || `node-${process.pid}`;

const runtime = {
  queue: [],
  flushTimer: null,
  flushing: false,
  rateMap: new Map(),
  lastRotateCheckAt: 0,
  localRotateInFlight: null,
  stateFlushTimer: null,
  stateWriteChain: Promise.resolve(),
  stateLoaded: false,
  stateLoadPromise: null,
  stats: {
    accepted: 0,
    droppedDisabled: 0,
    droppedInvalid: 0,
    droppedRateLimited: 0,
    droppedQueueOverflow: 0,
    flushed: 0,
    writeErrors: 0,
    loggerErrors: 0,
    rotationCount: 0,
    lastEnqueuedAt: '',
    lastFlushedAt: '',
    lastErrorAt: '',
    lastRotatedAt: '',
  },
  redis: {
    client: null,
    connectInFlight: null,
    nextRetryAtMs: 0,
    unavailableLogged: false,
    runtimeErrorLogged: false,
  },
};

const nowIso = () => new Date().toISOString();

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timeout_${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });

const markRedisUnavailable = (error) => {
  if (runtime.redis.unavailableLogged) return;
  runtime.redis.unavailableLogged = true;
  logger.warn('Event logger redis unavailable, fallback to local mode', {
    error: serializeError(error),
  });
};

const markRedisRuntimeError = (error) => {
  if (runtime.redis.runtimeErrorLogged) return;
  runtime.redis.runtimeErrorLogged = true;
  logger.warn('Event logger redis runtime error, fallback to local behavior', {
    error: serializeError(error),
  });
};

const getRedisClient = async () => {
  if (!REDIS_URL) return null;
  if (Date.now() < Number(runtime.redis.nextRetryAtMs || 0)) return null;
  if (runtime.redis.client?.isOpen) return runtime.redis.client;
  if (runtime.redis.connectInFlight) return runtime.redis.connectInFlight;

  runtime.redis.connectInFlight = (async () => {
    try {
      const redisModule = await import('redis');
      const client = redisModule.createClient({ url: REDIS_URL });
      client.on('error', (error) => {
        markRedisRuntimeError(error);
      });
      await withTimeout(client.connect(), EVENT_LOG_REDIS_TIMEOUT_MS);
      runtime.redis.nextRetryAtMs = 0;
      runtime.redis.unavailableLogged = false;
      runtime.redis.runtimeErrorLogged = false;
      runtime.redis.client = client;
      return client;
    } catch (error) {
      markRedisUnavailable(error);
      runtime.redis.nextRetryAtMs = Date.now() + EVENT_LOG_REDIS_RETRY_BACKOFF_MS;
      return null;
    } finally {
      runtime.redis.connectInFlight = null;
    }
  })();

  return runtime.redis.connectInFlight;
};

const sanitizeMetadata = (value, depth = 0) => {
  if (depth > 3) return '[depth_limit]';
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeText(value, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    Object.entries(value)
      .slice(0, 30)
      .forEach(([key, entry]) => {
        const safeKey = sanitizeText(String(key || ''), 60);
        if (!safeKey) return;
        output[safeKey] = sanitizeMetadata(entry, depth + 1);
      });
    return output;
  }
  return sanitizeText(String(value || ''), 200);
};

const toUid = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const stateTemplate = () => ({
  accepted: 0,
  droppedDisabled: 0,
  droppedInvalid: 0,
  droppedRateLimited: 0,
  droppedQueueOverflow: 0,
  flushed: 0,
  writeErrors: 0,
  loggerErrors: 0,
  rotationCount: 0,
  lastEnqueuedAt: '',
  lastFlushedAt: '',
  lastErrorAt: '',
  lastRotatedAt: '',
});

const mergeStats = (source = {}) => {
  const next = { ...stateTemplate() };
  EVENT_STATS_FIELDS.forEach((field) => {
    if (field.startsWith('last')) {
      next[field] = typeof source[field] === 'string' ? source[field] : '';
      return;
    }
    const parsed = Number(source[field]);
    next[field] = Number.isFinite(parsed) ? parsed : 0;
  });
  return next;
};

const ensureLocalStateLoaded = async () => {
  if (runtime.stateLoaded) return;
  if (runtime.stateLoadPromise) {
    await runtime.stateLoadPromise;
    return;
  }
  runtime.stateLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(EVENT_LOG_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      runtime.stats = mergeStats(parsed?.stats || parsed || {});
    } catch {
      runtime.stats = mergeStats(runtime.stats);
    } finally {
      runtime.stateLoaded = true;
      runtime.stateLoadPromise = null;
    }
  })();
  await runtime.stateLoadPromise;
};

const persistLocalState = async () => {
  await fs.mkdir(path.dirname(EVENT_LOG_STATE_PATH), { recursive: true });
  const payload = {
    updatedAt: nowIso(),
    instanceId: INSTANCE_ID,
    stats: { ...runtime.stats },
  };
  const tempPath = `${EVENT_LOG_STATE_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, EVENT_LOG_STATE_PATH);
};

const scheduleLocalStatePersist = () => {
  if (runtime.stateFlushTimer) return;
  runtime.stateFlushTimer = setTimeout(() => {
    runtime.stateFlushTimer = null;
    runtime.stateWriteChain = runtime.stateWriteChain
      .catch(() => undefined)
      .then(() => persistLocalState())
      .catch((error) => {
        runtime.stats.loggerErrors += 1;
        runtime.stats.lastErrorAt = nowIso();
        logger.warn('Event logger state persist failed', { error: serializeError(error) });
      });
  }, EVENT_LOG_STATE_FLUSH_INTERVAL_MS);
  runtime.stateFlushTimer.unref?.();
};

const pruneRateMap = (nowMs) => {
  if (runtime.rateMap.size < 20_000) return;
  runtime.rateMap.forEach((entry, key) => {
    if (!entry || nowMs - Number(entry.windowStart || 0) > EVENT_LOG_RATE_WINDOW_MS * 2) {
      runtime.rateMap.delete(key);
    }
  });
};

const consumeLocalRateLimit = (rateKey) => {
  const nowMs = Date.now();
  pruneRateMap(nowMs);
  const existing = runtime.rateMap.get(rateKey);
  if (!existing || nowMs - Number(existing.windowStart || 0) >= EVENT_LOG_RATE_WINDOW_MS) {
    runtime.rateMap.set(rateKey, { windowStart: nowMs, count: 1 });
    return true;
  }
  if (existing.count >= EVENT_LOG_RATE_MAX) {
    return false;
  }
  existing.count += 1;
  runtime.rateMap.set(rateKey, existing);
  return true;
};

const buildRateKey = (event) =>
  [event.eventType, event.actorUid || 0, event.path || '/', event.targetUid || 0].join('|');

const toRedisRateKey = (rateKey) =>
  `${REDIS_RATE_PREFIX}${crypto.createHash('sha1').update(rateKey).digest('hex')}`;

const consumeRedisRateLimit = async (rateKey) => {
  const redis = await getRedisClient();
  if (!redis) {
    return { ok: true, mode: 'local_fallback' };
  }
  try {
    const redisKey = toRedisRateKey(rateKey);
    const count = await withTimeout(redis.incr(redisKey), EVENT_LOG_REDIS_TIMEOUT_MS);
    if (count === 1) {
      await withTimeout(redis.pExpire(redisKey, EVENT_LOG_RATE_WINDOW_MS), EVENT_LOG_REDIS_TIMEOUT_MS);
    }
    return { ok: Number(count) <= EVENT_LOG_RATE_MAX, mode: 'redis' };
  } catch (error) {
    markRedisRuntimeError(error);
    return { ok: true, mode: 'local_fallback' };
  }
};

const normalizeEventPayload = (input = {}) => {
  const eventType = normalizeEventType(input.eventType);
  if (!eventType) return null;
  const actorUid = toUid(input.actorUid);
  const targetUid = toUid(input.targetUid);
  const method = sanitizeText(String(input.method || ''), 16).toUpperCase();
  const pathValue = sanitizeText(String(input.path || ''), 200);
  const requestId = sanitizeText(String(input.requestId || ''), 120);
  const ip = sanitizeText(String(input.ip || ''), 80);
  const userAgent = sanitizeText(String(input.userAgent || ''), 180);
  const source = sanitizeText(String(input.source || 'api'), 32) || 'api';
  const timestamp =
    typeof input.timestamp === 'string' && input.timestamp.trim()
      ? input.timestamp.trim()
      : nowIso();

  return {
    id:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    eventType,
    actorUid,
    targetUid,
    targetType: sanitizeText(String(input.targetType || ''), 32),
    reason: sanitizeText(String(input.reason || ''), 220),
    evidence: sanitizeArray(input.evidence, { maxItems: 10, maxItemLength: 200 }),
    tags: sanitizeArray(input.tags, { maxItems: 12, maxItemLength: 40 }),
    metadata: isPlainObject(input.metadata) ? sanitizeMetadata(input.metadata) : {},
    source,
    requestId,
    method,
    path: pathValue,
    ip,
    userAgent,
    timestamp,
    instanceId: INSTANCE_ID,
  };
};

const updateLocalStats = (field, value = 1) => {
  if (field.startsWith('last')) {
    runtime.stats[field] = String(value || '');
    return;
  }
  const current = Number(runtime.stats[field] || 0);
  runtime.stats[field] = current + Number(value || 0);
};

const updateGlobalStats = async ({ increments = {}, sets = {} } = {}) => {
  const redis = await getRedisClient();
  if (!redis) return false;
  try {
    const multi = redis.multi();
    Object.entries(increments).forEach(([field, value]) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed === 0) return;
      multi.hIncrBy(REDIS_STATS_KEY, field, Math.trunc(parsed));
    });
    const safeSets = {};
    Object.entries(sets).forEach(([field, value]) => {
      if (value == null || value === '') return;
      safeSets[field] = String(value);
    });
    safeSets.instanceId = INSTANCE_ID;
    safeSets.updatedAt = nowIso();
    multi.hSet(REDIS_STATS_KEY, safeSets);
    await withTimeout(multi.exec(), EVENT_LOG_REDIS_TIMEOUT_MS * 2);
    return true;
  } catch (error) {
    markRedisRuntimeError(error);
    return false;
  }
};

const pushEventToRedisStream = async (event) => {
  const redis = await getRedisClient();
  if (!redis) return false;
  try {
    await withTimeout(
      redis.xAdd(REDIS_STREAM_KEY, '*', {
        eventType: event.eventType,
        actorUid: String(event.actorUid || 0),
        targetUid: String(event.targetUid || 0),
        targetType: String(event.targetType || ''),
        ts: event.timestamp,
        instanceId: event.instanceId || INSTANCE_ID,
        payload: JSON.stringify(event),
      }),
      EVENT_LOG_REDIS_TIMEOUT_MS * 2
    );
    return true;
  } catch (error) {
    markRedisRuntimeError(error);
    return false;
  }
};

const lockLocalRotation = async (task) => {
  while (runtime.localRotateInFlight) {
    try {
      await runtime.localRotateInFlight;
    } catch {}
  }
  runtime.localRotateInFlight = Promise.resolve()
    .then(task)
    .finally(() => {
      runtime.localRotateInFlight = null;
    });
  return runtime.localRotateInFlight;
};

const acquireRedisRotationLock = async () => {
  const redis = await getRedisClient();
  if (!redis) return null;
  const token =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await withTimeout(
      redis.set(REDIS_ROTATE_LOCK_KEY, token, {
        NX: true,
        PX: EVENT_LOG_ROTATE_LOCK_MS,
      }),
      EVENT_LOG_REDIS_TIMEOUT_MS
    );
    if (result !== 'OK') return null;
    return { redis, token };
  } catch (error) {
    markRedisRuntimeError(error);
    return null;
  }
};

const releaseRedisRotationLock = async (lock) => {
  if (!lock?.redis || !lock?.token) return;
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1]
    then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await withTimeout(
      lock.redis.eval(script, {
        keys: [REDIS_ROTATE_LOCK_KEY],
        arguments: [lock.token],
      }),
      EVENT_LOG_REDIS_TIMEOUT_MS
    );
  } catch {}
};

const pruneArchiveFiles = async () => {
  await fs.mkdir(EVENT_LOG_ARCHIVE_DIR, { recursive: true });
  const entries = await fs.readdir(EVENT_LOG_ARCHIVE_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.ndjson')) continue;
    const fullPath = path.join(EVENT_LOG_ARCHIVE_DIR, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) continue;
    files.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const toDelete = files.slice(EVENT_LOG_ROTATE_MAX_FILES);
  for (const item of toDelete) {
    await fs.unlink(item.fullPath).catch(() => undefined);
  }
};

const rotateLogIfNeeded = async (incomingBytes = 0) => {
  if (!EVENT_LOG_ROTATE_ENABLED) return false;
  const now = Date.now();
  if (now - runtime.lastRotateCheckAt < EVENT_LOG_ROTATE_CHECK_INTERVAL_MS) {
    return false;
  }
  runtime.lastRotateCheckAt = now;

  return lockLocalRotation(async () => {
    const stat = await fs.stat(EVENT_LOG_PATH).catch(() => null);
    if (!stat || !stat.isFile()) return false;
    if (stat.size + incomingBytes <= EVENT_LOG_ROTATE_MAX_BYTES) return false;

    const redisLock = await acquireRedisRotationLock();
    try {
      const recheck = await fs.stat(EVENT_LOG_PATH).catch(() => null);
      if (!recheck || !recheck.isFile()) return false;
      if (recheck.size + incomingBytes <= EVENT_LOG_ROTATE_MAX_BYTES) return false;
      await fs.mkdir(EVENT_LOG_ARCHIVE_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
      const filename = `${stamp}-${INSTANCE_ID}-${process.pid}-${Math.random()
        .toString(16)
        .slice(2, 8)}.ndjson`;
      const archivePath = path.join(EVENT_LOG_ARCHIVE_DIR, filename);
      await fs.rename(EVENT_LOG_PATH, archivePath);
      await pruneArchiveFiles();
      updateLocalStats('rotationCount', 1);
      updateLocalStats('lastRotatedAt', nowIso());
      scheduleLocalStatePersist();
      void updateGlobalStats({
        increments: { rotationCount: 1 },
        sets: { lastRotatedAt: runtime.stats.lastRotatedAt },
      });
      return true;
    } finally {
      await releaseRedisRotationLock(redisLock);
    }
  });
};

const writeBatch = async (events) => {
  if (!events.length) return;
  const payload = `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  await fs.mkdir(path.dirname(EVENT_LOG_PATH), { recursive: true });
  await rotateLogIfNeeded(bytes);

  let lastError = null;
  for (let attempt = 0; attempt <= EVENT_LOG_WRITE_RETRIES; attempt += 1) {
    try {
      await withTimeout(fs.appendFile(EVENT_LOG_PATH, payload, 'utf8'), EVENT_LOG_WRITE_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= EVENT_LOG_WRITE_RETRIES) break;
      await delay(EVENT_LOG_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  throw lastError || new Error('event_log_write_failed');
};

const scheduleFlush = (delayMs = EVENT_LOG_FLUSH_INTERVAL_MS) => {
  if (runtime.flushTimer) return;
  runtime.flushTimer = setTimeout(() => {
    runtime.flushTimer = null;
    void flushEvents();
  }, delayMs);
  runtime.flushTimer.unref?.();
};

const flushEvents = async () => {
  if (runtime.flushing) return;
  if (!runtime.queue.length) return;
  runtime.flushing = true;
  try {
    while (runtime.queue.length > 0) {
      const batch = runtime.queue.splice(0, EVENT_LOG_FLUSH_BATCH_SIZE);
      try {
        await writeBatch(batch);
        updateLocalStats('flushed', batch.length);
        updateLocalStats('lastFlushedAt', nowIso());
        scheduleLocalStatePersist();
        metrics.incCounter('event_log_flush_total', batch.length);
        void updateGlobalStats({
          increments: { flushed: batch.length },
          sets: { lastFlushedAt: runtime.stats.lastFlushedAt },
        });
      } catch (error) {
        runtime.queue.unshift(...batch);
        updateLocalStats('writeErrors', 1);
        updateLocalStats('lastErrorAt', nowIso());
        scheduleLocalStatePersist();
        logger.warn('Event logger write failed', {
          error: serializeError(error),
          batchSize: batch.length,
        });
        metrics.incCounter('event_log_write_error_total', 1);
        scheduleFlush(Math.max(50, EVENT_LOG_FLUSH_INTERVAL_MS));
        break;
      }
    }
  } finally {
    runtime.flushing = false;
    if (runtime.queue.length > 0) {
      scheduleFlush(5);
    }
  }
};

const createRequestEvent = (req, payload = {}) => {
  const ipRaw = String(
    req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || ''
  );
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return {
    ...payload,
    requestId: req?.requestId || '',
    method: req?.method || '',
    path: req?.originalUrl || req?.path || '',
    ip,
    userAgent: String(req?.headers?.['user-agent'] || ''),
    source: payload.source || 'api',
  };
};

const applyDropStat = (reason) => {
  if (reason === 'disabled') updateLocalStats('droppedDisabled', 1);
  if (reason === 'invalid_event') updateLocalStats('droppedInvalid', 1);
  if (reason === 'rate_limited') updateLocalStats('droppedRateLimited', 1);
  if (reason === 'queue_overflow') updateLocalStats('droppedQueueOverflow', 1);
  updateLocalStats('lastErrorAt', nowIso());
  scheduleLocalStatePersist();
};

const trackEvent = async (payload = {}) => {
  await ensureLocalStateLoaded();
  if (!isFeatureEnabled('eventLogging')) {
    applyDropStat('disabled');
    void updateGlobalStats({
      increments: { droppedDisabled: 1 },
      sets: { lastErrorAt: runtime.stats.lastErrorAt },
    });
    return { accepted: false, reason: 'disabled' };
  }

  const normalized = normalizeEventPayload(payload);
  if (!normalized) {
    applyDropStat('invalid_event');
    void updateGlobalStats({
      increments: { droppedInvalid: 1 },
      sets: { lastErrorAt: runtime.stats.lastErrorAt },
    });
    return { accepted: false, reason: 'invalid_event' };
  }

  const rateKey = buildRateKey(normalized);
  const redisRate = await consumeRedisRateLimit(rateKey);
  const localAllowed = redisRate.mode === 'redis' ? true : consumeLocalRateLimit(rateKey);
  const allowed = redisRate.ok && localAllowed;
  if (!allowed) {
    applyDropStat('rate_limited');
    metrics.incCounter('event_log_rate_limited_total', 1, { eventType: normalized.eventType });
    void updateGlobalStats({
      increments: { droppedRateLimited: 1 },
      sets: { lastErrorAt: runtime.stats.lastErrorAt },
    });
    return { accepted: false, reason: 'rate_limited' };
  }

  if (runtime.queue.length >= EVENT_LOG_QUEUE_MAX) {
    applyDropStat('queue_overflow');
    metrics.incCounter('event_log_queue_overflow_total', 1);
    void updateGlobalStats({
      increments: { droppedQueueOverflow: 1 },
      sets: { lastErrorAt: runtime.stats.lastErrorAt },
    });
    return { accepted: false, reason: 'queue_overflow' };
  }

  runtime.queue.push(normalized);
  updateLocalStats('accepted', 1);
  updateLocalStats('lastEnqueuedAt', nowIso());
  scheduleLocalStatePersist();
  metrics.incCounter('event_log_accepted_total', 1, { eventType: normalized.eventType });
  scheduleFlush();

  void updateGlobalStats({
    increments: { accepted: 1 },
    sets: { lastEnqueuedAt: runtime.stats.lastEnqueuedAt },
  });
  void pushEventToRedisStream(normalized);
  return { accepted: true, id: normalized.id };
};

const trackEventSafe = async (payload = {}) => {
  try {
    return await trackEvent(payload);
  } catch (error) {
    updateLocalStats('loggerErrors', 1);
    updateLocalStats('lastErrorAt', nowIso());
    scheduleLocalStatePersist();
    logger.warn('Event logger enqueue failed', { error: serializeError(error) });
    void updateGlobalStats({
      increments: { loggerErrors: 1 },
      sets: { lastErrorAt: runtime.stats.lastErrorAt },
    });
    return { accepted: false, reason: 'logger_error' };
  }
};

const readGlobalStats = async () => {
  const redis = await getRedisClient();
  if (!redis) return null;
  try {
    const [statsRaw, streamInfo] = await Promise.all([
      withTimeout(redis.hGetAll(REDIS_STATS_KEY), EVENT_LOG_REDIS_TIMEOUT_MS),
      withTimeout(redis.xInfoStream(REDIS_STREAM_KEY), EVENT_LOG_REDIS_TIMEOUT_MS).catch(() => null),
    ]);
    const stats = mergeStats(statsRaw || {});
    const streamLength = Number(streamInfo?.length);
    return {
      stats,
      streamLength: Number.isFinite(streamLength) ? streamLength : 0,
      connected: true,
    };
  } catch (error) {
    markRedisRuntimeError(error);
    return null;
  }
};

const getEventLoggerStats = async () => {
  await ensureLocalStateLoaded();
  const global = await readGlobalStats();
  return {
    enabled: isFeatureEnabled('eventLogging'),
    instanceId: INSTANCE_ID,
    path: EVENT_LOG_PATH,
    archiveDir: EVENT_LOG_ARCHIVE_DIR,
    statePath: EVENT_LOG_STATE_PATH,
    queueLength: runtime.queue.length,
    flushing: runtime.flushing,
    redis: {
      enabled: Boolean(REDIS_URL),
      connected: Boolean(global?.connected),
      streamKey: REDIS_STREAM_KEY,
      statsKey: REDIS_STATS_KEY,
    },
    limits: {
      queueMax: EVENT_LOG_QUEUE_MAX,
      flushIntervalMs: EVENT_LOG_FLUSH_INTERVAL_MS,
      flushBatchSize: EVENT_LOG_FLUSH_BATCH_SIZE,
      writeTimeoutMs: EVENT_LOG_WRITE_TIMEOUT_MS,
      writeRetries: EVENT_LOG_WRITE_RETRIES,
      rateWindowMs: EVENT_LOG_RATE_WINDOW_MS,
      rateMax: EVENT_LOG_RATE_MAX,
      rotateEnabled: EVENT_LOG_ROTATE_ENABLED,
      rotateMaxBytes: EVENT_LOG_ROTATE_MAX_BYTES,
      rotateMaxFiles: EVENT_LOG_ROTATE_MAX_FILES,
      redisTimeoutMs: EVENT_LOG_REDIS_TIMEOUT_MS,
      redisRetryBackoffMs: EVENT_LOG_REDIS_RETRY_BACKOFF_MS,
    },
    local: {
      stats: { ...runtime.stats },
    },
    global: global || {
      stats: null,
      streamLength: 0,
      connected: false,
    },
  };
};

const flushEventLogs = async ({ force = false } = {}) => {
  if (force) {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    if (runtime.stateFlushTimer) {
      clearTimeout(runtime.stateFlushTimer);
      runtime.stateFlushTimer = null;
    }
    await flushEvents();
    await runtime.stateWriteChain.catch(() => undefined);
    await persistLocalState().catch(() => undefined);
    return;
  }
  scheduleFlush(0);
};

const resetEventLoggerForTests = async () => {
  if (runtime.flushTimer) {
    clearTimeout(runtime.flushTimer);
    runtime.flushTimer = null;
  }
  if (runtime.stateFlushTimer) {
    clearTimeout(runtime.stateFlushTimer);
    runtime.stateFlushTimer = null;
  }
  runtime.queue.length = 0;
  runtime.flushing = false;
  runtime.rateMap.clear();
  runtime.lastRotateCheckAt = 0;
  runtime.stats = stateTemplate();
  runtime.stateLoaded = true;
  runtime.stateLoadPromise = null;
  runtime.stateWriteChain = Promise.resolve();
  if (runtime.redis.client?.isOpen) {
    await runtime.redis.client.quit().catch(() => undefined);
  }
  runtime.redis.client = null;
  runtime.redis.connectInFlight = null;
  runtime.redis.nextRetryAtMs = 0;
  runtime.redis.unavailableLogged = false;
  runtime.redis.runtimeErrorLogged = false;
  await fs.unlink(EVENT_LOG_STATE_PATH).catch(() => undefined);
};

export {
  createRequestEvent,
  flushEventLogs,
  getEventLoggerStats,
  normalizeEventPayload,
  resetEventLoggerForTests,
  trackEvent,
  trackEventSafe,
};
