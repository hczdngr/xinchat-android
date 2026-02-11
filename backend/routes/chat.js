/**
 * 模块说明：聊天路由模块：处理消息、上传、贴纸与会话读取逻辑。
 */


﻿import express from 'express';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { createAuthenticateMiddleware, extractToken } from './session.js';
import { getGroupById, readGroups } from './groups.js';

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
const DB_TMP_PATH = path.join(DATA_DIR, 'chat.sqlite.tmp');

const router = express.Router();
const ALLOWED_TYPES = new Set(['image', 'video', 'voice', 'text', 'gif', 'file', 'card', 'call']);
const ALLOWED_TARGET_TYPES = new Set(['private', 'group']);
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const FLUSH_INTERVAL_MS = 250;
let chatNotifier = null;

// isValidType：判断条件是否成立。
const isValidType = (value) => typeof value === 'string' && ALLOWED_TYPES.has(value);
// isValidTargetType：判断条件是否成立。
const isValidTargetType = (value) =>
  typeof value === 'string' && ALLOWED_TARGET_TYPES.has(value);
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
// isValidUid：判断条件是否成立。
const isValidUid = (value) =>
  Number.isInteger(value) && value > 0 && value <= SAFE_MAX_UID;

let sqlModule = null;
let db = null;
let flushTimer = null;
let flushInFlight = false;
let pendingFlush = false;
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

// parseImageDataUrl：解析并校验输入值。
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

// parseDataUrl：解析并校验输入值。
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

// fileExists?处理 fileExists 相关逻辑。
const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

// readUserfileIndex：读取持久化或缓存数据。
const readUserfileIndex = async () => {
  try {
    const raw = await fs.readFile(USERFILE_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

// writeUserfileIndex：写入持久化数据。
const writeUserfileIndex = async (index) => {
  await fs.mkdir(USERFILE_DIR, { recursive: true });
  await fs.writeFile(USERFILE_INDEX_PATH, JSON.stringify(index || {}, null, 2));
};

// normalizeStickerStore：归一化外部输入。
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

// ensureStickerStore：确保前置条件与资源可用。
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

// persistStickerStore?处理 persistStickerStore 相关逻辑。
const persistStickerStore = async () => {
  await fs.mkdir(STICKER_DIR, { recursive: true });
  const next = {
    ...stickerStoreCache,
    updatedAt: new Date().toISOString(),
  };
  stickerStoreCache = next;
  const tempPath = `${STICKER_INDEX_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), 'utf-8');
  await fs.rename(tempPath, STICKER_INDEX_PATH);
};

// queueStickerStorePersist：将任务按顺序排队处理。
const queueStickerStorePersist = async () => {
  stickerStoreWriteChain = stickerStoreWriteChain
    .catch(() => undefined)
    .then(() => persistStickerStore());
  await stickerStoreWriteChain;
};

// getUserStickerList：获取并返回目标数据。
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

// upsertUserSticker?处理 upsertUserSticker 相关逻辑。
const upsertUserSticker = async ({ uid, hash, ext, mime, size, url, skipPersist = false }) => {
  await ensureStickerStore();
  const now = new Date().toISOString();
  const safeExt = String(ext || '').trim().toLowerCase();
  const safeMime = String(mime || '').trim().toLowerCase();
  const safeHash = String(hash || '').trim();
  const safeUrl = String(url || '').trim();
  if (!safeHash || !safeUrl || !ALLOWED_STICKER_EXTS.has(safeExt)) {
    throw new Error('贴纸格式无效。');
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

// pruneUserfileIndex：清理无效或过期数据。
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

// sanitizeFilename：清洗不可信输入。
const sanitizeFilename = (value) => {
  const base = path.basename(String(value || '').trim());
  if (!base) return '';
  return base.replace(/[\\/:*?"<>|]+/g, '_');
};

// guessExtension?处理 guessExtension 相关逻辑。
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

// resolvePathWithinRoot：解析并确定最终值。
const resolvePathWithinRoot = (rootDir, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return '';
  if (relativePath.includes('\0')) return '';
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root) return '';
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : '';
};

// cleanupUserFiles?处理 cleanupUserFiles 相关逻辑。
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

// maybeCleanupUserFiles?处理 maybeCleanupUserFiles 相关逻辑。
const maybeCleanupUserFiles = async () => {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  await cleanupUserFiles();
};

// buildFileMeta：构建对外输出数据。
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

// storeUserFileBuffer?处理 storeUserFileBuffer 相关逻辑。
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

// storeUserFileFromPath?处理 storeUserFileFromPath 相关逻辑。
const storeUserFileFromPath = async (sourcePath, senderUid, name, mime) => {
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('文件过大。');
  }
  const buffer = await fs.readFile(sourcePath);
  return storeUserFileBuffer(buffer, senderUid, name, mime);
};

// storeImageBuffer?处理 storeImageBuffer 相关逻辑。
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

// getImageExtFromMime：获取并返回目标数据。
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

// readStreamToFile：读取持久化或缓存数据。
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
        cleanup(new Error('文件过大。'));
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

// readStreamToBuffer：读取持久化或缓存数据。
const readStreamToBuffer = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('文件过大。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

// findImageUrlByHash：查找目标记录。
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

// getSqlModule：获取并返回目标数据。
const getSqlModule = async () => {
  if (sqlModule) {
    return sqlModule;
  }
  sqlModule = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  return sqlModule;
};

// openDb?处理 openDb 相关逻辑。
const openDb = async () => {
  if (db) {
    return db;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const SQL = await getSqlModule();
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

// flushDb：将内存状态刷入磁盘。
const flushDb = async () => {
  if (!db) {
    return;
  }
  if (flushInFlight) {
    pendingFlush = true;
    return;
  }
  flushInFlight = true;
  try {
    const data = db.export();
    await fs.writeFile(DB_TMP_PATH, Buffer.from(data));
    await fs.rename(DB_TMP_PATH, DB_PATH);
  } finally {
    flushInFlight = false;
    if (pendingFlush) {
      pendingFlush = false;
      await flushDb();
    }
  }
};

// scheduleFlush?处理 scheduleFlush 相关逻辑。
const scheduleFlush = () => {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushDb();
  }, FLUSH_INTERVAL_MS);
};

// setChatNotifier：设置运行时状态。
const setChatNotifier = (notifier) => {
  chatNotifier = typeof notifier === 'function' ? notifier : null;
};

// migrateChatJson?处理 migrateChatJson 相关逻辑。
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

// ensureChatStorage：确保前置条件与资源可用。
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

const authenticate = createAuthenticateMiddleware({ scope: 'Chat' });

// toMessage?处理 toMessage 相关逻辑。
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

// parseReadAtMap：解析并校验输入值。
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

// normalizeDeviceId：归一化外部输入。
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

// resolveDeleteCutoffDeviceHeaderId：解析并确定最终值。
const resolveDeleteCutoffDeviceHeaderId = (req) =>
  normalizeDeviceId(String(req.headers['x-xinchat-device-id'] || '')) ||
  normalizeDeviceId(String(req.headers['x-device-id'] || ''));

// resolveDeleteCutoffDeviceId：解析并确定最终值。
const resolveDeleteCutoffDeviceId = (req) => {
  const fromHeader = resolveDeleteCutoffDeviceHeaderId(req);
  if (fromHeader) return fromHeader;
  const token = String(extractToken(req) || '').trim();
  if (!token) return '';
  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 48);
  return hash ? `tok:${hash}` : '';
};

// extractDeviceCreatedAtMsFromId：提取请求中的关键信息。
const extractDeviceCreatedAtMsFromId = (deviceId) => {
  if (typeof deviceId !== 'string') return 0;
  const match = deviceId.trim().match(/^dev_([0-9a-z]+)_/i);
  if (!match) return 0;
  const parsed = parseInt(match[1], 36);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

// normalizeDeviceCreatedAtMs：归一化外部输入。
const normalizeDeviceCreatedAtMs = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const floored = Math.floor(parsed);
  const maxAllowed = Date.now() + MAX_DEVICE_CREATED_AT_FUTURE_DRIFT_MS;
  return floored > maxAllowed ? maxAllowed : floored;
};

// resolveDeviceCreatedAtMsFromRequest：解析并确定最终值。
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

// getDeviceBaselineCutoff：获取并返回目标数据。
const getDeviceBaselineCutoff = (database, { uid, deviceId }) => {
  if (!database) return 0;
  if (!Number.isInteger(uid) || uid <= 0 || !deviceId) return 0;
  const stmt = database.prepare(`
    SELECT createdAtMs
    FROM chat_device_state
    WHERE uid = ? AND deviceId = ?
    LIMIT 1
  `);
  stmt.bind([uid, deviceId]);
  let cutoffMs = 0;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    const parsed = Number(row?.createdAtMs);
    cutoffMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  stmt.free();
  return cutoffMs;
};

// ensureDeviceBaselineCutoff：确保前置条件与资源可用。
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
  const stmt = database.prepare(`
    INSERT INTO chat_device_state (uid, deviceId, createdAtMs, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(uid, deviceId)
    DO UPDATE SET
      createdAtMs = CASE
        WHEN excluded.createdAtMs < chat_device_state.createdAtMs THEN excluded.createdAtMs
        ELSE chat_device_state.createdAtMs
      END,
      updatedAt = excluded.updatedAt
  `);
  stmt.run([uid, deviceId, normalized, nowIso]);
  stmt.free();
  const finalCutoff = getDeviceBaselineCutoff(database, { uid, deviceId });
  return {
    cutoffMs: finalCutoff > 0 ? finalCutoff : normalized,
    inserted: true,
  };
};

// normalizeDeleteCutoffEntry：归一化外部输入。
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

// parseDeleteCutoffList：解析并校验输入值。
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

// upsertDeleteCutoff?处理 upsertDeleteCutoff 相关逻辑。
const upsertDeleteCutoff = (database, { uid, deviceId, targetType, targetUid, cutoffMs }) => {
  if (!database) return;
  if (!Number.isInteger(uid) || uid <= 0) return;
  if (!deviceId || !isValidTargetType(targetType)) return;
  if (!Number.isInteger(targetUid) || targetUid <= 0) return;
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return;
  const nowIso = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO chat_delete_cutoffs (uid, deviceId, targetType, targetUid, cutoffMs, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, deviceId, targetType, targetUid)
    DO UPDATE SET
      cutoffMs = CASE
        WHEN excluded.cutoffMs > chat_delete_cutoffs.cutoffMs THEN excluded.cutoffMs
        ELSE chat_delete_cutoffs.cutoffMs
      END,
      updatedAt = excluded.updatedAt
  `);
  stmt.run([uid, deviceId, targetType, targetUid, Math.floor(cutoffMs), nowIso]);
  stmt.free();
};

// getDeleteCutoffForTarget：获取并返回目标数据。
const getDeleteCutoffForTarget = (database, { uid, deviceId, targetType, targetUid }) => {
  if (!database) return 0;
  if (!Number.isInteger(uid) || uid <= 0) return 0;
  if (!deviceId || !isValidTargetType(targetType)) return 0;
  if (!Number.isInteger(targetUid) || targetUid <= 0) return 0;
  const stmt = database.prepare(`
    SELECT cutoffMs
    FROM chat_delete_cutoffs
    WHERE uid = ? AND deviceId = ? AND targetType = ? AND targetUid = ?
    LIMIT 1
  `);
  stmt.bind([uid, deviceId, targetType, targetUid]);
  let cutoffMs = 0;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    const parsed = Number(row?.cutoffMs);
    cutoffMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  stmt.free();
  return cutoffMs;
};

// loadDeleteCutoffMapByDevice?处理 loadDeleteCutoffMapByDevice 相关逻辑。
const loadDeleteCutoffMapByDevice = (database, { uid, deviceId }) => {
  const result = {
    private: new Map(),
    group: new Map(),
  };
  if (!database) return result;
  if (!Number.isInteger(uid) || uid <= 0 || !deviceId) return result;
  const stmt = database.prepare(`
    SELECT targetType, targetUid, cutoffMs
    FROM chat_delete_cutoffs
    WHERE uid = ? AND deviceId = ?
  `);
  stmt.bind([uid, deviceId]);
  while (stmt.step()) {
    const row = stmt.getAsObject();
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
  stmt.free();
  return result;
};

// 路由：POST /send。
router.post('/send', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const body = req.body || {};
    if (!isValidType(body.type)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    if (!isValidTargetType(body.targetType)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    const targetType = String(body.targetType || '');

    const senderUid = Number(body.senderUid);
    const targetUid = Number(body.targetUid);
    if (!isValidUid(senderUid) || !isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }

	    const { user, users } = req.auth;
    if (user.uid !== senderUid) {
      res.status(403).json({ success: false, message: '请求失败。' });
      return;
    }

    if (targetType === 'private') {
      const targetUser = users.find((item) => item.uid === targetUid);
      if (!targetUser) {
        res.status(404).json({ success: false, message: '请求失败。' });
        return;
      }

      const isMutualFriend =
        Array.isArray(user.friends) &&
        user.friends.includes(targetUid) &&
        Array.isArray(targetUser.friends) &&
        targetUser.friends.includes(user.uid);
      if (!isMutualFriend) {
        res.status(403).json({ success: false, message: '请求失败。' });
        return;
      }
	    } else {
	      const group = await getGroupById(targetUid);
      if (!group) {
        res.status(404).json({ success: false, message: '群聊不存在。' });
        return;
      }
      const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
      if (!memberSet.has(user.uid)) {
        res.status(403).json({ success: false, message: '你不在该群聊中。' });
        return;
      }
    }

    const { type, senderUid: _, targetUid: __, targetType: ___, ...data } = body;
    const messageData = { ...data };
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
        res.status(400).json({ success: false, message: '文本消息不能为空。' });
        return;
      }
      if (hasImagePayload) {
        res.status(400).json({ success: false, message: '不支持图文一起发送。' });
        return;
      }
      messageData.content = content;
      delete messageData.text;
    }
    if (type === 'image') {
      const textContent = typeof messageData.content === 'string' ? messageData.content.trim() : '';
      const textAlias = typeof messageData.text === 'string' ? messageData.text.trim() : '';
      if (textContent || textAlias) {
        res.status(400).json({ success: false, message: '不支持图文一起发送。' });
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
          res.status(400).json({ success: false, message: '图片消息仅支持单张发送。' });
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
          res.status(400).json({ success: false, message: '图片消息不能为空。' });
          return;
        }
        messageData.url = urls[0];
        delete messageData.urls;
      } else {
        const rawUrl =
          typeof messageData.url === 'string' ? messageData.url.trim() : '';
        if (!rawUrl) {
          res.status(400).json({ success: false, message: '图片消息不能为空。' });
          return;
        }
        const normalized = await normalizeImageValue(rawUrl);
        if (!normalized || !String(normalized).trim()) {
          res.status(400).json({ success: false, message: '图片消息不能为空。' });
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
          res.status(400).json({ success: false, message: '请求失败。' });
          return;
        }
        if (parsed.buffer.length > MAX_FILE_BYTES) {
          res.status(400).json({ success: false, message: '请求失败。' });
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
          res.status(400).json({ success: false, message: '请求失败。' });
          return;
        }
        const relativePath = decodeURIComponent(
          parsedUrl.pathname.replace('/uploads/userfile/', '')
        );
        const sourcePath = resolvePathWithinRoot(USERFILE_DIR, relativePath);
        if (!sourcePath) {
          res.status(400).json({ success: false, message: '请求失败。' });
          return;
        }
        if (!(await fileExists(sourcePath))) {
          res.status(404).json({ success: false, message: '请求失败。' });
          return;
        }
        const stat = await fs.stat(sourcePath);
        size = stat.size;
        if (size > MAX_FILE_BYTES) {
          res.status(400).json({ success: false, message: '请求失败。' });
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
        res.status(400).json({ success: false, message: '请求失败。' });
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
    const stmt = database.prepare(`
      INSERT INTO messages (
        id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      entry.id,
      entry.type,
      entry.senderUid,
      entry.targetUid,
      entry.targetType,
      JSON.stringify(entry.data || {}),
      entry.createdAt,
      createdAtMs,
    ]);
    stmt.free();
    scheduleFlush();
    if (chatNotifier) {
      setImmediate(() => chatNotifier(entry));
    }
    res.json({ success: true, data: entry });
  } catch (error) {
    console.error('Chat send error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

// 路由：GET /stickers/list。
router.get('/stickers/list', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const { user } = req.auth;
    const list = getUserStickerList(user.uid);
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Sticker list error:', error);
    res.status(500).json({ success: false, message: '获取贴纸失败。' });
  }
});

// 路由：POST /stickers/upload/batch。
router.post('/stickers/upload/batch', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_STICKER_BATCH_UPLOAD) : [];
    if (!items.length) {
      res.status(400).json({ success: false, message: '贴纸列表不能为空。' });
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
      res.status(400).json({ success: false, message: '贴纸格式无效。' });
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
    res.status(400).json({ success: false, message: '贴纸批量上传失败。' });
  }
});

// 路由：POST /stickers/upload。
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
      res.status(400).json({ success: false, message: '贴纸格式无效。' });
      return;
    }
    if (parsed.buffer.length <= 0 || parsed.buffer.length > MAX_STICKER_BYTES) {
      res.status(400).json({ success: false, message: '贴纸大小无效。' });
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
    const message = error?.message === '贴纸格式无效。' ? error.message : '贴纸上传失败。';
    res.status(400).json({ success: false, message });
  }
});

// 路由：POST /upload/image。
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
        res.status(400).json({ success: false, message: '请求失败。' });
        return;
      }
      if (buffer.length > MAX_FILE_BYTES) {
        res.status(400).json({ success: false, message: '请求失败。' });
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
    const message = error?.message === '文件过大。' ? '文件过大。' : '上传失败。';
    res.status(400).json({ success: false, message });
  }
});

// 路由：POST /upload/file。
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
    const message = error?.message === '文件过大。' ? '文件过大。' : '上传失败。';
    res.status(400).json({ success: false, message });
  }
});

// 路由：GET /get。
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
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    if (!isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    if (type && !isValidType(type)) {
      res.status(400).json({ success: false, message: '请求失败。' });
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
        res.status(404).json({ success: false, message: '请求失败。' });
        return;
      }
      const isMutualFriend =
        Array.isArray(user.friends) &&
        user.friends.includes(targetUid) &&
        Array.isArray(targetUser.friends) &&
        targetUser.friends.includes(user.uid);
      if (!isMutualFriend) {
        res.status(403).json({ success: false, message: '请求失败。' });
        return;
      }
    } else {
      const group = await getGroupById(targetUid);
      if (!group) {
        res.status(404).json({ success: false, message: '群聊不存在。' });
        return;
      }
      const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
	      if (!memberSet.has(user.uid)) {
	        res.status(403).json({ success: false, message: '你不在该群聊中。' });
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
      const sinceStmt = database.prepare('SELECT createdAtMs FROM messages WHERE id = ?');
      sinceStmt.bind([sinceId]);
      if (sinceStmt.step()) {
        const row = sinceStmt.getAsObject();
        if (row && Number.isFinite(row.createdAtMs)) {
          sinceMs = Math.max(sinceMs, row.createdAtMs);
        }
      }
      sinceStmt.free();
    }
    if (beforeId) {
      const beforeStmt = database.prepare('SELECT createdAtMs FROM messages WHERE id = ?');
      beforeStmt.bind([beforeId]);
      if (beforeStmt.step()) {
        const row = beforeStmt.getAsObject();
        if (row && Number.isFinite(row.createdAtMs)) {
          beforeMs = row.createdAtMs;
        }
      }
      beforeStmt.free();
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
    res.json({ success: true, data });
  } catch (error) {
    console.error('Chat get error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

// 路由：POST /overview。
router.post('/overview', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const { user, users } = req.auth;
    const friendIds = (Array.isArray(user.friends) ? user.friends : []).filter((uid) => {
      if (!Number.isInteger(uid)) return false;
      const target = users.find((item) => item.uid === uid);
      return (
        Boolean(target) &&
        Array.isArray(target.friends) &&
        target.friends.includes(user.uid)
      );
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
      res.json({ success: true, data: [] });
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
	      const placeholders = friendIds.map(() => '?').join(',');
	      const stmt = database.prepare(`
        SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
        FROM messages
        WHERE targetType = 'private'
          AND (
            (senderUid = ? AND targetUid IN (${placeholders}))
            OR
            (targetUid = ? AND senderUid IN (${placeholders}))
          )
        ORDER BY createdAtMs DESC
      `);
      stmt.bind([user.uid, ...friendIds, user.uid, ...friendIds]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const senderUid = Number(row.senderUid);
        const targetUid = Number(row.targetUid);
	        const createdAtMs = Number(row.createdAtMs) || 0;
	        const friendUid = senderUid === user.uid ? targetUid : senderUid;
	        if (!friendSet.has(friendUid)) {
	          continue;
	        }
        const deleteCutoffMs = Number(deleteCutoffMap.private.get(friendUid)) || 0;
        const effectiveCutoffMs = Math.max(deviceBaselineCutoffMs, deleteCutoffMs);
        if (effectiveCutoffMs > 0 && createdAtMs <= effectiveCutoffMs) {
          continue;
        }
	        if (!latestMap[friendUid]) {
	          latestMap[friendUid] = toMessage(row);
	        }
        if (row.type === 'text' && senderUid !== user.uid) {
          const seenAt = Number(readAt[friendUid]) || 0;
          if (createdAtMs > seenAt) {
            unreadMap[friendUid] = (unreadMap[friendUid] || 0) + 1;
          }
        }
      }
      stmt.free();
    }

	    if (groupIds.length > 0) {
	      const placeholders = groupIds.map(() => '?').join(',');
	      const groupStmt = database.prepare(`
        SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
        FROM messages
        WHERE targetType = 'group' AND targetUid IN (${placeholders})
        ORDER BY createdAtMs DESC
      `);
      groupStmt.bind(groupIds);
      while (groupStmt.step()) {
        const row = groupStmt.getAsObject();
        const groupUid = Number(row.targetUid);
        const senderUid = Number(row.senderUid);
	        const createdAtMs = Number(row.createdAtMs) || 0;
	        if (!groupSet.has(groupUid)) {
	          continue;
	        }
        const deleteCutoffMs = Number(deleteCutoffMap.group.get(groupUid)) || 0;
        const effectiveCutoffMs = Math.max(deviceBaselineCutoffMs, deleteCutoffMs);
        if (effectiveCutoffMs > 0 && createdAtMs <= effectiveCutoffMs) {
          continue;
        }
	        if (!latestMap[groupUid]) {
	          latestMap[groupUid] = toMessage(row);
	        }
        if (row.type === 'text' && senderUid !== user.uid) {
          const seenAt = Number(readAt[groupUid]) || 0;
          if (createdAtMs > seenAt) {
            unreadMap[groupUid] = (unreadMap[groupUid] || 0) + 1;
          }
        }
      }
      groupStmt.free();
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
    res.json({ success: true, data });
  } catch (error) {
    console.error('Chat overview error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

// 路由：POST /delete-cutoff。
router.post('/delete-cutoff', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const targetType = String(req.body?.targetType || '').trim();
    const targetUid = Number(req.body?.targetUid);
    const cutoffMs = Number(req.body?.cutoffMs);
    if (!isValidTargetType(targetType)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    if (!isValidUid(targetUid)) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }

    const { user, users } = req.auth;
    if (targetType === 'private') {
      const targetUser = users.find((item) => item.uid === targetUid);
      if (!targetUser) {
        res.status(404).json({ success: false, message: '请求失败。' });
        return;
      }
      const isMutualFriend =
        Array.isArray(user.friends) &&
        user.friends.includes(targetUid) &&
        Array.isArray(targetUser.friends) &&
        targetUser.friends.includes(user.uid);
      if (!isMutualFriend) {
        res.status(403).json({ success: false, message: '请求失败。' });
        return;
      }
    } else {
      const group = await getGroupById(targetUid);
      if (!group) {
        res.status(404).json({ success: false, message: '群聊不存在。' });
        return;
      }
      const memberSet = new Set(Array.isArray(group.memberUids) ? group.memberUids : []);
      if (!memberSet.has(user.uid)) {
        res.status(403).json({ success: false, message: '你不在该群聊中。' });
        return;
      }
    }

    const deviceHeaderId = resolveDeleteCutoffDeviceHeaderId(req);
    const deviceId = deviceHeaderId || resolveDeleteCutoffDeviceId(req);
    if (!deviceId) {
      res.status(400).json({ success: false, message: '请求失败。' });
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
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

// 路由：DELETE /del。
router.delete('/del', authenticate, async (req, res) => {
  try {
    await ensureChatStorage();
    const rawId = req.body?.id;
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || String(rawId).trim() === '') {
      res.status(400).json({ success: false, message: '请求失败。' });
      return;
    }
    const id = String(rawId).trim();

    const database = await openDb();
    const selectStmt = database.prepare(
      'SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs FROM messages WHERE id = ?'
    );
    selectStmt.bind([id]);
    if (!selectStmt.step()) {
      selectStmt.free();
      res.status(404).json({ success: false, message: '请求失败。' });
      return;
    }
    const existing = selectStmt.getAsObject();
    selectStmt.free();

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
      res.status(403).json({ success: false, message: '请求失败。' });
      return;
    }

    const delStmt = database.prepare('DELETE FROM messages WHERE id = ?');
    delStmt.run([id]);
    delStmt.free();
    scheduleFlush();
    res.json({ success: true, data: toMessage(existing) });
  } catch (error) {
    console.error('Chat delete error:', error);
    res.status(500).json({ success: false, message: '请求失败。' });
  }
});

export { ensureChatStorage, setChatNotifier };
export default router;




