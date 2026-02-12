/**
 * 模块说明：认证路由模块：处理注册、登录、资料与会话相关能力。
 */


import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isTokenRevoked, revokeToken } from '../tokenRevocation.js';
import { atomicWriteFile, createSerialQueue } from '../utils/filePersistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const USERS_LOCK_PATH = path.join(DATA_DIR, 'users.json.lock');
const UID_START = 100000000;
const TOKEN_TTL_DAYS = 181;

const router = express.Router();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const loginAttempts = new Map();
const DEFAULT_SIGNATURE =
  '\u8fd9\u4e2a\u4eba\u5f88\u795e\u79d8\uff0c\u6682\u672a\u586b\u5199\u7b7e\u540d';
const MAX_NICKNAME_LEN = 36;
const MAX_SIGNATURE_LEN = 80;
const MAX_AVATAR_BYTES = 20 * 1024 * 1024;
const MIN_USERNAME_LEN = 3;
const MAX_USERNAME_LEN = 32;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;
const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || 'xinchat_token').trim() || 'xinchat_token';
const AUTH_COOKIE_PATH = '/';
const AUTH_COOKIE_SAME_SITE = 'Lax';
// normalizeUsername：归一化外部输入。
const normalizeUsername = (value) => value.trim().toLowerCase();
// isPlainObject：判断条件是否成立。
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// toPlainObject?处理 toPlainObject 相关逻辑。
const toPlainObject = (value) => (isPlainObject(value) ? value : {});
// toTokenString?处理 toTokenString 相关逻辑。
const toTokenString = (value) => (typeof value === 'string' ? value.trim() : '');
// parsePositiveInt：解析并校验输入值。
const parsePositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
};

// hasDepressionTendency：判断是否具备指定状态。
const hasDepressionTendency = (user) => {
  const analysis = user?.aiProfile?.analysis || {};
  const depression = analysis?.depressionTendency || {};
  const level = String(depression?.level || '').toLowerCase();
  return level === 'medium' || level === 'high';
};

// hasSuicideIntent：判断是否具备指定状态。
const hasSuicideIntent = (user) => hasDepressionTendency(user);

// estimateBase64Bytes?处理 estimateBase64Bytes 相关逻辑。
const estimateBase64Bytes = (value) => {
  const commaIndex = value.indexOf(',');
  if (commaIndex === -1) return 0;
  const base64 = value.slice(commaIndex + 1).trim();
  if (!base64) return 0;
  let padding = 0;
  if (base64.endsWith('==')) {
    padding = 2;
  } else if (base64.endsWith('=')) {
    padding = 1;
  }
  return Math.floor(base64.length * 0.75) - padding;
};

// normalizeAvatar：归一化外部输入。
const normalizeAvatar = (value, baseUrl = '') => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith('/uploads/images/')) {
      return trimmed;
    }
    if (baseUrl && trimmed.startsWith(`${baseUrl}/uploads/images/`)) {
      return trimmed;
    }
    return null;
  }
  const size = estimateBase64Bytes(trimmed);
  if (!size || size > MAX_AVATAR_BYTES) {
    return null;
  }
  return trimmed;
};

// parseCookieHeader：解析并校验输入值。
const parseCookieHeader = (raw) => {
  const result = {};
  const source = String(raw || '').trim();
  if (!source) return result;
  source.split(';').forEach((item) => {
    const segment = String(item || '').trim();
    if (!segment) return;
    const splitIndex = segment.indexOf('=');
    if (splitIndex <= 0) return;
    const name = segment.slice(0, splitIndex).trim();
    const valueRaw = segment.slice(splitIndex + 1).trim();
    if (!name) return;
    try {
      result[name] = decodeURIComponent(valueRaw);
    } catch {
      result[name] = valueRaw;
    }
  });
  return result;
};

// shouldUseSecureCookie?处理 shouldUseSecureCookie 相关逻辑。
const shouldUseSecureCookie = (req) => {
  const env = String(process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase();
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  if (forwardedProto.includes('https')) return true;
  if (req?.secure) return true;
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
};

// appendAuthCookie?处理 appendAuthCookie 相关逻辑。
const appendAuthCookie = (res, req, token, expiresAt) => {
  const safeToken = String(token || '').trim();
  const ts = expiresAt ? Date.parse(String(expiresAt)) : 0;
  if (!safeToken || !Number.isFinite(ts) || ts <= Date.now()) return;
  const maxAgeSec = Math.max(1, Math.floor((ts - Date.now()) / 1000));
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(safeToken)}`,
    `Path=${AUTH_COOKIE_PATH}`,
    `Max-Age=${maxAgeSec}`,
    `Expires=${new Date(Date.now() + maxAgeSec * 1000).toUTCString()}`,
    `SameSite=${AUTH_COOKIE_SAME_SITE}`,
    'HttpOnly',
  ];
  if (shouldUseSecureCookie(req)) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
};

// clearAuthCookie：清理无效或过期数据。
const clearAuthCookie = (res, req) => {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    `Path=${AUTH_COOKIE_PATH}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    `SameSite=${AUTH_COOKIE_SAME_SITE}`,
    'HttpOnly',
  ];
  if (shouldUseSecureCookie(req)) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
};

// extractTokenFromCookie：提取请求中的关键信息。
const extractTokenFromCookie = (req) => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  return String(cookies[AUTH_COOKIE_NAME] || '').trim();
};

// extractToken：提取请求中的关键信息。
const extractToken = (req) => {
  const header = String(req?.headers?.authorization || '').trim();
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookieToken = extractTokenFromCookie(req);
  if (cookieToken) return cookieToken;
  const bodyToken = toTokenString(toPlainObject(req?.body).token);
  if (bodyToken) return bodyToken;
  return toTokenString(toPlainObject(req?.query).token);
};

// asyncRoute?处理 asyncRoute 相关逻辑。
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// authenticate?处理 authenticate 相关逻辑。
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ success: false, message: '缺少登录令牌。' });
      return;
    }

    let users = await readUsers();
    let found = await findUserByToken(users, token);
    if (found.touched) {
      const mutation = await mutateUsers(
        async (latestUsers) => {
          const latestFound = await findUserByToken(latestUsers, token);
          return {
            changed: latestFound.touched,
            result: { users: latestUsers, found: latestFound },
          };
        },
        { defaultChanged: false }
      );
      if (mutation.result) {
        users = mutation.result.users;
        found = mutation.result.found;
      }
    }
    if (!found.user) {
      if (found.revoked) {
        clearAuthCookie(res, req);
      }
      res.status(401).json({
        success: false,
        message: found.revoked ? '登录令牌已被吊销。' : '登录令牌无效。',
      });
      return;
    }

    req.auth = { user: found.user, userIndex: found.userIndex, users };
    next();
  } catch (error) {
    console.error('Authenticate error:', error);
    res.status(500).json({ success: false, message: '服务器错误。' });
  }
};

const USERS_CACHE_TTL_MS = parsePositiveInt(process.env.USERS_CACHE_TTL_MS, 5000, 200);
const USERS_WRITE_QUEUE_MAX = parsePositiveInt(process.env.USERS_WRITE_QUEUE_MAX, 2000, 20);
let cachedUsers = null;
let cachedUsersAt = 0;
let usersLoadInFlight = null;
const usersWriteQueue = createSerialQueue({
  maxPending: USERS_WRITE_QUEUE_MAX,
  overflowError: 'users_write_queue_overflow',
});
let ensureStorageInFlight = null;
let storageReady = false;
let tokenIndexCache = new Map();
let usernameIndexCache = new Map();
let usersCacheVersion = 0;
let usersCacheHits = 0;
let usersCacheMisses = 0;
let usersCacheForcedRefreshes = 0;
let usersCacheLastRefreshError = '';

// cloneUsers?处理 cloneUsers 相关逻辑。
const cloneUsers = (users) => {
  const source = Array.isArray(users) ? users : [];
  if (typeof structuredClone === 'function') {
    return structuredClone(source);
  }
  return JSON.parse(JSON.stringify(source));
};

// rebuildUsersIndexes?处理 rebuildUsersIndexes 相关逻辑。
const rebuildUsersIndexes = (users) => {
  const tokens = new Map();
  const usernames = new Map();
  const list = Array.isArray(users) ? users : [];
  list.forEach((user, index) => {
    if (typeof user?.username === 'string' && user.username) {
      usernames.set(user.username, index);
    }
    if (Array.isArray(user?.tokens)) {
      user.tokens.forEach((entry) => {
        if (!entry || typeof entry.token !== 'string' || !entry.token) {
          return;
        }
        if (!tokens.has(entry.token)) {
          tokens.set(entry.token, index);
        }
      });
    }
    if (typeof user?.token === 'string' && user.token && !tokens.has(user.token)) {
      tokens.set(user.token, index);
    }
  });
  tokenIndexCache = tokens;
  usernameIndexCache = usernames;
};

// setUsersCache：设置运行时状态。
const setUsersCache = (users, timestamp = Date.now()) => {
  cachedUsers = Array.isArray(users) ? users : [];
  cachedUsersAt = timestamp;
  usersCacheVersion += 1;
  rebuildUsersIndexes(cachedUsers);
};

// queueUsersWriteTask：将任务按顺序排队处理。
const queueUsersWriteTask = async (task) => {
  return usersWriteQueue.enqueue(task);
};

// persistUsersSnapshot?处理 persistUsersSnapshot 相关逻辑。
const persistUsersSnapshot = async (snapshot) => {
  const payload = JSON.stringify(snapshot, null, 2);
  try {
    await atomicWriteFile(USERS_PATH, payload, {
      lockPath: USERS_LOCK_PATH,
      retry: {
        attempts: 120,
        baseDelayMs: 10,
        maxDelayMs: 120,
      },
    });
    setUsersCache(snapshot, Date.now());
  } catch (writeError) {
    throw writeError || new Error('persist_users_failed');
  }
};

// ensureStorage：确保前置条件与资源可用。
const ensureStorage = async () => {
  if (storageReady) {
    return;
  }
  if (ensureStorageInFlight) {
    await ensureStorageInFlight;
    return;
  }
  ensureStorageInFlight = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.access(USERS_PATH);
    } catch {
      await fs.writeFile(USERS_PATH, '[]', 'utf-8');
    }
    storageReady = true;
  })();
  try {
    await ensureStorageInFlight;
  } finally {
    ensureStorageInFlight = null;
  }
};

// loadUsersFromDisk?处理 loadUsersFromDisk 相关逻辑。
const loadUsersFromDisk = async () => {
  await ensureStorage();
  const now = Date.now();
  const raw = await fs.readFile(USERS_PATH, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) {
    setUsersCache([], now);
    return cachedUsers;
  }
  let users;
  try {
    users = JSON.parse(trimmed);
  } catch (error) {
    const backupPath = `${USERS_PATH}.corrupt-${Date.now()}`;
    await fs.writeFile(backupPath, raw, 'utf-8');
    await fs.writeFile(USERS_PATH, '[]', 'utf-8');
    console.error(
      `Failed to parse users.json. Backup created at ${backupPath}.`,
      error
    );
    setUsersCache([], now);
    return cachedUsers;
  }
  if (!Array.isArray(users)) {
    console.error('Invalid users.json format. Resetting to empty array.');
    await fs.writeFile(USERS_PATH, '[]', 'utf-8');
    setUsersCache([], now);
    return cachedUsers;
  }
  const normalizedChanged = normalizeUsersForStorage(users);
  if (normalizedChanged) {
    await persistUsersSnapshot(users);
    return cachedUsers;
  }
  setUsersCache(users, now);
  return cachedUsers;
};

// readUsersCached：读取持久化或缓存数据。
const readUsersCached = async ({ forceRefresh = false } = {}) => {
  await ensureStorage();
  const now = Date.now();
  if (!forceRefresh && cachedUsers && now - cachedUsersAt < USERS_CACHE_TTL_MS) {
    usersCacheHits += 1;
    return cachedUsers;
  }
  usersCacheMisses += 1;
  if (forceRefresh) {
    usersCacheForcedRefreshes += 1;
  }
  if (usersLoadInFlight) {
    await usersLoadInFlight;
    return cachedUsers || [];
  }
  usersLoadInFlight = queueUsersWriteTask(() => loadUsersFromDisk())
    .then(() => {
      usersCacheLastRefreshError = '';
    })
    .catch((error) => {
      usersCacheLastRefreshError = error instanceof Error ? error.message : String(error);
      console.error('Read users cache refresh error:', error);
      if (!cachedUsers) {
        setUsersCache([], Date.now());
      }
    })
    .finally(() => {
      usersLoadInFlight = null;
    });
  await usersLoadInFlight;
  return cachedUsers || [];
};

// readUsers：读取持久化或缓存数据。
const readUsers = async () => {
  const users = await readUsersCached();
  return cloneUsers(users);
};

// mutateUsers?处理 mutateUsers 相关逻辑。
const mutateUsers = async (mutator, { defaultChanged = true } = {}) => {
  if (typeof mutator !== 'function') {
    throw new TypeError('mutateUsers requires a function mutator.');
  }
  await ensureStorage();
  await readUsersCached();
  let changed = defaultChanged;
  let result;
  await queueUsersWriteTask(async () => {
    const working = cloneUsers(cachedUsers || []);
    const output = await mutator(working);
    if (
      output &&
      typeof output === 'object' &&
      Object.prototype.hasOwnProperty.call(output, 'changed')
    ) {
      changed = Boolean(output.changed);
      result = output.result;
    } else {
      result = output;
    }
    if (changed) {
      await persistUsersSnapshot(working);
    }
  });
  return { changed, result };
};

// invalidateUsersCache?处理 invalidateUsersCache 相关逻辑。
const invalidateUsersCache = () => {
  cachedUsers = null;
  cachedUsersAt = 0;
  tokenIndexCache = new Map();
  usernameIndexCache = new Map();
};

// getUsersCacheInfo：获取并返回目标数据。
const getUsersCacheInfo = () => ({
  ttlMs: USERS_CACHE_TTL_MS,
  version: usersCacheVersion,
  size: Array.isArray(cachedUsers) ? cachedUsers.length : 0,
  cachedAt: cachedUsersAt ? new Date(cachedUsersAt).toISOString() : null,
  ageMs: cachedUsersAt ? Math.max(0, Date.now() - cachedUsersAt) : null,
  hits: usersCacheHits,
  misses: usersCacheMisses,
  forcedRefreshes: usersCacheForcedRefreshes,
  lastRefreshError: usersCacheLastRefreshError || null,
});

// forceRefreshUsersCache?处理 forceRefreshUsersCache 相关逻辑。
const forceRefreshUsersCache = async () => {
  await readUsersCached({ forceRefresh: true });
  return getUsersCacheInfo();
};

// ensureUserUids：确保前置条件与资源可用。
const ensureUserUids = (users) => {
  let maxUid = UID_START - 1;
  users.forEach((user) => {
    if (Number.isInteger(user.uid)) {
      maxUid = Math.max(maxUid, user.uid);
    }
  });

  let nextUid = Math.max(maxUid + 1, UID_START);
  let updated = false;
  users.forEach((user) => {
    if (!Number.isInteger(user.uid)) {
      user.uid = nextUid++;
      updated = true;
    }
  });
  return updated;
};

// ensureUserDefaults：确保前置条件与资源可用。
const ensureUserDefaults = (users) => {
  let updated = false;
  users.forEach((user) => {
    if (!Array.isArray(user.friends)) {
      user.friends = [];
      updated = true;
    }
    if (typeof user.signature !== 'string') {
      user.signature = DEFAULT_SIGNATURE;
      updated = true;
    }
    if (typeof user.avatar !== 'string') {
      user.avatar = '';
      updated = true;
    }
    if (typeof user.online !== 'boolean') {
      user.online = false;
      updated = true;
    }
    if (!Array.isArray(user.tokens)) {
      user.tokens = [];
      updated = true;
    }
    if (user.token && user.tokenExpiresAt) {
      const exists = user.tokens.some((entry) => entry?.token === user.token);
      if (!exists) {
        user.tokens.push({ token: user.token, expiresAt: user.tokenExpiresAt });
        updated = true;
      }
    }
    if (Array.isArray(user.tokens)) {
      const nextTokens = user.tokens.filter(
        (entry) =>
          entry &&
          typeof entry.token === 'string' &&
          entry.token &&
          typeof entry.expiresAt === 'string' &&
          !isTokenExpired(entry.expiresAt)
      );
      if (nextTokens.length !== user.tokens.length) {
        user.tokens = nextTokens;
        updated = true;
      }
    }
    if (user.token && isTokenExpired(user.tokenExpiresAt)) {
      user.token = null;
      user.tokenExpiresAt = null;
      updated = true;
    }
    if (typeof user.nickname !== 'string') {
      user.nickname = user.username || '';
      updated = true;
    }
    if (typeof user.gender !== 'string') {
      user.gender = '';
      updated = true;
    }
    if (typeof user.birthday !== 'string') {
      user.birthday = '';
      updated = true;
    }
    if (typeof user.country !== 'string') {
      user.country = '';
      updated = true;
    }
    if (typeof user.province !== 'string') {
      user.province = '';
      updated = true;
    }
    if (typeof user.region !== 'string') {
      user.region = '';
      updated = true;
    }
    if (!user.friendRequests || typeof user.friendRequests !== 'object') {
      user.friendRequests = { incoming: [], outgoing: [] };
      updated = true;
      return;
    }
    if (!Array.isArray(user.friendRequests.incoming)) {
      user.friendRequests.incoming = [];
      updated = true;
    }
    if (!Array.isArray(user.friendRequests.outgoing)) {
      user.friendRequests.outgoing = [];
      updated = true;
    }
  });
  return updated;
};

// normalizeUsersForStorage：归一化外部输入。
const normalizeUsersForStorage = (users) => {
  const changedUid = ensureUserUids(users);
  const changedDefaults = ensureUserDefaults(users);
  return Boolean(changedUid || changedDefaults);
};

// getNextUid：获取并返回目标数据。
const getNextUid = (users) => {
  let maxUid = UID_START - 1;
  users.forEach((user) => {
    if (Number.isInteger(user.uid)) {
      maxUid = Math.max(maxUid, user.uid);
    }
  });
  return Math.max(maxUid + 1, UID_START);
};

// issueToken?处理 issueToken 相关逻辑。
const issueToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  return { token, expiresAt };
};

// isTokenExpired：判断条件是否成立。
const isTokenExpired = (expiresAt) => {
  const ts = expiresAt ? Date.parse(expiresAt) : 0;
  if (!ts || Number.isNaN(ts)) return true;
  return Date.now() > ts;
};

// removeTokenFromUser：清理无效或过期数据。
const removeTokenFromUser = (user, token) => {
  if (!user || !token) return false;
  let changed = false;
  if (Array.isArray(user.tokens)) {
    const next = user.tokens.filter((entry) => entry?.token !== token);
    if (next.length !== user.tokens.length) {
      user.tokens = next;
      changed = true;
    }
  }
  if (user.token === token) {
    user.token = null;
    user.tokenExpiresAt = null;
    changed = true;
  }
  return changed;
};

// resolveTokenExpiresAt：解析并确定最终值。
const resolveTokenExpiresAt = (user, token) => {
  if (!user || !token) return null;
  const tokens = Array.isArray(user.tokens) ? user.tokens : [];
  const entry = tokens.find((item) => item?.token === token);
  if (entry && typeof entry.expiresAt === 'string' && entry.expiresAt) {
    return entry.expiresAt;
  }
  if (user.token === token && typeof user.tokenExpiresAt === 'string' && user.tokenExpiresAt) {
    return user.tokenExpiresAt;
  }
  return null;
};

// resolveTokenState：解析并确定最终值。
const resolveTokenState = (user, token) => {
  const tokens = Array.isArray(user?.tokens) ? user.tokens : [];
  const entry = tokens.find((item) => item?.token === token);
  if (entry) {
    return isTokenExpired(entry.expiresAt) ? 'expired' : 'valid';
  }
  if (user?.token === token) {
    return isTokenExpired(user.tokenExpiresAt) ? 'expired' : 'valid';
  }
  return 'missing';
};

// findUserByTokenLocal：查找目标记录。
const findUserByTokenLocal = (users, token) => {
  if (!token) return { user: null, userIndex: -1, touched: false };

  const indexedUserIndex = tokenIndexCache.get(token);
  if (
    Number.isInteger(indexedUserIndex) &&
    indexedUserIndex >= 0 &&
    indexedUserIndex < users.length
  ) {
    const indexedUser = users[indexedUserIndex];
    const indexedState = resolveTokenState(indexedUser, token);
    if (indexedState === 'valid') {
      return { user: indexedUser, userIndex: indexedUserIndex, touched: false };
    }
    if (indexedState === 'expired') {
      const touched = removeTokenFromUser(indexedUser, token);
      return { user: null, userIndex: -1, touched };
    }
  }

  let touched = false;
  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const state = resolveTokenState(user, token);
    if (state === 'valid') {
      return { user, userIndex: i, touched };
    }
    if (state === 'expired') {
      if (removeTokenFromUser(user, token)) {
        touched = true;
      }
      return { user: null, userIndex: -1, touched };
    }
  }
  return { user: null, userIndex: -1, touched };
};

// findUserByToken：查找目标记录。
const findUserByToken = async (users, token) => {
  const safeToken = String(token || '').trim();
  if (!safeToken) {
    return { user: null, userIndex: -1, touched: false, revoked: false };
  }
  if (await isTokenRevoked(safeToken)) {
    const localFound = findUserByTokenLocal(users, safeToken);
    let touched = localFound.touched;
    if (localFound.user && localFound.userIndex >= 0 && localFound.userIndex < users.length) {
      if (removeTokenFromUser(users[localFound.userIndex], safeToken)) {
        touched = true;
      }
    }
    return { user: null, userIndex: -1, touched, revoked: true };
  }
  const localFound = findUserByTokenLocal(users, safeToken);
  return { ...localFound, revoked: false };
};

// revokeCurrentToken?处理 revokeCurrentToken 相关逻辑。
const revokeCurrentToken = async (users, userIndex, token) => {
  const safeToken = String(token || '').trim();
  if (!safeToken) {
    return { touched: false, tokenId: '' };
  }
  const expiresAt = resolveTokenExpiresAt(users[userIndex], safeToken);
  const revoked = await revokeToken(safeToken, expiresAt);
  const touched = removeTokenFromUser(users[userIndex], safeToken);
  return { touched, tokenId: revoked.tokenId || '' };
};

// findUserIndexByUsername：查找目标记录。
const findUserIndexByUsername = (users, normalizedUsername) => {
  if (!normalizedUsername) return -1;
  const indexed = usernameIndexCache.get(normalizedUsername);
  if (Number.isInteger(indexed) && users[indexed]?.username === normalizedUsername) {
    return indexed;
  }
  return users.findIndex((item) => item?.username === normalizedUsername);
};

// hasValidToken：判断是否具备指定状态。
const hasValidToken = (user) => {
  if (!user) return false;
  const tokens = Array.isArray(user.tokens) ? user.tokens : [];
  if (tokens.some((entry) => entry?.token && !isTokenExpired(entry.expiresAt))) {
    return true;
  }
  if (user.token && !isTokenExpired(user.tokenExpiresAt)) {
    return true;
  }
  return false;
};

// pbkdf2Async?处理 pbkdf2Async 相关逻辑。
const pbkdf2Async = (password, salt, iterations, keylen, digest) =>
  new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });

// hashPassword?处理 hashPassword 相关逻辑。
const hashPassword = async (password, salt = crypto.randomBytes(16)) => {
  const iterations = 120000;
  const keylen = 64;
  const digest = 'sha512';
  const hash = await pbkdf2Async(password, salt, iterations, keylen, digest);
  return {
    passwordHash: hash.toString('hex'),
    salt: salt.toString('hex'),
    iterations,
    keylen,
    digest,
  };
};

// verifyPassword?处理 verifyPassword 相关逻辑。
const verifyPassword = async (password, user) => {
  if (!user.passwordHash || !user.salt) {
    return false;
  }
  const hash = await pbkdf2Async(
    password,
    Buffer.from(user.salt, 'hex'),
    user.iterations || 120000,
    user.keylen || 64,
    user.digest || 'sha512'
  );
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (stored.length !== hash.length) {
    return false;
  }
  return crypto.timingSafeEqual(stored, hash);
};

// recordLoginAttempt?处理 recordLoginAttempt 相关逻辑。
const recordLoginAttempt = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
    return;
  }
  loginAttempts.set(key, { ...entry, count: entry.count + 1 });
};

// clearLoginAttempts：清理无效或过期数据。
const clearLoginAttempts = (key) => {
  loginAttempts.delete(key);
};

// isLockedOut：判断条件是否成立。
const isLockedOut = (key) => {
  const entry = loginAttempts.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
};

// 路由：POST /register。
router.post('/register', async (req, res) => {
  try {
    const { username, password } = toPlainObject(req.body);
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < MIN_USERNAME_LEN || trimmedUsername.length > MAX_USERNAME_LEN) {
      res.status(400).json({
        success: false,
        message: '用户名长度需在 3-32 个字符之间。',
      });
      return;
    }

    if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
      res.status(400).json({ success: false, message: '密码长度需在 8-128 个字符之间。' });
      return;
    }

    const normalized = normalizeUsername(trimmedUsername);
    const hashed = await hashPassword(password);
    const mutation = await mutateUsers(
      (users) => {
        if (findUserIndexByUsername(users, normalized) >= 0) {
          return { changed: false, result: { conflict: true } };
        }
        const uid = getNextUid(users);
        users.push({
          uid,
          username: normalized,
          ...hashed,
          createdAt: new Date().toISOString(),
          friends: [],
          signature: DEFAULT_SIGNATURE,
          avatar: '',
          nickname: trimmedUsername,
          gender: '',
          birthday: '',
          country: '',
          province: '',
          region: '',
        });
        return { changed: true, result: { conflict: false } };
      },
      { defaultChanged: false }
    );
    if (mutation.result?.conflict) {
      res.status(409).json({ success: false, message: '用户名已存在。' });
      return;
    }
    res.json({ success: true, message: '注册成功，请登录。' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: '注册失败，请稍后重试。' });
  }
});

// 路由：POST /login。
router.post('/login', async (req, res) => {
  try {
    const { username, password } = toPlainObject(req.body);
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const trimmedUsername = username.trim();
    if (
      !trimmedUsername ||
      trimmedUsername.length > MAX_USERNAME_LEN ||
      !password ||
      password.length > MAX_PASSWORD_LEN
    ) {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const normalized = normalizeUsername(trimmedUsername);
    const lockKey = `${req.ip}-${normalized}`;
    if (isLockedOut(lockKey)) {
      res.status(429).json({
        success: false,
        message: '尝试次数过多，请稍后再试。',
      });
      return;
    }

    const mutation = await mutateUsers(
      async (users) => {
        const userIndex = findUserIndexByUsername(users, normalized);
        const user = users[userIndex];
        const isLegacy = Boolean(user && user.password);
        const isMatch = user
          ? isLegacy
            ? user.password === password
            : await verifyPassword(password, user)
          : false;

        if (!isMatch) {
          return { changed: false, result: { success: false } };
        }

        if (isLegacy) {
          const hashed = await hashPassword(password);
          users[userIndex] = {
            uid: user.uid,
            username: normalized,
            ...hashed,
            createdAt: user.createdAt || new Date().toISOString(),
            friends: Array.isArray(user.friends) ? user.friends : [],
            signature: typeof user.signature === 'string' ? user.signature : '',
            nickname: typeof user.nickname === 'string' ? user.nickname : normalized,
            gender: typeof user.gender === 'string' ? user.gender : '',
            birthday: typeof user.birthday === 'string' ? user.birthday : '',
            country: typeof user.country === 'string' ? user.country : '',
            province: typeof user.province === 'string' ? user.province : '',
            region: typeof user.region === 'string' ? user.region : '',
            migratedAt: new Date().toISOString(),
          };
        }

        const { token, expiresAt } = issueToken();
        const existingTokens = Array.isArray(users[userIndex].tokens)
          ? users[userIndex].tokens.filter((entry) => entry?.token !== token)
          : [];
        existingTokens.push({ token, expiresAt });
        users[userIndex] = {
          ...users[userIndex],
          token,
          tokenExpiresAt: expiresAt,
          tokens: existingTokens,
          lastLoginAt: new Date().toISOString(),
          online: false,
        };
        return {
          changed: true,
          result: {
            success: true,
            token,
            expiresAt,
            user: { ...users[userIndex] },
          },
        };
      },
      { defaultChanged: false }
    );

    const loginResult = mutation.result;
    if (!loginResult?.success) {
      recordLoginAttempt(lockKey);
      res.status(401).json({ success: false, message: '用户名或密码错误。' });
      return;
    }

    clearLoginAttempts(lockKey);
    appendAuthCookie(res, req, loginResult.token, loginResult.expiresAt);

    res.json({
      success: true,
      message: '登录成功。',
      token: loginResult.token,
      tokenExpiresAt: loginResult.expiresAt,
      uid: loginResult.user.uid,
      username: loginResult.user.username,
      avatar: loginResult.user.avatar || '',
      nickname: loginResult.user.nickname || loginResult.user.username,
      signature: loginResult.user.signature || '',
      gender: loginResult.user.gender || '',
      birthday: loginResult.user.birthday || '',
      country: loginResult.user.country || '',
      province: loginResult.user.province || '',
      region: loginResult.user.region || '',
      hasSuicideIntent: hasSuicideIntent(loginResult.user),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: '登录失败，请稍后重试。' });
  }
});

// revokeAuthenticatedSession?处理 revokeAuthenticatedSession 相关逻辑。
const revokeAuthenticatedSession = async (req, res, { clearCookie = true } = {}) => {
  const token = extractToken(req);
  const uid = Number(req.auth?.user?.uid);
  let revokedTokenId = '';
  await mutateUsers(
    async (users) => {
      const userIndex = users.findIndex((item) => item.uid === uid);
      if (userIndex < 0) {
        return { changed: false };
      }
      const revoked = await revokeCurrentToken(users, userIndex, token);
      revokedTokenId = revoked.tokenId || '';
      const wasOnline = users[userIndex].online === true;
      if (wasOnline) {
        users[userIndex] = {
          ...users[userIndex],
          online: false,
        };
      }
      return { changed: Boolean(revoked.touched || wasOnline) };
    },
    { defaultChanged: false }
  );
  if (clearCookie) {
    clearAuthCookie(res, req);
  }
  res.json({ success: true, revokedTokenId });
};

// 路由：POST /logout。
router.post('/logout', authenticate, asyncRoute(async (req, res) => {
  await revokeAuthenticatedSession(req, res, { clearCookie: true });
}));

// 路由：POST /session/revoke。
router.post('/session/revoke', authenticate, asyncRoute(async (req, res) => {
  await revokeAuthenticatedSession(req, res, { clearCookie: true });
}));

// 路由：GET /profile。
router.get('/profile', authenticate, asyncRoute(async (req, res) => {
  const { user } = req.auth;
  res.json({
    success: true,
    user: {
      uid: user.uid,
      username: user.username,
      nickname: user.nickname || user.username,
      signature: user.signature || DEFAULT_SIGNATURE,
      gender: user.gender || '',
      birthday: user.birthday || '',
      country: user.country || '',
      province: user.province || '',
      region: user.region || '',
      avatar: user.avatar || '',
      hasSuicideIntent: hasSuicideIntent(user),
    },
  });
}));

// 路由：POST /profile。
router.post('/profile', authenticate, asyncRoute(async (req, res) => {
  const uid = Number(req.auth?.user?.uid);
  const payload = toPlainObject(req.body);
  const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  const gender = typeof payload.gender === 'string' ? payload.gender.trim() : '';
  const birthday = typeof payload.birthday === 'string' ? payload.birthday.trim() : '';
  const country = typeof payload.country === 'string' ? payload.country.trim() : '';
  const province = typeof payload.province === 'string' ? payload.province.trim() : '';
  const region = typeof payload.region === 'string' ? payload.region.trim() : '';
  let avatar = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'avatar')) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    avatar = normalizeAvatar(payload.avatar, baseUrl);
    if (avatar === null) {
      res.status(400).json({ success: false, message: '头像格式无效。' });
      return;
    }
  }

  if (nickname.length > MAX_NICKNAME_LEN) {
    res.status(400).json({
      success: false,
      message: '\u6635\u79f0\u957f\u5ea6\u8fc7\u957f\u3002',
    });
    return;
  }
  if (signature.length > MAX_SIGNATURE_LEN) {
    res.status(400).json({
      success: false,
      message: '\u4e2a\u7b7e\u957f\u5ea6\u8fc7\u957f\u3002',
    });
    return;
  }

  const mutation = await mutateUsers(
    (users) => {
      const userIndex = users.findIndex((item) => item.uid === uid);
      if (userIndex < 0) {
        return { changed: false, result: null };
      }
      const nextUser = {
        ...users[userIndex],
        nickname: nickname || users[userIndex].nickname || users[userIndex].username,
        signature: signature || DEFAULT_SIGNATURE,
        gender,
        birthday,
        country,
        province,
        region,
      };
      if (avatar !== null) {
        nextUser.avatar = avatar;
      }
      users[userIndex] = nextUser;
      return { changed: true, result: { ...nextUser } };
    },
    { defaultChanged: false }
  );

  if (!mutation.result) {
    res.status(404).json({ success: false, message: '用户不存在。' });
    return;
  }

  res.json({
    success: true,
    user: {
      uid: mutation.result.uid,
      username: mutation.result.username,
      nickname: mutation.result.nickname || mutation.result.username,
      signature: mutation.result.signature || DEFAULT_SIGNATURE,
      gender: mutation.result.gender || '',
      birthday: mutation.result.birthday || '',
      country: mutation.result.country || '',
      province: mutation.result.province || '',
      region: mutation.result.region || '',
      avatar: mutation.result.avatar || '',
      hasSuicideIntent: hasSuicideIntent(mutation.result),
    },
  });
}));

export {
  ensureStorage,
  readUsers,
  readUsersCached,
  mutateUsers,
  findUserByToken,
  hasValidToken,
  invalidateUsersCache,
  getUsersCacheInfo,
  forceRefreshUsersCache,
};
export default router;









