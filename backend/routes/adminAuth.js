/**
 * Module: admin auth routes and middleware.
 * Purpose: provide dedicated admin login/session with isolated storage.
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const ADMIN_USERS_PATH = path.join(DATA_DIR, 'admin-users.json');
const ADMIN_USERS_PATH_TMP = path.join(DATA_DIR, 'admin-users.json.tmp');

const ADMIN_USERS_CACHE_TTL_MS = 5000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const MIN_USERNAME_LEN = 3;
const MAX_USERNAME_LEN = 64;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

let adminsCache = null;
let adminsCacheAt = 0;
let adminsLoadInFlight = null;
let adminsWriteQueue = Promise.resolve();
let ensureStorageInFlight = null;
let storageReady = false;
const loginAttempts = new Map();

const router = express.Router();

const parsePositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const toBoolean = (value, fallback = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
};

const getNodeEnv = () => String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const getAdminApiToken = () => String(process.env.ADMIN_API_TOKEN || '').trim();
const getAdminAuthCookieName = () =>
  String(process.env.ADMIN_AUTH_COOKIE_NAME || 'xinchat_admin_token').trim() || 'xinchat_admin_token';
const getAdminTokenTtlHours = () =>
  parsePositiveInt(process.env.ADMIN_TOKEN_TTL_HOURS, 24, 1, 24 * 365);
const isBootstrapForceResetEnabled = () =>
  toBoolean(process.env.ADMIN_BOOTSTRAP_FORCE_RESET_PASSWORD, false);
const isDefaultBootstrapEnabled = () => {
  const raw = String(process.env.ADMIN_DEFAULT_BOOTSTRAP_ENABLED || '').trim().toLowerCase();
  if (raw) {
    return toBoolean(raw, false);
  }
  return getNodeEnv() !== 'production';
};
const isAdminInsecureEnabled = () => {
  const raw = String(process.env.ADMIN_ENABLE_INSECURE || '').trim().toLowerCase();
  if (raw) {
    return toBoolean(raw, false);
  }
  return getNodeEnv() !== 'production';
};

const getBootstrapAdminConfig = () => {
  const username = normalizeUsername(process.env.ADMIN_BOOTSTRAP_USERNAME || '');
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  const displayName = String(process.env.ADMIN_BOOTSTRAP_DISPLAY_NAME || '').trim();
  if (username || password) {
    return { username, password, displayName };
  }
  if (!isDefaultBootstrapEnabled()) {
    return { username: '', password: '', displayName: '' };
  }
  const fallbackUsername = normalizeUsername(
    String(process.env.ADMIN_DEFAULT_BOOTSTRAP_USERNAME || 'admin')
  );
  const fallbackPassword = String(process.env.ADMIN_DEFAULT_BOOTSTRAP_PASSWORD || 'Ss112211');
  const fallbackDisplayName =
    String(process.env.ADMIN_DEFAULT_BOOTSTRAP_DISPLAY_NAME || '').trim() || 'Admin';
  return {
    username: fallbackUsername,
    password: fallbackPassword,
    displayName: fallbackDisplayName,
  };
};

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

const shouldUseSecureCookie = (req) => {
  const env = String(process.env.ADMIN_AUTH_COOKIE_SECURE || '').trim().toLowerCase();
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  if (forwardedProto.includes('https')) return true;
  if (req?.secure) return true;
  return getNodeEnv() === 'production';
};

const appendAdminCookie = (res, req, token, expiresAt) => {
  const safeToken = String(token || '').trim();
  const ts = expiresAt ? Date.parse(String(expiresAt)) : 0;
  if (!safeToken || !Number.isFinite(ts) || ts <= Date.now()) return;
  const maxAgeSec = Math.max(1, Math.floor((ts - Date.now()) / 1000));
  const parts = [
    `${getAdminAuthCookieName()}=${encodeURIComponent(safeToken)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    `Expires=${new Date(Date.now() + maxAgeSec * 1000).toUTCString()}`,
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (shouldUseSecureCookie(req)) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
};

const clearAdminCookie = (res, req) => {
  const parts = [
    `${getAdminAuthCookieName()}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (shouldUseSecureCookie(req)) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
};

const extractTokenFromCookie = (req) => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  return String(cookies[getAdminAuthCookieName()] || '').trim();
};

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

const verifyPassword = async (password, admin) => {
  if (!admin?.passwordHash || !admin?.salt) return false;
  const hash = await pbkdf2Async(
    password,
    Buffer.from(admin.salt, 'hex'),
    admin.iterations || 120000,
    admin.keylen || 64,
    admin.digest || 'sha512'
  );
  const stored = Buffer.from(admin.passwordHash, 'hex');
  if (stored.length !== hash.length) return false;
  return crypto.timingSafeEqual(stored, hash);
};

const isTokenExpired = (expiresAt) => {
  const ts = expiresAt ? Date.parse(String(expiresAt)) : 0;
  if (!ts || Number.isNaN(ts)) return true;
  return Date.now() > ts;
};

const issueAdminToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + getAdminTokenTtlHours() * 60 * 60 * 1000).toISOString();
  return { token, expiresAt };
};

const ensureStorage = async () => {
  if (storageReady) return;
  if (ensureStorageInFlight) {
    await ensureStorageInFlight;
    return;
  }
  ensureStorageInFlight = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.access(ADMIN_USERS_PATH);
    } catch {
      await fs.writeFile(ADMIN_USERS_PATH, '[]', 'utf-8');
    }
    storageReady = true;
  })();
  try {
    await ensureStorageInFlight;
  } finally {
    ensureStorageInFlight = null;
  }
};

const persistAdminsSnapshot = async (admins) => {
  const payload = JSON.stringify(Array.isArray(admins) ? admins : [], null, 2);
  await fs.writeFile(ADMIN_USERS_PATH_TMP, payload, 'utf-8');
  await fs.rename(ADMIN_USERS_PATH_TMP, ADMIN_USERS_PATH);
  adminsCache = Array.isArray(admins) ? admins : [];
  adminsCacheAt = Date.now();
};

const removeExpiredTokensFromAdmin = (admin) => {
  let changed = false;
  const list = Array.isArray(admin?.tokens) ? admin.tokens : [];
  const nextTokens = list.filter(
    (entry) =>
      entry &&
      typeof entry.token === 'string' &&
      entry.token &&
      typeof entry.expiresAt === 'string' &&
      !isTokenExpired(entry.expiresAt)
  );
  if (nextTokens.length !== list.length) {
    admin.tokens = nextTokens;
    changed = true;
  }
  if (admin?.token && isTokenExpired(admin.tokenExpiresAt)) {
    admin.token = '';
    admin.tokenExpiresAt = '';
    changed = true;
  }
  return changed;
};

const normalizeAdminRecord = (record, { fallbackId, nowIso }) => {
  if (!record || typeof record !== 'object') return null;
  const username = normalizeUsername(record.username);
  if (!username || username.length < MIN_USERNAME_LEN || username.length > MAX_USERNAME_LEN) {
    return null;
  }
  const idRaw = Number(record.id);
  const id = Number.isInteger(idRaw) && idRaw > 0 ? idRaw : fallbackId;
  const displayName = String(record.displayName || record.nickname || username).trim() || username;
  const role = String(record.role || 'admin').trim() || 'admin';

  const normalized = {
    id,
    username,
    displayName,
    role,
    passwordHash: String(record.passwordHash || ''),
    salt: String(record.salt || ''),
    iterations: parsePositiveInt(record.iterations, 120000, 10000, 400000),
    keylen: parsePositiveInt(record.keylen, 64, 16, 256),
    digest: String(record.digest || 'sha512').trim() || 'sha512',
    tokens: Array.isArray(record.tokens) ? record.tokens : [],
    token: typeof record.token === 'string' ? record.token : '',
    tokenExpiresAt: typeof record.tokenExpiresAt === 'string' ? record.tokenExpiresAt : '',
    createdAt: typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : nowIso,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : nowIso,
    lastLoginAt: typeof record.lastLoginAt === 'string' ? record.lastLoginAt : '',
  };

  removeExpiredTokensFromAdmin(normalized);
  return normalized;
};

const ensureBootstrapAdminInMemory = async (admins) => {
  const bootstrap = getBootstrapAdminConfig();
  if (!bootstrap.username || !bootstrap.password) {
    return false;
  }
  if (
    bootstrap.username.length < MIN_USERNAME_LEN ||
    bootstrap.username.length > MAX_USERNAME_LEN ||
    bootstrap.password.length < MIN_PASSWORD_LEN ||
    bootstrap.password.length > MAX_PASSWORD_LEN
  ) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const index = admins.findIndex((item) => item?.username === bootstrap.username);
  if (index >= 0) {
    if (!isBootstrapForceResetEnabled()) {
      return false;
    }
    const currentAdmin = admins[index];
    const alreadyMatch = await verifyPassword(bootstrap.password, currentAdmin);
    const targetDisplayName =
      bootstrap.displayName || currentAdmin.displayName || currentAdmin.username;
    if (alreadyMatch && currentAdmin.displayName === targetDisplayName) {
      return false;
    }
    const hashed = await hashPassword(bootstrap.password);
    admins[index] = {
      ...currentAdmin,
      ...hashed,
      displayName: targetDisplayName,
      role: currentAdmin.role || 'super_admin',
      updatedAt: nowIso,
    };
    return true;
  }

  const hashed = await hashPassword(bootstrap.password);
  const nextId =
    admins.reduce((maxValue, item) => {
      const id = Number(item?.id);
      return Number.isInteger(id) && id > maxValue ? id : maxValue;
    }, 0) + 1;
  admins.push({
    id: nextId,
    username: bootstrap.username,
    displayName: bootstrap.displayName || bootstrap.username,
    role: 'super_admin',
    ...hashed,
    tokens: [],
    token: '',
    tokenExpiresAt: '',
    createdAt: nowIso,
    updatedAt: nowIso,
    lastLoginAt: '',
  });
  return true;
};

const loadAdminsFromDisk = async () => {
  await ensureStorage();
  const raw = await fs.readFile(ADMIN_USERS_PATH, 'utf-8');
  const parsed = JSON.parse(raw || '[]');
  const list = Array.isArray(parsed) ? parsed : [];
  const nowIso = new Date().toISOString();

  let maxId = 0;
  const normalized = [];
  list.forEach((entry, index) => {
    const fallbackId = Math.max(maxId + 1, 1 + index);
    const item = normalizeAdminRecord(entry, { fallbackId, nowIso });
    if (!item) return;
    maxId = Math.max(maxId, item.id);
    normalized.push(item);
  });

  const seen = new Set();
  const deduped = normalized.filter((item) => {
    if (seen.has(item.username)) return false;
    seen.add(item.username);
    return true;
  });

  let changed = deduped.length !== list.length;
  const bootstrapChanged = await ensureBootstrapAdminInMemory(deduped);
  if (bootstrapChanged) changed = true;
  if (changed) {
    await persistAdminsSnapshot(deduped);
  } else {
    adminsCache = deduped;
    adminsCacheAt = Date.now();
  }
  return adminsCache || deduped;
};

const readAdminsCached = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();
  if (
    !forceRefresh &&
    Array.isArray(adminsCache) &&
    now - adminsCacheAt < ADMIN_USERS_CACHE_TTL_MS
  ) {
    return adminsCache;
  }
  if (!forceRefresh && adminsLoadInFlight) {
    return adminsLoadInFlight;
  }
  const loader = loadAdminsFromDisk();
  if (!forceRefresh) {
    adminsLoadInFlight = loader;
  }
  try {
    return await loader;
  } finally {
    if (!forceRefresh) {
      adminsLoadInFlight = null;
    }
  }
};

const mutateAdmins = async (mutator, { defaultChanged = true } = {}) => {
  if (typeof mutator !== 'function') {
    throw new TypeError('mutateAdmins requires a function mutator.');
  }
  const run = adminsWriteQueue.then(async () => {
    const latestAdmins = await readAdminsCached({ forceRefresh: true });
    const draft = JSON.parse(JSON.stringify(latestAdmins));
    const mutation = await mutator(draft);
    const changed =
      typeof mutation?.changed === 'boolean' ? mutation.changed : Boolean(defaultChanged);
    if (changed) {
      await persistAdminsSnapshot(draft);
    } else {
      adminsCache = latestAdmins;
      adminsCacheAt = Date.now();
    }
    return {
      changed,
      result: mutation?.result,
      admins: changed ? draft : latestAdmins,
    };
  });
  adminsWriteQueue = run.catch(() => {});
  return run;
};

const recordLoginAttempt = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
    return;
  }
  loginAttempts.set(key, { ...entry, count: entry.count + 1 });
};

const clearLoginAttempts = (key) => {
  loginAttempts.delete(key);
};

const isLockedOut = (key) => {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
};

const removeTokenFromAdmin = (admin, token) => {
  if (!admin || !token) return false;
  let changed = false;
  if (Array.isArray(admin.tokens)) {
    const next = admin.tokens.filter((entry) => entry?.token !== token);
    if (next.length !== admin.tokens.length) {
      admin.tokens = next;
      changed = true;
    }
  }
  if (admin.token === token) {
    admin.token = '';
    admin.tokenExpiresAt = '';
    changed = true;
  }
  return changed;
};

const resolveTokenState = (admin, token) => {
  const tokens = Array.isArray(admin?.tokens) ? admin.tokens : [];
  const entry = tokens.find((item) => item?.token === token);
  if (entry) {
    return isTokenExpired(entry.expiresAt) ? 'expired' : 'valid';
  }
  if (admin?.token === token) {
    return isTokenExpired(admin.tokenExpiresAt) ? 'expired' : 'valid';
  }
  return 'missing';
};

const findAdminByTokenLocal = (admins, token) => {
  if (!token) return { admin: null, adminIndex: -1, touched: false };
  let touched = false;
  for (let index = 0; index < admins.length; index += 1) {
    const admin = admins[index];
    const state = resolveTokenState(admin, token);
    if (state === 'valid') {
      return { admin, adminIndex: index, touched };
    }
    if (state === 'expired') {
      if (removeTokenFromAdmin(admin, token)) {
        touched = true;
      }
      return { admin: null, adminIndex: -1, touched };
    }
  }
  return { admin: null, adminIndex: -1, touched };
};

const toAdminPublic = (admin, source = 'admin_account') => ({
  source,
  id: Number(admin?.id) || 0,
  username: String(admin?.username || ''),
  displayName: String(admin?.displayName || admin?.username || ''),
  role: String(admin?.role || 'admin'),
  lastLoginAt: typeof admin?.lastLoginAt === 'string' ? admin.lastLoginAt : '',
});

const extractTokenFromAuthorization = (req) => {
  const auth = String(req?.headers?.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
};

const bodyToken = (req) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  const fromBody = String(body.adminToken || body.token || '').trim();
  if (fromBody) return fromBody;
  return String(query.adminToken || '').trim();
};

const parseAdminToken = (req) => {
  const authToken = extractTokenFromAuthorization(req);
  if (authToken) return authToken;
  const headerToken = String(req?.headers?.['x-admin-token'] || '').trim();
  if (headerToken) return headerToken;
  const cookieToken = extractTokenFromCookie(req);
  if (cookieToken) return cookieToken;
  return bodyToken(req);
};

const authenticateAdminToken = async (token) => {
  const safeToken = String(token || '').trim();
  if (!safeToken) {
    return { success: false, code: 'missing' };
  }
  const staticToken = getAdminApiToken();
  if (staticToken && safeToken === staticToken) {
    return {
      success: true,
      principal: {
        source: 'env_token',
        id: 0,
        username: 'env_admin',
        displayName: 'Env Admin',
        role: 'super_admin',
        lastLoginAt: '',
      },
    };
  }

  const mutation = await mutateAdmins(
    (admins) => {
      const found = findAdminByTokenLocal(admins, safeToken);
      return {
        changed: found.touched,
        result: found,
      };
    },
    { defaultChanged: false }
  );

  const found = mutation.result || { admin: null, adminIndex: -1 };
  if (!found.admin) {
    return { success: false, code: 'invalid' };
  }
  return {
    success: true,
    principal: toAdminPublic(found.admin, 'admin_account'),
  };
};

const requireAuthenticatedAdminToken = async (req, res, next) => {
  try {
    const token = parseAdminToken(req);
    if (!token) {
      res.status(401).json({ success: false, message: 'Admin token required.' });
      return;
    }
    const auth = await authenticateAdminToken(token);
    if (!auth.success) {
      res.status(401).json({ success: false, message: 'Admin token invalid.' });
      return;
    }
    req.adminAuth = auth.principal;
    req.adminToken = token;
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    res.status(500).json({ success: false, message: 'Admin auth failed.' });
  }
};

const requireAdminAccess = async (req, res, next) => {
  try {
    const token = parseAdminToken(req);
    if (token) {
      const auth = await authenticateAdminToken(token);
      if (!auth.success) {
        res.status(401).json({ success: false, message: 'Admin token invalid.' });
        return;
      }
      req.adminAuth = auth.principal;
      req.adminToken = token;
      next();
      return;
    }

    if (getAdminApiToken()) {
      res.status(401).json({ success: false, message: 'Admin token required.' });
      return;
    }

    if (!isAdminInsecureEnabled()) {
      res.status(403).json({
        success: false,
        message: 'Admin API disabled: set admin bootstrap account or ADMIN_ENABLE_INSECURE=true.',
      });
      return;
    }

    req.adminAuth = {
      source: 'insecure_mode',
      id: 0,
      username: 'insecure_admin',
      displayName: 'Insecure Admin',
      role: 'insecure_admin',
      lastLoginAt: '',
    };
    next();
  } catch (error) {
    console.error('Require admin access error:', error);
    res.status(500).json({ success: false, message: 'Admin authorization failed.' });
  }
};

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const usernameRaw = String(payload.username || '');
    const password = String(payload.password || '');
    const normalized = normalizeUsername(usernameRaw);

    if (
      normalized.length < MIN_USERNAME_LEN ||
      normalized.length > MAX_USERNAME_LEN ||
      password.length < MIN_PASSWORD_LEN ||
      password.length > MAX_PASSWORD_LEN
    ) {
      res.status(400).json({ success: false, message: 'Invalid username or password.' });
      return;
    }

    const lockKey = `${req.ip}-${normalized}`;
    if (isLockedOut(lockKey)) {
      res.status(429).json({
        success: false,
        message: 'Too many login attempts. Please retry later.',
      });
      return;
    }

    const mutation = await mutateAdmins(
      async (admins) => {
        const index = admins.findIndex((item) => item?.username === normalized);
        const admin = admins[index];
        const match = admin ? await verifyPassword(password, admin) : false;
        if (!match) {
          return {
            changed: false,
            result: { success: false },
          };
        }
        const { token, expiresAt } = issueAdminToken();
        const nowIso = new Date().toISOString();
        const existing = Array.isArray(admin.tokens)
          ? admin.tokens.filter((item) => !isTokenExpired(item?.expiresAt))
          : [];
        existing.push({ token, expiresAt, issuedAt: nowIso, lastUsedAt: nowIso });
        admins[index] = {
          ...admins[index],
          token,
          tokenExpiresAt: expiresAt,
          tokens: existing,
          lastLoginAt: nowIso,
          updatedAt: nowIso,
        };
        return {
          changed: true,
          result: {
            success: true,
            token,
            expiresAt,
            admin: toAdminPublic(admins[index], 'admin_account'),
          },
        };
      },
      { defaultChanged: false }
    );

    const result = mutation.result;
    if (!result?.success) {
      recordLoginAttempt(lockKey);
      res.status(401).json({ success: false, message: 'Admin username or password invalid.' });
      return;
    }

    clearLoginAttempts(lockKey);
    appendAdminCookie(res, req, result.token, result.expiresAt);
    res.json({
      success: true,
      data: {
        token: result.token,
        tokenExpiresAt: result.expiresAt,
        admin: result.admin,
      },
    });
  })
);

router.get(
  '/me',
  requireAuthenticatedAdminToken,
  asyncRoute(async (req, res) => {
    res.json({
      success: true,
      data: req.adminAuth || null,
    });
  })
);

router.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const token = parseAdminToken(req);
    if (!token) {
      clearAdminCookie(res, req);
      res.json({ success: true, data: { revoked: false } });
      return;
    }

    const staticToken = getAdminApiToken();
    if (staticToken && token === staticToken) {
      clearAdminCookie(res, req);
      res.json({ success: true, data: { revoked: false, source: 'env_token' } });
      return;
    }

    const mutation = await mutateAdmins(
      (admins) => {
        let changed = false;
        for (let index = 0; index < admins.length; index += 1) {
          if (removeTokenFromAdmin(admins[index], token)) {
            changed = true;
            admins[index].updatedAt = new Date().toISOString();
          }
        }
        return { changed, result: { revoked: changed } };
      },
      { defaultChanged: false }
    );
    clearAdminCookie(res, req);
    res.json({
      success: true,
      data: mutation.result || { revoked: false },
    });
  })
);

const resetAdminAuthForTests = () => {
  adminsCache = null;
  adminsCacheAt = 0;
  adminsLoadInFlight = null;
  adminsWriteQueue = Promise.resolve();
  ensureStorageInFlight = null;
  storageReady = false;
  loginAttempts.clear();
};

export { parseAdminToken, authenticateAdminToken, requireAdminAccess, resetAdminAuthForTests };
export default router;
