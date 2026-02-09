import crypto from 'crypto';

const TOKEN_TTL_DAYS = 181;
const DEFAULT_REVOCATION_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const REDIS_PREFIX =
  String(process.env.REDIS_REVOKED_TOKEN_PREFIX || 'xinchat:revoked-token:')
    .trim() || 'xinchat:revoked-token:';

const revokedTokens = new Map();
const revokedListeners = new Set();
let lastMemorySweepAt = 0;

let redisClient = null;
let redisConnectInFlight = null;
let redisUnavailableLogged = false;
let redisRuntimeErrorLogged = false;

const parsePositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const REVOKED_MEMORY_SWEEP_INTERVAL_MS = parsePositiveInt(
  process.env.REVOKED_MEMORY_SWEEP_INTERVAL_MS,
  60_000,
  1_000
);

const getTokenId = (token) => {
  const safeToken = String(token || '').trim();
  if (!safeToken) return '';
  return crypto.createHash('sha256').update(safeToken).digest('hex');
};

const parseExpiresAtMs = (expiresAt) => {
  const parsed = expiresAt ? Date.parse(String(expiresAt)) : NaN;
  if (Number.isFinite(parsed) && parsed > Date.now()) {
    return parsed;
  }
  return Date.now() + DEFAULT_REVOCATION_TTL_MS;
};

const getTtlSeconds = (expiresAtMs) => {
  const raw = Math.ceil((expiresAtMs - Date.now()) / 1000);
  return Math.max(1, raw);
};

const sweepExpiredMemoryRevocations = (force = false) => {
  const now = Date.now();
  if (!force && now - lastMemorySweepAt < REVOKED_MEMORY_SWEEP_INTERVAL_MS) {
    return;
  }
  lastMemorySweepAt = now;
  revokedTokens.forEach((expiresAtMs, tokenId) => {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      revokedTokens.delete(tokenId);
    }
  });
};

const rememberRevokedToken = (tokenId, expiresAtMs) => {
  if (!tokenId || !Number.isFinite(expiresAtMs)) return;
  const prev = revokedTokens.get(tokenId) || 0;
  revokedTokens.set(tokenId, Math.max(prev, expiresAtMs));
};

const markRedisUnavailable = (error) => {
  if (redisUnavailableLogged) return;
  redisUnavailableLogged = true;
  const message = error instanceof Error ? error.message : String(error || '');
  console.warn(
    '[auth] Redis unavailable for token revocation, fallback to memory store:',
    message
  );
};

const markRedisRuntimeError = (error) => {
  if (redisRuntimeErrorLogged) return;
  redisRuntimeErrorLogged = true;
  const message = error instanceof Error ? error.message : String(error || '');
  console.warn(
    '[auth] Redis token revocation runtime error, continuing with memory store:',
    message
  );
};

const getRedisClient = async () => {
  if (!REDIS_URL) return null;
  if (redisClient?.isOpen) return redisClient;
  if (redisConnectInFlight) return redisConnectInFlight;

  redisConnectInFlight = (async () => {
    try {
      const redisModule = await import('redis');
      const client = redisModule.createClient({ url: REDIS_URL });
      client.on('error', (error) => {
        markRedisRuntimeError(error);
      });
      await client.connect();
      redisUnavailableLogged = false;
      redisRuntimeErrorLogged = false;
      redisClient = client;
      return client;
    } catch (error) {
      markRedisUnavailable(error);
      return null;
    } finally {
      redisConnectInFlight = null;
    }
  })();
  return redisConnectInFlight;
};

const redisRevokedKey = (tokenId) => `${REDIS_PREFIX}${tokenId}`;

const notifyRevoked = (payload) => {
  revokedListeners.forEach((listener) => {
    try {
      listener(payload);
    } catch {}
  });
};

export const onTokenRevoked = (listener) => {
  if (typeof listener !== 'function') {
    return () => {};
  }
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
};

export const revokeToken = async (token, expiresAt) => {
  const tokenId = getTokenId(token);
  if (!tokenId) {
    return { tokenId: '', expiresAt: null };
  }
  const expiresAtMs = parseExpiresAtMs(expiresAt);
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  rememberRevokedToken(tokenId, expiresAtMs);
  sweepExpiredMemoryRevocations();

  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.set(redisRevokedKey(tokenId), '1', {
        EX: getTtlSeconds(expiresAtMs),
      });
    } catch (error) {
      markRedisRuntimeError(error);
    }
  }

  notifyRevoked({ tokenId, expiresAt: expiresAtIso });
  return { tokenId, expiresAt: expiresAtIso };
};

export const isTokenRevoked = async (token) => {
  const tokenId = getTokenId(token);
  if (!tokenId) return false;
  const now = Date.now();
  const memoryExpiresAt = revokedTokens.get(tokenId);
  if (Number.isFinite(memoryExpiresAt) && memoryExpiresAt > now) {
    return true;
  }
  if (Number.isFinite(memoryExpiresAt) && memoryExpiresAt <= now) {
    revokedTokens.delete(tokenId);
  }
  sweepExpiredMemoryRevocations();

  const redis = await getRedisClient();
  if (!redis) {
    return false;
  }
  try {
    const exists = await redis.exists(redisRevokedKey(tokenId));
    if (!exists) return false;
    const ttlMs = await redis.pTTL(redisRevokedKey(tokenId));
    const expiresAtMs = ttlMs > 0 ? Date.now() + ttlMs : Date.now() + DEFAULT_REVOCATION_TTL_MS;
    rememberRevokedToken(tokenId, expiresAtMs);
    return true;
  } catch (error) {
    markRedisRuntimeError(error);
    return false;
  }
};

export { getTokenId };
