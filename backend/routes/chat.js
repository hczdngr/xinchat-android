/**
 * Chat routes:
 * - message send/fetch
 * - media upload helpers
 * - sticker storage and overview stats
 */


import express from 'express';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { createAuthenticateMiddleware, extractToken } from './session.js';
import { getGroupById, readGroups } from './groups.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { createMemoryRateLimiter } from '../assistant/rateLimiter.js';
import { generateReplySuggestions } from '../assistant/replyAssistantService.js';
import {
  assessOutgoingTextRisk,
  buildConversationRiskProfile,
  recordRiskDecision,
} from '../risk/scorer.js';
import { appendRiskAppeal, upsertRiskIgnore } from '../risk/stateStore.js';
import { buildOverviewInlineSummary } from '../summary/service.js';
import { decideConversationRanking, recordRecoFeedback } from '../reco/index.js';
import { buildSharedContextFeatures } from '../reco/featureBuilder.js';
import { atomicWriteFile } from '../utils/filePersistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const USERFILE_DIR = path.join(DATA_DIR, 'userfile');
const USERFILE_INDEX_PATH = path.join(USERFILE_DIR, 'index.json');
const STICKER_DIR = path.join(DATA_DIR, 'stickers');
const STICKER_INDEX_PATH = path.join(STICKER_DIR, 'index.json');
const CHAT_JSON_PATH = path.join(DATA_DIR, 'chat.json');
const DB_PATH = path.join(DATA_DIR, 'chat.sqlite');
const DB_LOCK_PATH = path.join(DATA_DIR, 'chat.sqlite.lock');
const STICKER_INDEX_LOCK_PATH = path.join(STICKER_DIR, 'index.lock');
const USERFILE_INDEX_LOCK_PATH = path.join(USERFILE_DIR, 'index.lock');

const router = express.Router();
const ALLOWED_TYPES = new Set(['image', 'video', 'voice', 'text', 'gif', 'file', 'card', 'call']);
const ALLOWED_TARGET_TYPES = new Set(['private', 'group']);
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const FLUSH_DEBOUNCE_MS = Math.max(
  50,
  Number.parseInt(String(process.env.CHAT_DB_FLUSH_DEBOUNCE_MS || '450'), 10) || 450
);
const FLUSH_MAX_DELAY_MS = Math.max(
  FLUSH_DEBOUNCE_MS,
  Number.parseInt(String(process.env.CHAT_DB_FLUSH_MAX_DELAY_MS || '2200'), 10) || 2200
);
let chatNotifier = null;
const replySuggestLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.REPLY_SUGGEST_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.REPLY_SUGGEST_RATE_MAX || '120'), 10) || 120,
});
const chatRiskQueryLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RISK_PROFILE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RISK_PROFILE_RATE_MAX || '90'), 10) || 90,
});
const chatRiskEvaluateLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RISK_EVALUATE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RISK_EVALUATE_RATE_MAX || '90'), 10) || 90,
});
const chatRiskIgnoreLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RISK_IGNORE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RISK_IGNORE_RATE_MAX || '30'), 10) || 30,
});
const chatRiskAppealLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RISK_APPEAL_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RISK_APPEAL_RATE_MAX || '20'), 10) || 20,
});
const CHAT_REALTIME_RISK_MAX_TEXT_CHARS = 600;

const trackRouteEvent = (req, payload) => {
  void trackEventSafe(
    createRequestEvent(req, {
      actorUid: Number(req?.auth?.user?.uid) || 0,
      ...payload,
    })
  );
};

const isValidType = (value) => typeof value === 'string' && ALLOWED_TYPES.has(value);
const isValidTargetType = (value) =>
  typeof value === 'string' && ALLOWED_TARGET_TYPES.has(value);
const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
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
const makeReplySuggestRateKey = (req) => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const ipRaw = String(
    req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || ''
  );
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || ip || 'unknown'}:reply_suggest`;
};
const makeRiskRateKey = (req, scope = 'risk') => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const ipRaw = String(
    req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || ''
  );
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || ip || 'unknown'}:${scope}`;
};
const DATA_IMAGE_RE = /^data:(image\/(png|jpe?g|gif|webp));base64,/i;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const DATA_URL_RE = /^data:([^;]+);base64,/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanupAt = 0;
const MAX_STICKER_BYTES = 20 * 1024 * 1024;
const MAX_STICKERS_PER_USER = 300;
const MAX_STICKER_BATCH_UPLOAD = 9;
const ALLOWED_STICKER_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_CREATED_AT_FUTURE_DRIFT_MS = 5 * 60 * 1000;
const MAX_UID = Number.parseInt(String(process.env.MAX_UID || '2147483647'), 10);
const SAFE_MAX_UID = Number.isInteger(MAX_UID) && MAX_UID > 0 ? MAX_UID : 2147483647;
const isValidUid = (value) =>
  Number.isInteger(value) && value > 0 && value <= SAFE_MAX_UID;

let sqlModule = null;
let db = null;
let flushTimer = null;
let flushInFlight = false;
let pendingFlush = false;
let flushWindowStartAt = 0;
let dbDirtyCount = 0;
let chatStorageReady = false;
let chatStoragePromise = null;
let stickerStoreLoaded = false;
let stickerStoreCache = {
  version: 1,
  byHash: {},
  users: {},
  updatedAt: '',
};
let stickerStoreWriteChain = Promise.resolve();
let userfileIndexLoaded = false;
let userfileIndexCache = {};
let userfileIndexWriteChain = Promise.resolve();
const preparedStatements = new Map();

const parseImageDataUrl = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(DATA_IMAGE_RE);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = match[2].toLowerCase() === 'jpeg' ? 'jpg' : match[2].toLowerCase();
  const base64 = value.slice(match[0].length);
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return null;
    return { buffer, mime, ext };
  } catch {
    return null;
  }
};

const parseDataUrl = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(DATA_URL_RE);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = value.slice(match[0].length);
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return null;
    return { buffer, mime };
  } catch {
    return null;
  }
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const clonePlain = (value, fallback = {}) => {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return Array.isArray(fallback) ? [] : {};
  }
};

const readUserfileIndex = async () => {
  if (userfileIndexLoaded) {
    return clonePlain(userfileIndexCache, {});
  }
  try {
    const raw = await fs.readFile(USERFILE_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    userfileIndexCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    userfileIndexCache = {};
  }
  userfileIndexLoaded = true;
  return clonePlain(userfileIndexCache, {});
};

const writeUserfileIndex = async (index) => {
  const snapshot = index && typeof index === 'object' ? index : {};
  userfileIndexCache = clonePlain(snapshot, {});
  userfileIndexLoaded = true;
  userfileIndexWriteChain = userfileIndexWriteChain
    .catch(() => undefined)
    .then(() =>
      atomicWriteFile(USERFILE_INDEX_PATH, JSON.stringify(userfileIndexCache, null, 2), {
        lockPath: USERFILE_INDEX_LOCK_PATH,
      })
    );
  await userfileIndexWriteChain;
};

const normalizeStickerStore = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const byHashSource = source.byHash && typeof source.byHash === 'object' ? source.byHash : {};
  const usersSource = source.users && typeof source.users === 'object' ? source.users : {};
  const byHash = {};
  Object.entries(byHashSource).forEach(([hash, item]) => {
    if (typeof hash !== 'string' || hash.trim().length < 10) return;
    const safeHash = hash.trim();
    const safeUrl = typeof item?.url === 'string' ? item.url.trim() : '';
    const safeMime = typeof item?.mime === 'string' ? item.mime.trim() : '';
    const safeExt = typeof item?.ext === 'string' ? item.ext.trim().toLowerCase() : '';
    if (!safeUrl || !safeExt || !ALLOWED_STICKER_EXTS.has(safeExt)) return;
    byHash[safeHash] = {
      hash: safeHash,
      url: safeUrl,
      mime: safeMime || `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
      ext: safeExt,
      size: Number(item?.size) || 0,
      createdAt:
        typeof item?.createdAt === 'string' && item.createdAt
          ? item.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof item?.updatedAt === 'string' && item.updatedAt
          ? item.updatedAt
          : new Date().toISOString(),
    };
  });

  const users = {};
  Object.entries(usersSource).forEach(([rawUid, entry]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    const items = Array.isArray(entry?.items) ? entry.items : [];
    const deduped = [];
    const seen = new Set();
    for (const hash of items) {
      const safeHash = typeof hash === 'string' ? hash.trim() : '';
      if (!safeHash || !byHash[safeHash] || seen.has(safeHash)) continue;
      seen.add(safeHash);
      deduped.push(safeHash);
      if (deduped.length >= MAX_STICKERS_PER_USER) break;
    }
    users[String(uid)] = {
      items: deduped,
      updatedAt:
        typeof entry?.updatedAt === 'string' && entry.updatedAt
          ? entry.updatedAt
          : new Date().toISOString(),
    };
  });
  return {
    version: 1,
    byHash,
    users,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  };
};

const ensureStickerStore = async () => {
  if (stickerStoreLoaded) return stickerStoreCache;
  try {
    const raw = await fs.readFile(STICKER_INDEX_PATH, 'utf-8');
    stickerStoreCache = normalizeStickerStore(JSON.parse(raw));
  } catch {
    stickerStoreCache = normalizeStickerStore(null);
  }
  stickerStoreLoaded = true;
  return stickerStoreCache;
};

const persistStickerStore = async () => {
  await fs.mkdir(STICKER_DIR, { recursive: true });
  const next = {
    ...stickerStoreCache,
    updatedAt: new Date().toISOString(),
  };
  stickerStoreCache = next;
  await atomicWriteFile(STICKER_INDEX_PATH, JSON.stringify(next, null, 2), {
    lockPath: STICKER_INDEX_LOCK_PATH,
  });
};

const queueStickerStorePersist = async () => {
  stickerStoreWriteChain = stickerStoreWriteChain
    .catch(() => undefined)
    .then(() => persistStickerStore());
  await stickerStoreWriteChain;
};

const getUserStickerList = (uid) => {
  const store = stickerStoreCache;
  const userEntry = store.users[String(uid)];
  const hashes = Array.isArray(userEntry?.items) ? userEntry.items : [];
  const list = [];
  for (const hash of hashes) {
    const item = store.byHash[hash];
    if (item) list.push(item);
  }
  return list;
};

const upsertUserSticker = async ({ uid, hash, ext, mime, size, url, skipPersist = false }) => {
  await ensureStickerStore();
  const now = new Date().toISOString();
  const safeExt = String(ext || '').trim().toLowerCase();
  const safeMime = String(mime || '').trim().toLowerCase();
  const safeHash = String(hash || '').trim();
  const safeUrl = String(url || '').trim();
  if (!safeHash || !safeUrl || !ALLOWED_STICKER_EXTS.has(safeExt)) {
    throw new Error('Invalid sticker format.');
  }
  const existing = stickerStoreCache.byHash[safeHash];
  stickerStoreCache.byHash[safeHash] = {
    hash: safeHash,
    ext: safeExt,
    mime: safeMime || `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`,
    size: Number(size) || 0,
    url: safeUrl,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const uidKey = String(uid);
  const entry =
    stickerStoreCache.users[uidKey] && typeof stickerStoreCache.users[uidKey] === 'object'
      ? stickerStoreCache.users[uidKey]
      : { items: [], updatedAt: now };
  const hashes = Array.isArray(entry.items) ? entry.items : [];
  const nextItems = [safeHash, ...hashes.filter((item) => item !== safeHash)].slice(
    0,
    MAX_STICKERS_PER_USER
  );
  stickerStoreCache.users[uidKey] = {
    items: nextItems,
    updatedAt: now,
  };
  if (!skipPersist) {
    await queueStickerStorePersist();
  }
  return stickerStoreCache.byHash[safeHash];
};

const pruneUserfileIndex = async (index) => {
  const next = { ...(index || {}) };
  const entries = Object.entries(next);
  for (const [hash, entry] of entries) {
    const entryPath = entry?.path;
    if (!entryPath || !(await fileExists(entryPath))) {
      delete next[hash];
    }
  }
  if (entries.length !== Object.keys(next).length) {
    await writeUserfileIndex(next);
  }
  return next;
};

const sanitizeFilename = (value) => {
  const base = path.basename(String(value || '').trim());
  if (!base) return '';
  return base.replace(/[\\/:*?"<>|]+/g, '_');
};

const guessExtension = (name, mime) => {
  const extFromName = path.extname(name || '').slice(1).toLowerCase();
  if (extFromName) return extFromName;
  const map = {
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/json': 'json',
    'text/plain': 'txt',
  };
  return map[mime] || 'bin';
};

const resolvePathWithinRoot = (rootDir, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return '';
  if (relativePath.includes('\0')) return '';
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root) return '';
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : '';
};

const cleanupUserFiles = async () => {
  const now = Date.now();
  await fs.mkdir(USERFILE_DIR, { recursive: true });
  const entries = await fs.readdir(USERFILE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const userDir = path.join(USERFILE_DIR, entry.name);
    const files = await fs.readdir(userDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const filePath = path.join(userDir, file.name);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > FILE_TTL_MS) {
          await fs.unlink(filePath);
        }
      } catch {}
    }
    const remaining = await fs.readdir(userDir).catch(() => []);
    if (remaining.length === 0) {
      await fs.rmdir(userDir).catch(() => {});
    }
  }
  const index = await readUserfileIndex();
  await pruneUserfileIndex(index);
};

const maybeCleanupUserFiles = async () => {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  await cleanupUserFiles();
};

const buildFileMeta = (name, size, mime) => {
  const uploadedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();
  return {
    name,
    size,
    mime,
    uploadedAt,
    expiresAt,
  };
};

const storeUserFileBuffer = async (buffer, senderUid, name, mime) => {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeBase = sanitizeFilename(name) || 'file';
  const indexRaw = await readUserfileIndex();
  const index = await pruneUserfileIndex(indexRaw);
  const existingPath = index[hash]?.path && (await fileExists(index[hash].path))
    ? index[hash].path
    : null;
  const ext = index[hash]?.ext || guessExtension(safeBase, mime);
  const userDir = path.join(USERFILE_DIR, String(senderUid));
  await fs.mkdir(userDir, { recursive: true });
  const filename = `${hash}.${ext}`;
  const filePath = path.join(userDir, filename);
  if (!(await fileExists(filePath))) {
    if (existingPath) {
      await fs.copyFile(existingPath, filePath);
    } else {
      await fs.writeFile(filePath, buffer);
    }
  }
  index[hash] = {
    path: filePath,
    ext,
    size: buffer.length,
    updatedAt: new Date().toISOString(),
  };
  await writeUserfileIndex(index);
  return { filename, hash };
};

const storeUserFileFromPath = async (sourcePath, senderUid, name, mime) => {
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File is too large.');
  }
  const buffer = await fs.readFile(sourcePath);
  return storeUserFileBuffer(buffer, senderUid, name, mime);
};

const storeImageBuffer = async (buffer, ext) => {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${hash}.${ext}`;
  const filePath = path.join(IMAGE_DIR, filename);
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  try {
    await fs.writeFile(filePath, buffer, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
  return { filename, hash };
};

const getImageExtFromMime = (mime) => {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  return map[String(mime || '').toLowerCase()] || '';
};

const readStreamToFile = (req, tempPath, maxBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const hash = crypto.createHash('sha256');
    const out = createWriteStream(tempPath);
    const cleanup = (error) => {
      if (finished) return;
      finished = true;
      out.destroy();
      fs.unlink(tempPath).catch(() => {});
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        cleanup(new Error('File is too large.'));
        return;
      }
      hash.update(chunk);
    });
    req.on('error', cleanup);
    out.on('error', cleanup);
    out.on('finish', () => {
      if (finished) return;
      finished = true;
      resolve({ size, hash: hash.digest('hex') });
    });
    req.pipe(out);
  });

const readStreamToBuffer = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('File is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

const findImageUrlByHash = async (hash, baseUrl) => {
  if (!hash) return '';
  for (const ext of IMAGE_EXTS) {
    const filename = `${hash}.${ext}`;
    const filePath = path.join(IMAGE_DIR, filename);
    if (await fileExists(filePath)) {
      return `${baseUrl}/uploads/images/${filename}`;
    }
  }
  return '';
};

const getSqlModule = async () => {
  if (sqlModule) {
    return sqlModule;
  }
  sqlModule = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  return sqlModule;
};

const resetPreparedStatements = () => {
  preparedStatements.forEach((stmt) => {
    try {
      stmt.free();
    } catch {
      // ignore release errors
    }
  });
  preparedStatements.clear();
};

const getPreparedStatement = (database, key, sql) => {
  if (!database) {
    throw new Error('database_not_ready');
  }
  const cached = preparedStatements.get(key);
  if (cached) {
    try {
      cached.reset();
      return cached;
    } catch {
      preparedStatements.delete(key);
      try {
        cached.free();
      } catch {
        // ignore release errors
      }
    }
  }
  const stmt = database.prepare(sql);
  preparedStatements.set(key, stmt);
  return stmt;
};

const rebuildPreparedStatement = (database, key, sql) => {
  const current = preparedStatements.get(key);
  if (current) {
    try {
      current.free();
    } catch {
      // ignore release errors
    }
    preparedStatements.delete(key);
  }
  const next = database.prepare(sql);
  preparedStatements.set(key, next);
  return next;
};

const withPreparedStatementRetry = (database, key, sql, runner) => {
  let stmt = getPreparedStatement(database, key, sql);
  try {
    return runner(stmt);
  } catch {
    stmt = rebuildPreparedStatement(database, key, sql);
    return runner(stmt);
  }
};

const queryOnePrepared = (database, key, sql, params = []) => {
  return withPreparedStatementRetry(database, key, sql, (stmt) => {
    stmt.reset();
    stmt.bind(Array.isArray(params) ? params : []);
    let row = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.reset();
    return row;
  });
};

const querySingleNumberPrepared = (database, key, sql, params = []) => {
  const row = queryOnePrepared(database, key, sql, params);
  const first = row ? Object.values(row)[0] : 0;
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : 0;
};

const executePrepared = (database, key, sql, params = []) => {
  withPreparedStatementRetry(database, key, sql, (stmt) => {
    stmt.reset();
    stmt.run(Array.isArray(params) ? params : []);
    stmt.reset();
    return undefined;
  });
};

const queryRowsPrepared = (database, key, sql, params = []) =>
  withPreparedStatementRetry(database, key, sql, (stmt) => {
    stmt.reset();
    stmt.bind(Array.isArray(params) ? params : []);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.reset();
    return rows;
  });

const openDb = async () => {
  if (db) {
    return db;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const SQL = await getSqlModule();
  resetPreparedStatements();
  try {
    const file = await fs.readFile(DB_PATH);
    db = new SQL.Database(new Uint8Array(file));
  } catch {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      senderUid INTEGER NOT NULL,
      targetUid INTEGER NOT NULL,
      targetType TEXT NOT NULL,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      createdAtMs INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_private
      ON messages (targetType, senderUid, targetUid, createdAtMs);
    CREATE INDEX IF NOT EXISTS idx_messages_group
      ON messages (targetType, targetUid, createdAtMs);
    CREATE INDEX IF NOT EXISTS idx_messages_private_reverse
      ON messages (targetType, targetUid, senderUid, createdAtMs DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_group_type_time
      ON messages (targetType, targetUid, type, createdAtMs DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_time
      ON messages (senderUid, createdAtMs DESC);
    CREATE TABLE IF NOT EXISTS chat_delete_cutoffs (
      uid INTEGER NOT NULL,
      deviceId TEXT NOT NULL,
      targetType TEXT NOT NULL,
      targetUid INTEGER NOT NULL,
      cutoffMs INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (uid, deviceId, targetType, targetUid)
    );
    CREATE TABLE IF NOT EXISTS chat_device_state (
      uid INTEGER NOT NULL,
      deviceId TEXT NOT NULL,
      createdAtMs INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (uid, deviceId)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_delete_cutoffs_lookup
      ON chat_delete_cutoffs (uid, deviceId, targetType, targetUid);
    CREATE INDEX IF NOT EXISTS idx_chat_device_state_lookup
      ON chat_device_state (uid, deviceId);
  `);
  return db;
};

const flushDb = async () => {
  if (!db || dbDirtyCount <= 0) {
    return;
  }
  if (flushInFlight) {
    pendingFlush = true;
    return;
  }
  flushInFlight = true;
  const dirtySnapshot = dbDirtyCount;
  dbDirtyCount = 0;
  try {
    const data = db.export();
    await atomicWriteFile(DB_PATH, Buffer.from(data), {
      encoding: null,
      lockPath: DB_LOCK_PATH,
      retry: {
        attempts: 120,
        baseDelayMs: 10,
        maxDelayMs: 140,
      },
    });
    flushWindowStartAt = 0;
  } catch (error) {
    dbDirtyCount += dirtySnapshot;
    console.error('Chat db flush error:', error);
  } finally {
    flushInFlight = false;
    if (pendingFlush || dbDirtyCount > 0) {
      pendingFlush = false;
      scheduleFlush({ markDirty: false });
    }
  }
};

const scheduleFlush = ({ markDirty = true } = {}) => {
  if (markDirty) {
    dbDirtyCount += 1;
  }
  if (dbDirtyCount <= 0) return;
  const now = Date.now();
  if (!flushWindowStartAt) {
    flushWindowStartAt = now;
  }
  if (flushInFlight) {
    pendingFlush = true;
    return;
  }
  const elapsedMs = Math.max(0, now - flushWindowStartAt);
  const maxRemaining = Math.max(0, FLUSH_MAX_DELAY_MS - elapsedMs);
  const delayMs = Math.min(FLUSH_DEBOUNCE_MS, maxRemaining);
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDb();
  }, delayMs);
  flushTimer.unref?.();
};

const setChatNotifier = (notifier) => {
  chatNotifier = typeof notifier === 'function' ? notifier : null;
};

const migrateChatJson = async () => {
  const database = await openDb();
  const countStmt = database.prepare('SELECT COUNT(1) as count FROM messages');
  countStmt.step();
  const existing = countStmt.getAsObject();
  countStmt.free();
  if (existing.count > 0) {
    return;
  }
  try {
    await fs.access(CHAT_JSON_PATH);
  } catch {
    return;
  }
  try {
    const raw = await fs.readFile(CHAT_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return;
    }
    const insert = database.prepare(`
      INSERT OR IGNORE INTO messages (
        id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = parsed
      .map((entry) => {
        const createdAt =
          typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString();
        const createdAtMs = Number.isFinite(Date.parse(createdAt))
          ? Date.parse(createdAt)
          : Date.now();
        const data =
          entry && entry.data && typeof entry.data === 'object'
            ? JSON.stringify(entry.data)
            : JSON.stringify({});
        return {
          id: entry.id || crypto.randomUUID(),
          type: entry.type,
          senderUid: Number(entry.senderUid),
          targetUid: Number(entry.targetUid),
          targetType: entry.targetType,
          data,
          createdAt,
          createdAtMs,
        };
      })
      .filter(
        (row) =>
          isValidType(row.type) &&
          isValidTargetType(row.targetType) &&
          Number.isInteger(row.senderUid) &&
          Number.isInteger(row.targetUid)
      );
    if (!rows.length) {
      insert.free();
      return;
    }
    database.run('BEGIN');
    for (const row of rows) {
      insert.run([
        row.id,
        row.type,
        row.senderUid,
        row.targetUid,
        row.targetType,
        row.data,
        row.createdAt,
        row.createdAtMs,
      ]);
    }
    database.run('COMMIT');
    insert.free();
    scheduleFlush();
  } catch (error) {
    console.warn('Chat migration skipped:', error);
  }
};

const ensureChatStorage = async () => {
  if (chatStorageReady) return;
  if (chatStoragePromise) {
    await chatStoragePromise;
    return;
  }
  chatStoragePromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await openDb();
    await migrateChatJson();
    await maybeCleanupUserFiles();
    await ensureStickerStore();
    chatStorageReady = true;
  })();
  try {
    await chatStoragePromise;
  } finally {
    chatStoragePromise = null;
  }
};

const getChatDatabaseForOps = async () => {
  await ensureChatStorage();
  return openDb();
};

const authenticate = createAuthenticateMiddleware({ scope: 'Chat' });

const toMessage = (row) => {
  let data = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }
  return {
    id: row.id,
    type: row.type,
    senderUid: row.senderUid,
    targetUid: row.targetUid,
    targetType: row.targetType,
    data,
    createdAt: row.createdAt,
  };
};

const parseReadAtMap = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  Object.entries(source).forEach(([uid, ts]) => {
    const parsedUid = Number(uid);
    const parsedTs = Number(ts);
    if (Number.isInteger(parsedUid) && Number.isFinite(parsedTs) && parsedTs > 0) {
      result[parsedUid] = parsedTs;
    }
  });
  return result;
};

const normalizeDeviceId = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  let sanitized = '';
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    if (sanitized.length >= MAX_DEVICE_ID_LENGTH) break;
    sanitized += char;
  }
  return sanitized;
};

const resolveDeleteCutoffDeviceHeaderId = (req) =>
  normalizeDeviceId(String(req.headers['x-xinchat-device-id'] || '')) ||
  normalizeDeviceId(String(req.headers['x-device-id'] || ''));

const resolveDeleteCutoffDeviceId = (req) => {
  const fromHeader = resolveDeleteCutoffDeviceHeaderId(req);
  if (fromHeader) return fromHeader;
  const token = String(extractToken(req) || '').trim();
  if (!token) return '';
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 48);
  return hash ? `tok:${hash}` : '';
};

const extractDeviceCreatedAtMsFromId = (deviceId) => {
  if (typeof deviceId !== 'string') return 0;
  const match = deviceId.trim().match(/^dev_([0-9a-z]+)_/i);
  if (!match) return 0;
  const parsed = parseInt(match[1], 36);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

const normalizeDeviceCreatedAtMs = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const floored = Math.floor(parsed);
  const maxAllowed = Date.now() + MAX_DEVICE_CREATED_AT_FUTURE_DRIFT_MS;
  return floored > maxAllowed ? maxAllowed : floored;
};

const resolveDeviceCreatedAtMsFromRequest = (req, deviceId) => {
  const fromHeader =
    normalizeDeviceCreatedAtMs(req.headers['x-xinchat-device-created-at']) ||
    normalizeDeviceCreatedAtMs(req.headers['x-device-created-at']);
  if (fromHeader > 0) return fromHeader;
  const fromQuery = normalizeDeviceCreatedAtMs(req.query?.deviceCreatedAtMs);
  if (fromQuery > 0) return fromQuery;
  const fromBody = normalizeDeviceCreatedAtMs(req.body?.deviceCreatedAtMs);
  if (fromBody > 0) return fromBody;
  const fromDeviceId = extractDeviceCreatedAtMsFromId(deviceId);
  if (fromDeviceId > 0) return fromDeviceId;
  return Date.now();
};

const getDeviceBaselineCutoff = (database, { uid, deviceId }) => {
  if (!database) return 0;
  if (!Number.isInteger(uid) || uid <= 0 || !deviceId) return 0;
  const row = queryOnePrepared(
    database,
    'device_state:baseline_by_uid_device',
    `
      SELECT createdAtMs
      FROM chat_device_state
      WHERE uid = ? AND deviceId = ?
      LIMIT 1
    `,
    [uid, deviceId]
  );
  const parsed = Number(row?.createdAtMs);
  const cutoffMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return cutoffMs;
};

const ensureDeviceBaselineCutoff = (database, { uid, deviceId, createdAtMs }) => {
  if (!database) return { cutoffMs: 0, inserted: false };
  if (!Number.isInteger(uid) || uid <= 0 || !deviceId) {
    return { cutoffMs: 0, inserted: false };
  }
  const existing = getDeviceBaselineCutoff(database, { uid, deviceId });
  if (existing > 0) {
    return { cutoffMs: existing, inserted: false };
  }
  const normalized = normalizeDeviceCreatedAtMs(createdAtMs) || Date.now();
  const nowIso = new Date().toISOString();
  executePrepared(
    database,
    'device_state:upsert',
    `
      INSERT INTO chat_device_state (uid, deviceId, createdAtMs, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(uid, deviceId)
      DO UPDATE SET
        createdAtMs = CASE
          WHEN excluded.createdAtMs < chat_device_state.createdAtMs THEN excluded.createdAtMs
          ELSE chat_device_state.createdAtMs
        END,
        updatedAt = excluded.updatedAt
    `,
    [uid, deviceId, normalized, nowIso]
  );
  const finalCutoff = getDeviceBaselineCutoff(database, { uid, deviceId });
  return {
    cutoffMs: finalCutoff > 0 ? finalCutoff : normalized,
    inserted: true,
  };
};

const normalizeDeleteCutoffEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const targetType = String(entry.targetType || '').trim();
  const targetUid = Number(entry.targetUid);
  const cutoffMs = Number(entry.cutoffMs);
  if (!isValidTargetType(targetType)) return null;
  if (!Number.isInteger(targetUid) || targetUid <= 0) return null;
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return null;
  return {
    targetType,
    targetUid,
    cutoffMs: Math.max(1, Math.floor(cutoffMs)),
  };
};

const parseDeleteCutoffList = (value) => {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source || '[]');
    } catch {
      source = [];
    }
  }
  if (!Array.isArray(source)) return [];
  const dedup = new Map();
  source.forEach((raw) => {
    const normalized = normalizeDeleteCutoffEntry(raw);
    if (!normalized) return;
    const key = `${normalized.targetType}:${normalized.targetUid}`;
    const current = dedup.get(key);
    if (!current || normalized.cutoffMs > current.cutoffMs) {
      dedup.set(key, normalized);
    }
  });
  return Array.from(dedup.values());
};

const upsertDeleteCutoff = (database, { uid, deviceId, targetType, targetUid, cutoffMs }) => {
  if (!database) return;
  if (!Number.isInteger(uid) || uid <= 0) return;
  if (!deviceId || !isValidTargetType(targetType)) return;
  if (!Number.isInteger(targetUid) || targetUid <= 0) return;
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return;
  const nowIso = new Date().toISOString();
  executePrepared(
    database,
    'delete_cutoff:upsert',
    `
      INSERT INTO chat_delete_cutoffs (uid, deviceId, targetType, targetUid, cutoffMs, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid, deviceId, targetType, targetUid)
      DO UPDATE SET
        cutoffMs = CASE
          WHEN excluded.cutoffMs > chat_delete_cutoffs.cutoffMs THEN excluded.cutoffMs
          ELSE chat_delete_cutoffs.cutoffMs
        END,
        updatedAt = excluded.updatedAt
    `,
    [uid, deviceId, targetType, targetUid, Math.floor(cutoffMs), nowIso]
  );
};

const getDeleteCutoffForTarget = (database, { uid, deviceId, targetType, targetUid }) => {
  if (!database) return 0;
  if (!Number.isInteger(uid) || uid <= 0) return 0;
  if (!deviceId || !isValidTargetType(targetType)) return 0;
  if (!Number.isInteger(targetUid) || targetUid <= 0) return 0;
  const row = queryOnePrepared(
    database,
    'delete_cutoff:find_one',
    `
      SELECT cutoffMs
      FROM chat_delete_cutoffs
      WHERE uid = ? AND deviceId = ? AND targetType = ? AND targetUid = ?
      LIMIT 1
    `,
    [uid, deviceId, targetType, targetUid]
  );
  const parsed = Number(row?.cutoffMs);
  const cutoffMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return cutoffMs;
};

const loadDeleteCutoffMapByDevice = (database, { uid, deviceId }) => {
  const result = {
    private: new Map(),
    group: new Map(),
  };
  if (!database) return result;
  if (!Number.isInteger(uid) || uid <= 0 || !deviceId) return result;
  const rows = queryRowsPrepared(
    database,
    'delete_cutoff:list_by_device',
    `
      SELECT targetType, targetUid, cutoffMs
      FROM chat_delete_cutoffs
      WHERE uid = ? AND deviceId = ?
    `,
    [uid, deviceId]
  );
  for (const row of rows) {
    const targetType = String(row?.targetType || '');
    const targetUid = Number(row?.targetUid);
    const cutoffMs = Number(row?.cutoffMs);
    if (!isValidTargetType(targetType)) continue;
    if (!Number.isInteger(targetUid) || targetUid <= 0) continue;
    if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) continue;
    const map = targetType === 'group' ? result.group : result.private;
    const current = Number(map.get(targetUid)) || 0;
    if (cutoffMs > current) {
      map.set(targetUid, Math.floor(cutoffMs));
    }
  }
  return result;
};

const verifyChatTargetAccess = async ({ user, users, targetType, targetUid }) => {
  if (!isValidTargetType(targetType) || !isValidUid(targetUid)) {
    return { ok: false, status: 400, message: '会话参数无效。' };
  }

  if (targetType === 'private') {
    const targetUser = users.find((item) => item.uid === targetUid);
    if (!targetUser) {
      return { ok: false, status: 404, message: '会话对象不存在。' };
    }
    const isMutualFriend =
      Array.isArray(user.friends) &&
      user.friends.includes(targetUid) &&
      Array.isArray(targetUser.friends) &&
      targetUser.friends.includes(user.uid);
    if (!isMutualFriend) {
      return { ok: false, status: 403, message: '暂无该会话访问权限。' };
    }
    return { ok: true, targetUser };
  }

  const group = await getGroupById(targetUid);
  if (!group) {
    return { ok: false, status: 404, message: '会话对象不存在。' };
  }
  const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
  if (!memberSet.has(user.uid)) {
    return { ok: false, status: 403, message: '暂无该会话访问权限。' };
  }
  return { ok: true, group };
};

const normalizeRiskTarget = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const targetType = String(source.targetType || '').trim();
  const targetUid = Number(source.targetUid);
  if (!isValidTargetType(targetType) || !isValidUid(targetUid)) {
    return null;
  }
  return { targetType, targetUid };
};

const handleReplySuggest = async (req, res) => {
  try {
    const rateKey = makeReplySuggestRateKey(req);
    if (!replySuggestLimiter.consume(rateKey)) {
      res.status(429).json({ success: false, message: '请求过于频繁。' });
      return;
    }

    if (!isFeatureEnabled('replyAssistant')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          suggestions: [],
          reason: 'feature_disabled',
        },
      });
      return;
    }

    const body = req.body || {};
    const targetType = String(body.targetType || '').trim();
    const targetUid = Number(body.targetUid);
    const textRaw =
      typeof body.text === 'string'
        ? body.text
        : typeof body.lastMessage === 'string'
          ? body.lastMessage
          : typeof body.content === 'string'
            ? body.content
            : '';
    const text = String(textRaw || '').trim().slice(0, 300);
    if (!text) {
      res.status(400).json({ success: false, message: '缺少文本内容。' });
      return;
    }

    const { user, users } = req.auth;
    const access = await verifyChatTargetAccess({
      user,
      users,
      targetType,
      targetUid,
    });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    const isReplyAssistantRoute = String(req.path || '').endsWith('/reply-assistant');
    const suggestionBundle = await generateReplySuggestions({
      text,
      user,
      requestedStyle: isReplyAssistantRoute ? '' : body.style || body.replyStyle || '',
      count: isReplyAssistantRoute ? 3 : body.count,
    });
    const intentLabelMap = {
      question: '提问',
      gratitude: '感谢',
      urgent: '紧急',
      general: '通用',
    };
    const localizedBundle = {
      ...suggestionBundle,
      intentLabel: intentLabelMap[String(suggestionBundle.intent || 'general')] || '通用',
    };

    trackRouteEvent(req, {
      eventType: 'impression',
      targetUid,
      targetType,
      tags: ['reply_suggest', localizedBundle.styleMode],
      metadata: {
        count: localizedBundle.count,
        intent: localizedBundle.intent,
      },
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        ...localizedBundle,
      },
    });
  } catch (error) {
    console.error('Reply suggest error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
};

router.post('/reply-suggest', authenticate, handleReplySuggest);
router.post('/reply-assistant', authenticate, handleReplySuggest);

router.post('/risk/evaluate', authenticate, async (req, res) => {
  try {
    const rateKey = makeRiskRateKey(req, 'risk_evaluate');
    if (!chatRiskEvaluateLimiter.consume(rateKey)) {
      res.status(429).json({ success: false, message: '请求过于频繁。' });
      return;
    }

    const body = req.body || {};
    const target = normalizeRiskTarget(body);
    if (!target) {
      res.status(400).json({ success: false, message: '缺少目标会话参数。' });
      return;
    }
    const text = String(body.text || body.content || '').trim().slice(0, 600);
    if (!text) {
      res.status(400).json({ success: false, message: '缺少文本内容。' });
      return;
    }

    const { user, users } = req.auth;
    const access = await verifyChatTargetAccess({
      user,
      users,
      targetType: target.targetType,
      targetUid: target.targetUid,
    });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    if (!isFeatureEnabled('riskGuard')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          source: 'chat_send',
          available: true,
          score: 0,
          level: 'low',
          tags: [],
          evidence: [],
          summary: '风控功能未开启。',
          generatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    const database = await openDb();
    let risk = null;
    try {
      risk = await assessOutgoingTextRisk({
        database,
        senderUid: user.uid,
        targetUid: target.targetUid,
        targetType: target.targetType,
        text,
        nowMs: Date.now(),
      });
    } catch {
      risk = {
        source: 'chat_send',
        available: false,
        score: 0,
        level: 'low',
        tags: [],
        evidence: [],
        summary: '风险评估服务暂不可用。',
        generatedAt: new Date().toISOString(),
      };
    }

    if (risk && (risk.level === 'medium' || risk.level === 'high')) {
      trackRouteEvent(req, {
        eventType: 'risk_hit',
        targetUid: target.targetUid,
        targetType: target.targetType,
        tags: ['chat_risk_evaluate', String(risk.level || 'low'), ...(Array.isArray(risk.tags) ? risk.tags : [])],
        reason: String(risk.summary || '').slice(0, 120),
        metadata: {
          riskScore: Number(risk.score) || 0,
          riskTags: Array.isArray(risk.tags) ? risk.tags : [],
        },
      });
      void recordRiskDecision({
        channel: 'chat_risk_evaluate',
        actorUid: user.uid,
        subjectUid: user.uid,
        targetUid: target.targetUid,
        targetType: target.targetType,
        risk,
        metadata: {
          textLength: text.length,
        },
      }).catch(() => undefined);
    }

    res.json({
      success: true,
      data: {
        enabled: true,
        ...risk,
      },
    });
  } catch (error) {
    console.error('Chat risk evaluate error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

router.get('/risk', authenticate, async (req, res) => {
  try {
    const rateKey = makeRiskRateKey(req, 'risk_profile');
    if (!chatRiskQueryLimiter.consume(rateKey)) {
      res.status(429).json({ success: false, message: '请求过于频繁。' });
      return;
    }

    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const target = normalizeRiskTarget(payload);
    if (!target) {
      res.status(400).json({ success: false, message: '缺少目标会话参数。' });
      return;
    }

    const { user, users } = req.auth;
    const access = await verifyChatTargetAccess({
      user,
      users,
      targetType: target.targetType,
      targetUid: target.targetUid,
    });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    if (!isFeatureEnabled('riskGuard')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          source: 'chat_profile',
          available: true,
          score: 0,
          level: 'low',
          tags: [],
          evidence: [],
          summary: '风控功能未开启。',
          ignored: false,
          targetUid: target.targetUid,
          targetType: target.targetType,
          generatedAt: new Date().toISOString(),
        },
      });
      return;
    }

    const database = await openDb();
    let profile = null;
    try {
      profile = await buildConversationRiskProfile({
        database,
        viewerUid: user.uid,
        targetUid: target.targetUid,
        targetType: target.targetType,
      });
    } catch (riskError) {
      profile = {
        source: 'chat_profile',
        available: false,
        score: 0,
        level: 'low',
        tags: [],
        evidence: [],
        summary: '风险画像暂不可用。',
        ignored: false,
        generatedAt: new Date().toISOString(),
        targetUid: target.targetUid,
        targetType: target.targetType,
      };
    }

    trackRouteEvent(req, {
      eventType: 'impression',
      targetUid: target.targetUid,
      targetType: target.targetType,
      tags: ['chat_risk_profile', String(profile?.level || 'low')],
      metadata: {
        score: Number(profile?.score) || 0,
        ignored: profile?.ignored === true,
        cacheMode: String(profile?.cache?.mode || 'none'),
      },
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        ...profile,
      },
    });
  } catch (error) {
    console.error('Chat risk profile error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

router.post('/risk/ignore', authenticate, async (req, res) => {
  try {
    const rateKey = makeRiskRateKey(req, 'risk_ignore');
    if (!chatRiskIgnoreLimiter.consume(rateKey)) {
      res.status(429).json({ success: false, message: '请求过于频繁。' });
      return;
    }

    if (!isFeatureEnabled('riskGuard')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          ignored: false,
          reason: 'feature_disabled',
        },
      });
      return;
    }

    const target = normalizeRiskTarget(req.body || {});
    if (!target) {
      res.status(400).json({ success: false, message: '缺少目标会话参数。' });
      return;
    }

    const { user, users } = req.auth;
    const access = await verifyChatTargetAccess({
      user,
      users,
      targetType: target.targetType,
      targetUid: target.targetUid,
    });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 180);
    const ttlHours = Number(req.body?.ttlHours);
    const entry = await upsertRiskIgnore({
      actorUid: user.uid,
      targetUid: target.targetUid,
      targetType: target.targetType,
      reason,
      ttlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24 * 7,
    });

    trackRouteEvent(req, {
      eventType: 'mute',
      targetUid: target.targetUid,
      targetType: target.targetType,
      tags: ['chat_risk_ignore'],
      metadata: {
        ttlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24 * 7,
      },
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        ignored: true,
        entry,
      },
    });
  } catch (error) {
    console.error('Chat risk ignore error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

router.post('/risk/appeal', authenticate, async (req, res) => {
  try {
    const rateKey = makeRiskRateKey(req, 'risk_appeal');
    if (!chatRiskAppealLimiter.consume(rateKey)) {
      res.status(429).json({ success: false, message: '请求过于频繁。' });
      return;
    }

    if (!isFeatureEnabled('riskGuard')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          accepted: false,
          reason: 'feature_disabled',
        },
      });
      return;
    }

    const target = normalizeRiskTarget(req.body || {});
    if (!target) {
      res.status(400).json({ success: false, message: '缺少目标会话参数。' });
      return;
    }
    const { user, users } = req.auth;
    const access = await verifyChatTargetAccess({
      user,
      users,
      targetType: target.targetType,
      targetUid: target.targetUid,
    });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 300) || 'possible_false_positive';
    const appeal = await appendRiskAppeal({
      actorUid: user.uid,
      targetUid: target.targetUid,
      targetType: target.targetType,
      reason,
      context: {
        requestId: req.requestId || '',
        client: 'chat',
      },
    });

    trackRouteEvent(req, {
      eventType: 'report',
      targetUid: target.targetUid,
      targetType: target.targetType,
      tags: ['chat_risk_appeal'],
      reason,
      metadata: {
        appealId: appeal?.id || '',
      },
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        accepted: Boolean(appeal),
        appeal,
      },
    });
  } catch (error) {
    console.error('Chat risk appeal error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

router.post('/send', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const body = req.body || {};
    if (!isValidType(body.type)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (!isValidTargetType(body.targetType)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    const targetType = String(body.targetType || '');

    const senderUid = Number(body.senderUid);
    const targetUid = Number(body.targetUid);
    if (!isValidUid(senderUid) || !isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }

    const { user, users } = req.auth;
    if (user.uid !== senderUid) {
      res.status(403).json({ success: false, message: 'Request failed.' });
      return;
    }
    const riskGuardEnabled = isFeatureEnabled('riskGuard');

    const access = await verifyChatTargetAccess({ user, users, targetType, targetUid });
    if (!access.ok) {
      res.status(access.status).json({ success: false, message: access.message });
      return;
    }

    const {
      type,
      senderUid: _,
      targetUid: __,
      targetType: ___,
      recoDecisionId: recoDecisionIdRaw,
      recoCandidateId: recoCandidateIdRaw,
      recoFeedbackAction: recoFeedbackActionRaw,
      ...data
    } = body;
    const recoDecisionId =
      typeof recoDecisionIdRaw === 'string' ? recoDecisionIdRaw.trim().slice(0, 80) : '';
    const recoCandidateId =
      typeof recoCandidateIdRaw === 'string' ? recoCandidateIdRaw.trim().toLowerCase().slice(0, 120) : '';
    const recoFeedbackAction =
      typeof recoFeedbackActionRaw === 'string'
        ? recoFeedbackActionRaw.trim().toLowerCase().slice(0, 32)
        : 'reply';
    const messageData = { ...data };
    let realtimeRiskText = '';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    if (type === 'text') {
      const contentRaw =
        typeof messageData.content === 'string'
          ? messageData.content
          : typeof messageData.text === 'string'
            ? messageData.text
            : '';
      const content = String(contentRaw || '').trim();
      const hasImagePayload =
        (typeof messageData.url === 'string' && messageData.url.trim().length > 0) ||
        (Array.isArray(messageData.urls) && messageData.urls.length > 0) ||
        (messageData.hashData && typeof messageData.hashData === 'object');
      if (!content) {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }
      if (hasImagePayload) {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }
      messageData.content = content;
      realtimeRiskText = content.slice(0, CHAT_REALTIME_RISK_MAX_TEXT_CHARS);
      delete messageData.text;
    }
    if (type === 'image') {
      const textContent = typeof messageData.content === 'string' ? messageData.content.trim() : '';
      const textAlias = typeof messageData.text === 'string' ? messageData.text.trim() : '';
      if (textContent || textAlias) {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }
      const hashUrlMap = new Map();
      const hashData =
        messageData.hashData && typeof messageData.hashData === 'object'
          ? messageData.hashData
          : null;
      const normalizeImageValue = async (value) => {
        if (typeof value === 'string') {
          const parsed = parseImageDataUrl(value);
          if (!parsed) return value;
          const stored = await storeImageBuffer(parsed.buffer, parsed.ext);
          const url = `${baseUrl}/uploads/images/${stored.filename}`;
          if (stored.hash) {
            hashUrlMap.set(stored.hash, url);
          }
          return url;
        }
        if (!value || typeof value !== 'object') return '';
        const url = typeof value.url === 'string' ? value.url.trim() : '';
        if (url) return url;
        const dataUrl =
          typeof value.dataUrl === 'string' ? value.dataUrl.trim() : '';
        if (dataUrl) {
          const parsed = parseImageDataUrl(dataUrl);
          if (!parsed) return '';
          const stored = await storeImageBuffer(parsed.buffer, parsed.ext);
          const storedUrl = `${baseUrl}/uploads/images/${stored.filename}`;
          if (stored.hash) {
            hashUrlMap.set(stored.hash, storedUrl);
          }
          return storedUrl;
        }
        const hash = typeof value.hash === 'string' ? value.hash.trim() : '';
        if (hash && hashUrlMap.has(hash)) {
          return hashUrlMap.get(hash);
        }
        if (hash && hashData && typeof hashData[hash] === 'string') {
          const parsed = parseImageDataUrl(hashData[hash].trim());
          if (parsed) {
            const stored = await storeImageBuffer(parsed.buffer, parsed.ext);
            const storedUrl = `${baseUrl}/uploads/images/${stored.filename}`;
            if (stored.hash) {
              hashUrlMap.set(stored.hash, storedUrl);
            }
            return storedUrl;
          }
        }
        const foundUrl = await findImageUrlByHash(hash, baseUrl);
        if (hash && foundUrl) {
          hashUrlMap.set(hash, foundUrl);
        }
        return foundUrl;
      };
      if (Array.isArray(messageData.urls)) {
        if (messageData.urls.length !== 1) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        const urls = [];
        for (const item of messageData.urls) {
          const normalized = await normalizeImageValue(item);
          if (typeof normalized === 'string' && normalized.trim()) {
            urls.push(normalized);
          }
        }
        if (!urls.length || !urls[0]) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        messageData.url = urls[0];
        delete messageData.urls;
      } else {
        const rawUrl =
          typeof messageData.url === 'string' ? messageData.url.trim() : '';
        if (!rawUrl) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        const normalized = await normalizeImageValue(rawUrl);
        if (!normalized || !String(normalized).trim()) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        messageData.url = normalized;
      }
      delete messageData.content;
      delete messageData.text;
    }
    if (type === 'file') {
      const rawDataUrl =
        typeof messageData.dataUrl === 'string' ? messageData.dataUrl.trim() : '';
      const rawUrl =
        typeof messageData.url === 'string' ? messageData.url.trim() : '';
      const safeName = sanitizeFilename(messageData.name || 'file') || 'file';
      let mime =
        typeof messageData.mime === 'string' && messageData.mime.trim()
          ? messageData.mime.trim()
          : 'application/octet-stream';
      let filename = '';
      let size = 0;

      if (rawDataUrl) {
        const parsed = parseDataUrl(rawDataUrl);
        if (!parsed) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        if (parsed.buffer.length > MAX_FILE_BYTES) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        mime = parsed.mime || mime;
        const stored = await storeUserFileBuffer(
          parsed.buffer,
          senderUid,
          safeName,
          mime
        );
        filename = stored.filename;
        size = parsed.buffer.length;
      } else if (rawUrl) {
        let parsedUrl = null;
        try {
          parsedUrl = new URL(rawUrl, baseUrl);
        } catch {
          parsedUrl = null;
        }
        if (!parsedUrl || !parsedUrl.pathname.startsWith('/uploads/userfile/')) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        const relativePath = decodeURIComponent(
          parsedUrl.pathname.replace('/uploads/userfile/', '')
        );
        const sourcePath = resolvePathWithinRoot(USERFILE_DIR, relativePath);
        if (!sourcePath) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        if (!(await fileExists(sourcePath))) {
          res.status(404).json({ success: false, message: 'Request failed.' });
          return;
        }
        const stat = await fs.stat(sourcePath);
        size = stat.size;
        if (size > MAX_FILE_BYTES) {
          res.status(400).json({ success: false, message: 'Request failed.' });
          return;
        }
        const stored = await storeUserFileFromPath(
          sourcePath,
          senderUid,
          safeName,
          mime
        );
        filename = stored.filename;
      } else {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }

      const meta = buildFileMeta(safeName, size, mime);
      messageData.name = meta.name;
      messageData.size = meta.size;
      messageData.mime = meta.mime;
      messageData.uploadedAt = meta.uploadedAt;
      messageData.expiresAt = meta.expiresAt;
      messageData.url = `${baseUrl}/uploads/userfile/${senderUid}/${filename}`;
      delete messageData.dataUrl;
    }

    const createdAt = new Date().toISOString();
    const createdAtMs = Date.now();
    const entry = {
      id: crypto.randomUUID(),
      type,
      senderUid,
      targetUid,
      targetType,
      data: messageData,
      createdAt,
    };

    const database = await openDb();

    executePrepared(
      database,
      'messages:insert',
      `
        INSERT INTO messages (
          id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        entry.type,
        entry.senderUid,
        entry.targetUid,
        entry.targetType,
        JSON.stringify(entry.data || {}),
        entry.createdAt,
        createdAtMs,
      ]
    );
    scheduleFlush();
    if (chatNotifier) {
      setImmediate(() => chatNotifier(entry));
    }

    trackRouteEvent(req, {
      eventType: 'reply',
      targetUid: entry.targetUid,
      targetType: entry.targetType,
      tags: [entry.targetType, entry.type],
      metadata: {
        messageType: entry.type,
        recoDecisionId: recoDecisionId || '',
      },
    });

    if (isFeatureEnabled('recoVw')) {
      const inferredCandidateId = recoCandidateId || `${targetType}:${targetUid}`;
      const hourOfDay = new Date(createdAtMs).getHours();
      const sharedFeatures = buildSharedContextFeatures({ uid: senderUid, hourOfDay });
      const actionFeatures = {
        isGroup: targetType === 'group' ? 1 : 0,
        isPrivate: targetType === 'private' ? 1 : 0,
        sentText: type === 'text' ? 1 : 0,
        sentMedia: type === 'text' ? 0 : 1,
      };
      void recordRecoFeedback({
        uid: senderUid,
        decisionId: recoDecisionId,
        action: recoFeedbackAction || 'reply',
        candidateId: inferredCandidateId,
        metadata: {
          source: recoDecisionId ? 'chat_send_reco' : 'chat_send_implicit',
          messageId: entry.id,
          vwSharedFeatures: sharedFeatures,
          vwActionFeatures: actionFeatures,
        },
      }).catch(() => undefined);
    }

    if (riskGuardEnabled && type === 'text' && realtimeRiskText) {
      const riskText = realtimeRiskText;
      const riskMessageId = String(entry.id || '');
      const riskTimestampMs = Number(createdAtMs) || Date.now();
      void (async () => {
        try {
          const risk = await assessOutgoingTextRisk({
            database,
            senderUid,
            targetUid,
            targetType,
            text: riskText,
            nowMs: riskTimestampMs,
          });
          if (!risk || typeof risk !== 'object') return;
          const safeTags = Array.isArray(risk.tags) ? risk.tags.filter(Boolean) : [];
          if (safeTags.length === 0 && risk.level !== 'medium' && risk.level !== 'high') {
            return;
          }
          if (risk.level === 'medium' || risk.level === 'high') {
            trackRouteEvent(req, {
              eventType: 'risk_hit',
              targetUid,
              targetType,
              tags: ['chat_send_realtime', String(risk.level || 'low'), ...safeTags],
              reason: String(risk.summary || '').slice(0, 120),
              metadata: {
                riskScore: Number(risk.score) || 0,
                riskTags: safeTags,
                messageId: riskMessageId,
              },
            });
          }
          await recordRiskDecision({
            channel: 'chat_send_realtime',
            actorUid: senderUid,
            subjectUid: senderUid,
            targetUid,
            targetType,
            risk,
            includeLow: safeTags.length > 0,
            metadata: {
              messageId: riskMessageId,
              textLength: riskText.length,
            },
          });
        } catch (riskError) {
          console.error('Chat send realtime risk error:', riskError);
        }
      })();
    }

    const responsePayload = { success: true, data: entry };
    res.json(responsePayload);
  } catch (error) {
    console.error('Chat send error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});
router.get('/stickers/list', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const { user } = req.auth;
    const list = getUserStickerList(user.uid);
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Sticker list error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.post('/stickers/upload/batch', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_STICKER_BATCH_UPLOAD) : [];
    if (!items.length) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    const parseStickerItem = (item) => {
      const rawDataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl.trim() : '';
      const rawMime = typeof item?.mime === 'string' ? item.mime.trim().toLowerCase() : '';
      const rawBase64 = typeof item?.base64 === 'string' ? item.base64.trim() : '';
      let parsed = rawDataUrl ? parseImageDataUrl(rawDataUrl) : null;
      if (!parsed && rawBase64 && rawMime) {
        parsed = parseImageDataUrl(`data:${rawMime};base64,${rawBase64}`);
      }
      if (!parsed) return null;
      if (parsed.buffer.length <= 0 || parsed.buffer.length > MAX_STICKER_BYTES) return null;
      return parsed;
    };

    const parsedItems = items.map(parseStickerItem).filter(Boolean);
    if (!parsedItems.length) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }

    const uid = req.auth.user.uid;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const uploaded = [];
    for (const parsed of parsedItems) {
      const stored = await storeImageBuffer(parsed.buffer, parsed.ext);
      const url = `${baseUrl}/uploads/images/${stored.filename}`;
      const sticker = await upsertUserSticker({
        uid,
        hash: stored.hash,
        ext: parsed.ext,
        mime: parsed.mime,
        size: parsed.buffer.length,
        url,
        skipPersist: true,
      });
      uploaded.push(sticker);
    }
    if (uploaded.length > 0) {
      await queueStickerStorePersist();
    }
    const list = getUserStickerList(uid);
    res.json({ success: true, data: { uploaded, stickers: list } });
  } catch (error) {
    console.error('Sticker batch upload error:', error);
    res.status(400).json({ success: false, message: 'Request failed.' });
  }
});

router.post('/stickers/upload', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const body = req.body || {};
    const rawDataUrl = typeof body.dataUrl === 'string' ? body.dataUrl.trim() : '';
    const rawMime = typeof body.mime === 'string' ? body.mime.trim().toLowerCase() : '';
    const rawBase64 = typeof body.base64 === 'string' ? body.base64.trim() : '';
    let parsed = rawDataUrl ? parseImageDataUrl(rawDataUrl) : null;
    if (!parsed && rawBase64 && rawMime) {
      parsed = parseImageDataUrl(`data:${rawMime};base64,${rawBase64}`);
    }
    if (!parsed) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (parsed.buffer.length <= 0 || parsed.buffer.length > MAX_STICKER_BYTES) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }

    const stored = await storeImageBuffer(parsed.buffer, parsed.ext);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/uploads/images/${stored.filename}`;
    const sticker = await upsertUserSticker({
      uid: req.auth.user.uid,
      hash: stored.hash,
      ext: parsed.ext,
      mime: parsed.mime,
      size: parsed.buffer.length,
      url,
    });
    const list = getUserStickerList(req.auth.user.uid);
    res.json({ success: true, data: { sticker, stickers: list } });
  } catch (error) {
    console.error('Sticker upload error:', error);
    const message = error?.message === 'File is too large.' ? 'File is too large.' : 'Upload failed.';
    res.status(400).json({ success: false, message });
  }
});

router.post('/upload/image', authenticate, async (req, res) => {
  try {
    await fs.mkdir(IMAGE_DIR, { recursive: true });
    const encoding = String(req.headers['x-file-encoding'] || '').toLowerCase();
    const headerExt = String(req.headers['x-file-ext'] || '').toLowerCase();
    const mime = String(req.headers['content-type'] || '').toLowerCase();
    const isTextBody = mime.startsWith('text/');
    let ext = headerExt || getImageExtFromMime(mime);

    if (encoding === 'base64' || isTextBody) {
      const raw = await readStreamToBuffer(req, MAX_FILE_BYTES * 2);
      let bodyText = raw.toString('utf-8').trim();
      if (
        (bodyText.startsWith('"') && bodyText.endsWith('"')) ||
        (bodyText.startsWith("'") && bodyText.endsWith("'"))
      ) {
        bodyText = bodyText.slice(1, -1);
      }
      const parsed = parseImageDataUrl(bodyText);
      let buffer = null;
      if (parsed) {
        buffer = parsed.buffer;
        ext = parsed.ext;
      } else if (bodyText) {
        buffer = Buffer.from(bodyText, 'base64');
      }
      if (!buffer || !buffer.length) {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }
      if (buffer.length > MAX_FILE_BYTES) {
        res.status(400).json({ success: false, message: 'Request failed.' });
        return;
      }
      if (!IMAGE_EXTS.includes(ext)) {
        ext = getImageExtFromMime(mime) || 'png';
      }
      const stored = await storeImageBuffer(buffer, ext);
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res.json({
        success: true,
        data: {
          url: `${baseUrl}/uploads/images/${stored.filename}`,
          hash: stored.hash,
          size: buffer.length,
        },
      });
      return;
    }

    if (!IMAGE_EXTS.includes(ext)) {
      ext = 'png';
    }
    const tempPath = path.join(
      IMAGE_DIR,
      `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
    );
    const { size, hash } = await readStreamToFile(req, tempPath, MAX_FILE_BYTES);
    const filename = `${hash}.${ext}`;
    const finalPath = path.join(IMAGE_DIR, filename);
    if (await fileExists(finalPath)) {
      await fs.unlink(tempPath).catch(() => {});
    } else {
      try {
        await fs.rename(tempPath, finalPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          await fs.unlink(tempPath).catch(() => {});
        } else {
          throw error;
        }
      }
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      data: { url: `${baseUrl}/uploads/images/${filename}`, hash, size },
    });
  } catch (error) {
    console.error('Image upload error:', error);
    const message = error?.message === 'File is too large.' ? 'File is too large.' : 'Upload failed.';
    res.status(400).json({ success: false, message });
  }
});

router.post('/upload/file', authenticate, async (req, res) => {
  try {
    await fs.mkdir(USERFILE_DIR, { recursive: true });
    const rawName = String(req.headers['x-file-name'] || '').trim();
    const rawType = String(req.headers['x-file-type'] || '').trim();
    const safeName = sanitizeFilename(rawName || 'file') || 'file';
    const mime = rawType || 'application/octet-stream';
    const ext = guessExtension(safeName, mime);
    const tempPath = path.join(
      USERFILE_DIR,
      `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
    );
    const { size, hash } = await readStreamToFile(req, tempPath, MAX_FILE_BYTES);
    const indexRaw = await readUserfileIndex();
    const index = await pruneUserfileIndex(indexRaw);
    const existingPath = index[hash]?.path && (await fileExists(index[hash].path))
      ? index[hash].path
      : null;
    const userDir = path.join(USERFILE_DIR, String(req.auth.user.uid));
    await fs.mkdir(userDir, { recursive: true });
    const filename = `${hash}.${ext}`;
    const finalPath = path.join(userDir, filename);
    if (await fileExists(finalPath)) {
      await fs.unlink(tempPath).catch(() => {});
    } else if (existingPath) {
      await fs.copyFile(existingPath, finalPath);
      await fs.unlink(tempPath).catch(() => {});
    } else {
      try {
        await fs.rename(tempPath, finalPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          await fs.unlink(tempPath).catch(() => {});
        } else {
          throw error;
        }
      }
    }
    index[hash] = {
      path: finalPath,
      ext,
      size,
      updatedAt: new Date().toISOString(),
    };
    await writeUserfileIndex(index);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      data: {
        url: `${baseUrl}/uploads/userfile/${req.auth.user.uid}/${filename}`,
        hash,
        size,
        name: safeName,
        mime,
      },
    });
  } catch (error) {
    console.error('File upload error:', error);
    const message = error?.message === 'File is too large.' ? 'File is too large.' : 'Upload failed.';
    res.status(400).json({ success: false, message });
  }
});

router.get('/get', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const payload = {
      ...req.query,
      ...(req.body || {}),
    };
    const type = payload.type;
    const targetType = payload.targetType;
    const targetUid = Number(payload.targetUid);
    const sinceId = typeof payload.sinceId === 'string' ? payload.sinceId.trim() : '';
    const limitRaw = Number(payload.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 0), MAX_LIMIT) : 0;
    const beforeId = typeof payload.beforeId === 'string' ? payload.beforeId.trim() : '';
    const beforeTs = payload.beforeTs;
    let sinceMs = 0;
    let beforeMs = 0;

    if (!isValidTargetType(targetType)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (!isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (type && !isValidType(type)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }

    if (payload.sinceTs) {
      const parsed = Number(payload.sinceTs);
      if (Number.isFinite(parsed)) {
        sinceMs = parsed;
      } else if (typeof payload.sinceTs === 'string') {
        const parsedDate = Date.parse(payload.sinceTs);
        if (Number.isFinite(parsedDate)) {
          sinceMs = parsedDate;
        }
      }
    }
    if (beforeTs) {
      const parsed = Number(beforeTs);
      if (Number.isFinite(parsed)) {
        beforeMs = parsed;
      } else if (typeof beforeTs === 'string') {
        const parsedDate = Date.parse(beforeTs);
        if (Number.isFinite(parsedDate)) {
          beforeMs = parsedDate;
        }
      }
    }

    const { user, users } = req.auth;
    if (targetType === 'private') {
      const targetUser = users.find((item) => item.uid === targetUid);
      if (!targetUser) {
        res.status(404).json({ success: false, message: 'Request failed.' });
        return;
      }
      const isMutualFriend =
        Array.isArray(user.friends) &&
        user.friends.includes(targetUid) &&
        Array.isArray(targetUser.friends) &&
        targetUser.friends.includes(user.uid);
      if (!isMutualFriend) {
        res.status(403).json({ success: false, message: 'Request failed.' });
        return;
      }
    } else {
      const group = await getGroupById(targetUid);
      if (!group) {
        res.status(404).json({ success: false, message: 'Request failed.' });
        return;
      }
      const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
	      if (!memberSet.has(user.uid)) {
	        res.status(403).json({ success: false, message: 'Request failed.' });
	        return;
	      }
	    }

    const deviceHeaderId = resolveDeleteCutoffDeviceHeaderId(req);
    const deviceId = deviceHeaderId || resolveDeleteCutoffDeviceId(req);
    const database = await openDb();
    let deviceBaselineCutoffMs = 0;
    if (deviceHeaderId) {
      const baseline = ensureDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
        createdAtMs: resolveDeviceCreatedAtMsFromRequest(req, deviceId),
      });
      deviceBaselineCutoffMs = baseline.cutoffMs;
      if (baseline.inserted) {
        scheduleFlush();
      }
    } else if (deviceId) {
      deviceBaselineCutoffMs = getDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
      });
    }
    const targetDeleteCutoffMs = getDeleteCutoffForTarget(database, {
      uid: user.uid,
      deviceId,
      targetType,
      targetUid,
    });
    const effectiveDeleteCutoffMs = Math.max(deviceBaselineCutoffMs, targetDeleteCutoffMs);
    if (sinceId) {
      const row = queryOnePrepared(
        database,
        'messages:createdAtMs_by_id',
        'SELECT createdAtMs FROM messages WHERE id = ?',
        [sinceId]
      );
      if (row && Number.isFinite(Number(row.createdAtMs))) {
        sinceMs = Math.max(sinceMs, Number(row.createdAtMs));
      }
    }
    if (beforeId) {
      const row = queryOnePrepared(
        database,
        'messages:createdAtMs_by_id',
        'SELECT createdAtMs FROM messages WHERE id = ?',
        [beforeId]
      );
      if (row && Number.isFinite(Number(row.createdAtMs))) {
        beforeMs = Number(row.createdAtMs);
      }
    }

    const params = [targetType];
    let sql =
      'SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs FROM messages WHERE targetType = ?';

    if (targetType === 'private') {
      sql += ' AND ((senderUid = ? AND targetUid = ?) OR (senderUid = ? AND targetUid = ?))';
      params.push(user.uid, targetUid, targetUid, user.uid);
    } else {
      sql += ' AND targetUid = ?';
      params.push(targetUid);
    }

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (sinceMs > 0) {
      sql += ' AND createdAtMs > ?';
      params.push(sinceMs);
    }
    if (beforeMs > 0) {
      sql += ' AND createdAtMs < ?';
      params.push(beforeMs);
    }
    if (effectiveDeleteCutoffMs > 0) {
      sql += ' AND createdAtMs > ?';
      params.push(effectiveDeleteCutoffMs);
    }
    const effectiveLimit = limit > 0 ? limit : DEFAULT_LIMIT;
    const order = sinceMs > 0 ? 'ASC' : 'DESC';
    sql += ` ORDER BY createdAtMs ${order}`;
    if (effectiveLimit > 0) {
      sql += ' LIMIT ?';
      params.push(effectiveLimit);
    }

    const stmt = database.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    if (order === 'DESC') {
      rows.reverse();
    }
    const data = rows.map(toMessage);
    trackRouteEvent(req, {
      eventType: 'impression',
      targetUid,
      targetType,
      tags: [targetType],
      metadata: {
        itemCount: data.length,
      },
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Chat get error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.post('/overview', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const { user, users } = req.auth;
    const includeSummary = toBoolean(req.body?.includeSummary ?? req.query?.includeSummary, false);
    const usersByUid = new Map(
      (Array.isArray(users) ? users : [])
        .map((item) => [Number(item?.uid), item])
        .filter(([uid]) => Number.isInteger(uid) && uid > 0)
    );
    const selfFriendSet = new Set(
      (Array.isArray(user.friends) ? user.friends : [])
        .map((uid) => Number(uid))
        .filter((uid) => Number.isInteger(uid) && uid > 0)
    );
    const friendIds = Array.from(selfFriendSet).filter((uid) => {
      const target = usersByUid.get(uid);
      if (!target || !Array.isArray(target.friends)) return false;
      return target.friends.includes(user.uid);
    });
    const groups = await readGroups();
    const joinedGroups = groups.filter((group) => {
      const memberUids = Array.isArray(group?.memberUids) ? group.memberUids : [];
      return memberUids.includes(user.uid);
    });
    const groupIds = joinedGroups
      .map((group) => Number(group?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!friendIds.length && !groupIds.length) {
      if (includeSummary) {
        res.json({
          success: true,
          data: [],
          summaryCenter: isFeatureEnabled('summaryCenter')
            ? {
                enabled: true,
                available: true,
                generatedAt: new Date().toISOString(),
                ...buildOverviewInlineSummary([], 3),
              }
            : {
                enabled: false,
                available: true,
                generatedAt: new Date().toISOString(),
                unreadTotal: 0,
                unreadConversations: 0,
                highlights: [],
                summaryText: 'summary center is disabled.',
              },
        });
      } else {
        res.json({ success: true, data: [] });
      }
      return;
    }

    const readAtRaw = req.body?.readAt;
    let readAtSource = readAtRaw;
    if (typeof readAtRaw === 'string') {
      try {
        readAtSource = JSON.parse(readAtRaw || '{}');
      } catch {
        readAtSource = {};
      }
    }
    const readAt = parseReadAtMap(readAtSource);
    const deviceHeaderId = resolveDeleteCutoffDeviceHeaderId(req);
    const deviceId = deviceHeaderId || resolveDeleteCutoffDeviceId(req);
    const deleteCutoffs = parseDeleteCutoffList(req.body?.deleteCutoffs);
    const friendSet = new Set(friendIds);
    const groupSet = new Set(groupIds);
    const latestMap = {};
    const unreadMap = {};

    const database = await openDb();
    let shouldFlush = false;
    let deviceBaselineCutoffMs = 0;
    if (deviceHeaderId) {
      const baseline = ensureDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
        createdAtMs: resolveDeviceCreatedAtMsFromRequest(req, deviceId),
      });
      deviceBaselineCutoffMs = baseline.cutoffMs;
      if (baseline.inserted) {
        shouldFlush = true;
      }
    } else if (deviceId) {
      deviceBaselineCutoffMs = getDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
      });
    }

    if (deviceId && deleteCutoffs.length > 0) {
      deleteCutoffs.forEach((entry) => {
        if (entry.targetType === 'private') {
          if (!friendSet.has(entry.targetUid)) return;
        } else if (entry.targetType === 'group') {
          if (!groupSet.has(entry.targetUid)) return;
        } else {
          return;
        }
        upsertDeleteCutoff(database, {
          uid: user.uid,
          deviceId,
          targetType: entry.targetType,
          targetUid: entry.targetUid,
          cutoffMs: entry.cutoffMs,
        });
        shouldFlush = true;
      });
    }
    if (shouldFlush) {
      scheduleFlush();
    }
    const deleteCutoffMap = loadDeleteCutoffMapByDevice(database, {
      uid: user.uid,
      deviceId,
    });

    if (friendIds.length > 0) {
      for (const friendUid of friendIds) {
        const deleteCutoffMs = Number(deleteCutoffMap.private.get(friendUid)) || 0;
        const effectiveCutoffMs = Math.max(deviceBaselineCutoffMs, deleteCutoffMs);
        const latestRow = queryOnePrepared(
          database,
          'overview:private_latest',
          `
            SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
            FROM messages
            WHERE targetType = 'private'
              AND ((senderUid = ? AND targetUid = ?) OR (senderUid = ? AND targetUid = ?))
              AND createdAtMs > ?
            ORDER BY createdAtMs DESC
            LIMIT 1
          `,
          [user.uid, friendUid, friendUid, user.uid, effectiveCutoffMs]
        );
        if (latestRow) {
          latestMap[friendUid] = toMessage(latestRow);
        }
        const seenAt = Number(readAt[friendUid]) || 0;
        const unreadSinceMs = Math.max(effectiveCutoffMs, seenAt);
        const unreadCount = querySingleNumberPrepared(
          database,
          'overview:private_unread_count',
          `
            SELECT COUNT(1) AS total
            FROM messages
            WHERE targetType = 'private'
              AND senderUid = ?
              AND targetUid = ?
              AND type = 'text'
              AND createdAtMs > ?
          `,
          [friendUid, user.uid, unreadSinceMs]
        );
        unreadMap[friendUid] = Math.max(0, unreadCount);
      }
    }

    if (groupIds.length > 0) {
      for (const groupUid of groupIds) {
        const deleteCutoffMs = Number(deleteCutoffMap.group.get(groupUid)) || 0;
        const effectiveCutoffMs = Math.max(deviceBaselineCutoffMs, deleteCutoffMs);
        const latestRow = queryOnePrepared(
          database,
          'overview:group_latest',
          `
            SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
            FROM messages
            WHERE targetType = 'group'
              AND targetUid = ?
              AND createdAtMs > ?
            ORDER BY createdAtMs DESC
            LIMIT 1
          `,
          [groupUid, effectiveCutoffMs]
        );
        if (latestRow) {
          latestMap[groupUid] = toMessage(latestRow);
        }
        const seenAt = Number(readAt[groupUid]) || 0;
        const unreadSinceMs = Math.max(effectiveCutoffMs, seenAt);
        const unreadCount = querySingleNumberPrepared(
          database,
          'overview:group_unread_count',
          `
            SELECT COUNT(1) AS total
            FROM messages
            WHERE targetType = 'group'
              AND targetUid = ?
              AND senderUid != ?
              AND type = 'text'
              AND createdAtMs > ?
          `,
          [groupUid, user.uid, unreadSinceMs]
        );
        unreadMap[groupUid] = Math.max(0, unreadCount);
      }
    }

    const privateItems = friendIds.map((uid) => ({
      uid,
      targetType: 'private',
      latest: latestMap[uid] || null,
      unread: Math.min(unreadMap[uid] || 0, 99),
    }));
    const groupItems = joinedGroups.map((group) => ({
      uid: Number(group.id),
      targetType: 'group',
      latest: latestMap[group.id] || null,
      unread: Math.min(unreadMap[group.id] || 0, 99),
      group: {
        id: Number(group.id),
        name: typeof group.name === 'string' ? group.name : '',
        ownerUid: Number(group.ownerUid),
        memberUids: Array.isArray(group.memberUids) ? group.memberUids : [],
      },
    }));
    const data = [...privateItems, ...groupItems];
    const includeReco = toBoolean(req.body?.includeReco ?? req.query?.includeReco, true);
    let reco = null;
    let finalData = data;
    if (includeReco) {
      try {
        const decision = await decideConversationRanking({
          uid: user.uid,
          candidates: data,
          context: {
            source: 'chat_overview',
          },
          nowMs: Date.now(),
        });
        const rankMap = new Map(
          (Array.isArray(decision?.ranking) ? decision.ranking : []).map((item) => [
            String(item?.candidateId || ''),
            item,
          ])
        );
        const itemMap = new Map(
          data.map((item) => [
            `${item.targetType}:${Number(item.uid)}`,
            item,
          ])
        );
        if (decision.mode === 'online' && Array.isArray(decision.appliedOrder)) {
          const reordered = [];
          const taken = new Set();
          decision.appliedOrder.forEach((candidateId) => {
            const key = String(candidateId || '');
            if (!key || taken.has(key)) return;
            const found = itemMap.get(key);
            if (!found) return;
            reordered.push(found);
            taken.add(key);
          });
          data.forEach((item) => {
            const key = `${item.targetType}:${Number(item.uid)}`;
            if (taken.has(key)) return;
            reordered.push(item);
          });
          finalData = reordered;
        }
        finalData = finalData.map((item) => {
          const candidateId = `${item.targetType}:${Number(item.uid)}`;
          const rankInfo = rankMap.get(candidateId);
          if (!rankInfo) return item;
          return {
            ...item,
            reco: {
              decisionId: decision.decisionId,
              candidateId,
              score: Number(rankInfo.score) || 0,
              rank: Number(rankInfo.rank) || 0,
              mode: decision.mode,
              provider: decision.provider,
              explored: decision.explored === true,
            },
          };
        });
        reco = decision;
      } catch (recoError) {
        reco = {
          decisionId: '',
          mode: 'disabled',
          provider: 'none',
          selectedCandidateId: '',
          ranking: [],
          appliedOrder: [],
          shadowOrder: [],
          explored: false,
          degraded: true,
          reason: 'reco_failed',
        };
      }
    }
    const summaryCenter =
      includeSummary && isFeatureEnabled('summaryCenter')
        ? {
            enabled: true,
            available: true,
            generatedAt: new Date().toISOString(),
            ...buildOverviewInlineSummary(finalData, 3),
          }
        : includeSummary
          ? {
              enabled: false,
              available: true,
              generatedAt: new Date().toISOString(),
              unreadTotal: 0,
              unreadConversations: 0,
              highlights: [],
              summaryText: 'summary center is disabled.',
            }
          : null;
    trackRouteEvent(req, {
      eventType: 'impression',
      targetUid: 0,
      targetType: 'overview',
      tags: ['overview'],
      metadata: {
        privateCount: privateItems.length,
        groupCount: groupItems.length,
        totalCount: finalData.length,
        recoMode: reco?.mode || 'disabled',
      },
    });
    if (summaryCenter) {
      const payload = { success: true, data: finalData, summaryCenter };
      if (reco) payload.reco = reco;
      res.json(payload);
      return;
    }
    const payload = { success: true, data: finalData };
    if (reco) payload.reco = reco;
    res.json(payload);
  } catch (error) {
    console.error('Chat overview error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.post('/delete-cutoff', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const targetType = String(req.body?.targetType || '').trim();
    const targetUid = Number(req.body?.targetUid);
    const cutoffMs = Number(req.body?.cutoffMs);
    if (!isValidTargetType(targetType)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (!isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }

    const { user, users } = req.auth;
    if (targetType === 'private') {
      const targetUser = users.find((item) => item.uid === targetUid);
      if (!targetUser) {
        res.status(404).json({ success: false, message: 'Request failed.' });
        return;
      }
      const isMutualFriend =
        Array.isArray(user.friends) &&
        user.friends.includes(targetUid) &&
        Array.isArray(targetUser.friends) &&
        targetUser.friends.includes(user.uid);
      if (!isMutualFriend) {
        res.status(403).json({ success: false, message: 'Request failed.' });
        return;
      }
    } else {
      const group = await getGroupById(targetUid);
      if (!group) {
        res.status(404).json({ success: false, message: 'Request failed.' });
        return;
      }
      const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
      if (!memberSet.has(user.uid)) {
        res.status(403).json({ success: false, message: 'Request failed.' });
        return;
      }
    }

    const deviceHeaderId = resolveDeleteCutoffDeviceHeaderId(req);
    const deviceId = deviceHeaderId || resolveDeleteCutoffDeviceId(req);
    if (!deviceId) {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    const database = await openDb();
    let shouldFlush = false;
    let deviceBaselineCutoffMs = 0;
    if (deviceHeaderId) {
      const baseline = ensureDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
        createdAtMs: resolveDeviceCreatedAtMsFromRequest(req, deviceId),
      });
      deviceBaselineCutoffMs = baseline.cutoffMs;
      if (baseline.inserted) {
        shouldFlush = true;
      }
    } else {
      deviceBaselineCutoffMs = getDeviceBaselineCutoff(database, {
        uid: user.uid,
        deviceId,
      });
    }
    upsertDeleteCutoff(database, {
      uid: user.uid,
      deviceId,
      targetType,
      targetUid,
      cutoffMs,
    });
    shouldFlush = true;
    if (shouldFlush) {
      scheduleFlush();
    }
    const targetCutoffMs = getDeleteCutoffForTarget(database, {
      uid: user.uid,
      deviceId,
      targetType,
      targetUid,
    });
    const effectiveCutoffMs = Math.max(deviceBaselineCutoffMs, targetCutoffMs);
    trackRouteEvent(req, {
      eventType: 'mute',
      targetUid,
      targetType,
      tags: ['delete_cutoff'],
      metadata: {
        cutoffMs: effectiveCutoffMs,
      },
    });
    res.json({
      success: true,
      data: {
        targetType,
        targetUid,
        cutoffMs: effectiveCutoffMs,
      },
    });
  } catch (error) {
    console.error('Chat delete cutoff error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.delete('/del', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const rawId = req.body?.id;
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || String(rawId).trim() === '') {
      res.status(400).json({ success: false, message: 'Request failed.' });
      return;
    }
    const id = String(rawId).trim();

    const database = await openDb();
    const existing = queryOnePrepared(
      database,
      'messages:select_by_id_full',
      'SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs FROM messages WHERE id = ?',
      [id]
    );
    if (!existing) {
      res.status(404).json({ success: false, message: 'Request failed.' });
      return;
    }

    const { user } = req.auth;
    const senderUid = Number(existing.senderUid);
    const targetUid = Number(existing.targetUid);
    const targetType = String(existing.targetType || '');
    const isSender = Number.isInteger(senderUid) && senderUid === user.uid;
    const isPrivateRecipient =
      targetType === 'private' &&
      isValidUid(targetUid) &&
      targetUid === user.uid;
    let isGroupMember = false;
    if (targetType === 'group' && isValidUid(targetUid)) {
      const groups = await readGroups();
      const group = groups.find((item) => Number(item?.id) === targetUid);
      const memberUids = Array.isArray(group?.memberUids)
        ? group.memberUids.filter((uid) => Number.isInteger(uid))
        : [];
      isGroupMember = memberUids.includes(user.uid);
    }
    if (!isSender && !isPrivateRecipient && !isGroupMember) {
      res.status(403).json({ success: false, message: 'Request failed.' });
      return;
    }

    executePrepared(
      database,
      'messages:delete_by_id',
      'DELETE FROM messages WHERE id = ?',
      [id]
    );
    scheduleFlush();
    res.json({ success: true, data: toMessage(existing) });
  } catch (error) {
    console.error('Chat delete error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

const ADMIN_MAX_PAGE_SIZE = 200;

const sanitizeAdminKeyword = (value, maxLen = 160) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const toAdminPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const parseAdminTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.floor(asNumber);
    }
    const asDate = Date.parse(trimmed);
    if (Number.isFinite(asDate) && asDate > 0) {
      return Math.floor(asDate);
    }
  }
  return 0;
};

const toAdminMessagePreview = (message) => {
  const data = message?.data && typeof message.data === 'object' ? message.data : {};
  if (typeof data.content === 'string' && data.content.trim()) {
    return data.content.trim();
  }
  if (typeof data.text === 'string' && data.text.trim()) {
    return data.text.trim();
  }
  if (typeof data.name === 'string' && data.name.trim()) {
    return `[${message?.type || 'message'}] ${data.name.trim()}`;
  }
  if (typeof data.url === 'string' && data.url.trim()) {
    return `[${message?.type || 'message'}] ${data.url.trim()}`;
  }
  return '';
};

const normalizeAdminMessageFilters = (filters = {}) => {
  const page = toAdminPositiveInt(filters.page, 1, 1);
  const pageSize = toAdminPositiveInt(filters.pageSize, 20, 1, ADMIN_MAX_PAGE_SIZE);
  const q = sanitizeAdminKeyword(filters.q, 160).toLowerCase();
  const targetType = sanitizeAdminKeyword(filters.targetType, 20).toLowerCase();
  const type = sanitizeAdminKeyword(filters.type, 20).toLowerCase();
  const sort = sanitizeAdminKeyword(filters.sort, 8).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const senderUid = Number(filters.senderUid);
  const targetUid = Number(filters.targetUid);
  let startMs = parseAdminTimestamp(filters.startMs ?? filters.sinceMs ?? filters.startAt);
  let endMs = parseAdminTimestamp(filters.endMs ?? filters.beforeMs ?? filters.endAt);

  if (startMs > 0 && endMs > 0 && startMs > endMs) {
    const temp = startMs;
    startMs = endMs;
    endMs = temp;
  }

  return {
    page,
    pageSize,
    q,
    targetType: ALLOWED_TARGET_TYPES.has(targetType) ? targetType : '',
    type: ALLOWED_TYPES.has(type) ? type : '',
    senderUid: isValidUid(senderUid) ? senderUid : 0,
    targetUid: isValidUid(targetUid) ? targetUid : 0,
    startMs: startMs > 0 ? startMs : 0,
    endMs: endMs > 0 ? endMs : 0,
    sort,
  };
};

const buildAdminMessagesWhere = (filters) => {
  const clauses = [];
  const params = [];

  if (filters.senderUid > 0) {
    clauses.push('senderUid = ?');
    params.push(filters.senderUid);
  }
  if (filters.targetUid > 0) {
    clauses.push('targetUid = ?');
    params.push(filters.targetUid);
  }
  if (filters.targetType) {
    clauses.push('targetType = ?');
    params.push(filters.targetType);
  }
  if (filters.type) {
    clauses.push('type = ?');
    params.push(filters.type);
  }
  if (filters.startMs > 0) {
    clauses.push('createdAtMs >= ?');
    params.push(filters.startMs);
  }
  if (filters.endMs > 0) {
    clauses.push('createdAtMs <= ?');
    params.push(filters.endMs);
  }
  if (filters.q) {
    const like = `%${filters.q}%`;
    clauses.push('(LOWER(id) LIKE ? OR LOWER(data) LIKE ? OR CAST(senderUid AS TEXT) LIKE ? OR CAST(targetUid AS TEXT) LIKE ?)');
    params.push(like, like, like, like);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
};

const toAdminMessage = (row) => {
  const message = toMessage(row);
  const createdAtMs = Number(row?.createdAtMs);
  const normalizedCreatedAtMs =
    Number.isFinite(createdAtMs) && createdAtMs > 0
      ? Math.floor(createdAtMs)
      : Number.isFinite(Date.parse(message.createdAt))
        ? Date.parse(message.createdAt)
        : 0;
  return {
    ...message,
    createdAtMs: normalizedCreatedAtMs,
    preview: toAdminMessagePreview(message).slice(0, 220),
  };
};

const querySingleNumber = (database, sql, params = []) => {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  let value = 0;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    const first = row ? Object.values(row)[0] : 0;
    const parsed = Number(first);
    value = Number.isFinite(parsed) ? parsed : 0;
  }
  stmt.free();
  return value;
};

const searchMessagesForAdmin = async (filters = {}) => {
  await ensureChatStorage();
  const database = await openDb();
  const normalized = normalizeAdminMessageFilters(filters);
  const { whereSql, params } = buildAdminMessagesWhere(normalized);

  const total = querySingleNumber(database, `SELECT COUNT(1) AS total FROM messages ${whereSql}`, params);
  const offset = Math.max(0, (normalized.page - 1) * normalized.pageSize);
  const order = normalized.sort === 'asc' ? 'ASC' : 'DESC';
  const stmt = database.prepare(`
    SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
    FROM messages
    ${whereSql}
    ORDER BY createdAtMs ${order}
    LIMIT ? OFFSET ?
  `);
  stmt.bind([...params, normalized.pageSize, offset]);
  const items = [];
  while (stmt.step()) {
    items.push(toAdminMessage(stmt.getAsObject()));
  }
  stmt.free();

  return {
    items,
    total,
    page: normalized.page,
    pageSize: normalized.pageSize,
    filters: normalized,
  };
};

const findMessageByIdForAdmin = async (id) => {
  const messageId = typeof id === 'string' ? id.trim() : String(id || '').trim();
  if (!messageId) return null;
  await ensureChatStorage();
  const database = await openDb();
  const row = queryOnePrepared(
    database,
    'messages:select_by_id_full',
    'SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs FROM messages WHERE id = ?',
    [messageId]
  );
  if (!row) {
    return null;
  }
  return toAdminMessage(row);
};

const deleteMessageByIdForAdmin = async (id) => {
  const messageId = typeof id === 'string' ? id.trim() : String(id || '').trim();
  if (!messageId) return null;
  await ensureChatStorage();
  const database = await openDb();
  const row = queryOnePrepared(
    database,
    'messages:select_by_id_full',
    'SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs FROM messages WHERE id = ?',
    [messageId]
  );
  if (!row) {
    return null;
  }

  executePrepared(
    database,
    'messages:delete_by_id',
    'DELETE FROM messages WHERE id = ?',
    [messageId]
  );
  scheduleFlush();

  return toAdminMessage(row);
};

const summarizeMessagesForAdmin = async ({ windowHours = 24 } = {}) => {
  await ensureChatStorage();
  const database = await openDb();
  const safeWindowHours = toAdminPositiveInt(windowHours, 24, 1, 24 * 365);
  const sinceMs = Date.now() - safeWindowHours * 60 * 60 * 1000;

  const total = querySingleNumberPrepared(
    database,
    'summary:messages_total',
    'SELECT COUNT(1) AS total FROM messages'
  );
  const inWindow = querySingleNumberPrepared(
    database,
    'summary:messages_window_total',
    'SELECT COUNT(1) AS total FROM messages WHERE createdAtMs >= ?',
    [sinceMs]
  );

  const byType = {};
  const typeRows = queryRowsPrepared(
    database,
    'summary:messages_by_type',
    'SELECT type, COUNT(1) AS count FROM messages GROUP BY type'
  );
  for (const row of typeRows) {
    const type = String(row?.type || '').trim() || 'unknown';
    byType[type] = Number(row?.count) || 0;
  }

  const byTargetType = {};
  const targetRows = queryRowsPrepared(
    database,
    'summary:messages_by_target_type',
    'SELECT targetType, COUNT(1) AS count FROM messages GROUP BY targetType'
  );
  for (const row of targetRows) {
    const targetType = String(row?.targetType || '').trim() || 'unknown';
    byTargetType[targetType] = Number(row?.count) || 0;
  }

  return {
    total,
    inWindow,
    windowHours: safeWindowHours,
    sinceAt: new Date(sinceMs).toISOString(),
    byType,
    byTargetType,
  };
};

export {
  ensureChatStorage,
  getChatDatabaseForOps,
  setChatNotifier,
  searchMessagesForAdmin,
  findMessageByIdForAdmin,
  deleteMessageByIdForAdmin,
  summarizeMessagesForAdmin,
};
export default router;












