import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUsersCacheInfo, mutateUsers, readUsersCached } from './auth.js';
import { metrics } from '../observability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const PRODUCTS_PATH_TMP = path.join(DATA_DIR, 'products.json.tmp');

const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const ADMIN_API_TOKEN = String(process.env.ADMIN_API_TOKEN || '').trim();
const ADMIN_ENABLE_INSECURE =
  String(process.env.ADMIN_ENABLE_INSECURE || NODE_ENV !== 'production')
    .trim()
    .toLowerCase() === 'true';

const PRODUCTS_CACHE_TTL_MS = Number.parseInt(String(process.env.PRODUCTS_CACHE_TTL_MS || '5000'), 10);
const SAFE_PRODUCTS_CACHE_TTL_MS =
  Number.isInteger(PRODUCTS_CACHE_TTL_MS) && PRODUCTS_CACHE_TTL_MS >= 200
    ? PRODUCTS_CACHE_TTL_MS
    : 5000;

const MAX_PAGE_SIZE = 100;
const MAX_PRODUCTS = Number.parseInt(String(process.env.MAX_PRODUCTS || '5000'), 10) || 5000;
const MAX_NICKNAME_LEN = 36;
const MAX_SIGNATURE_LEN = 80;
const MAX_UID = Number.parseInt(String(process.env.MAX_UID || '2147483647'), 10);
const SAFE_MAX_UID = Number.isInteger(MAX_UID) && MAX_UID > 0 ? MAX_UID : 2147483647;
const DEFAULT_SIGNATURE =
  '\u8fd9\u4e2a\u4eba\u5f88\u795e\u79d8\uff0c\u6682\u672a\u586b\u5199\u7b7e\u540d';
const PRODUCT_STATUS_SET = new Set(['active', 'inactive', 'draft', 'archived']);

const router = express.Router();

let productsCache = null;
let productsCacheAt = 0;
let productsLoadInFlight = null;
let productsWriteQueue = Promise.resolve();
let productsVersion = 0;

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isValidUid = (value) => Number.isInteger(value) && value > 0 && value <= SAFE_MAX_UID;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const sanitizeText = (value, maxLen = 200) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const normalizeUserStatus = (user) => {
  if (typeof user?.deletedAt === 'string' && user.deletedAt.trim()) return 'deleted';
  if (user?.blocked === true) return 'blocked';
  return 'active';
};

const resolveTokenCount = (user) => {
  const list = Array.isArray(user?.tokens)
    ? user.tokens.filter((entry) => entry && typeof entry.token === 'string' && entry.token)
    : [];
  const single = typeof user?.token === 'string' && user.token ? 1 : 0;
  if (!single) return list.length;
  return list.some((entry) => entry.token === user.token) ? list.length : list.length + 1;
};

const toUserSummary = (user) => ({
  uid: Number(user?.uid) || 0,
  username: String(user?.username || ''),
  nickname: String(user?.nickname || user?.username || ''),
  signature: String(user?.signature || ''),
  avatar: String(user?.avatar || ''),
  domain: String(user?.domain || ''),
  online: user?.online === true,
  blocked: user?.blocked === true,
  deletedAt: typeof user?.deletedAt === 'string' ? user.deletedAt : '',
  status: normalizeUserStatus(user),
  tokenCount: resolveTokenCount(user),
  friendsCount: Array.isArray(user?.friends) ? user.friends.length : 0,
  createdAt: typeof user?.createdAt === 'string' ? user.createdAt : '',
  lastLoginAt: typeof user?.lastLoginAt === 'string' ? user.lastLoginAt : '',
});

const toUserDetail = (user) => ({
  ...toUserSummary(user),
  gender: String(user?.gender || ''),
  birthday: String(user?.birthday || ''),
  country: String(user?.country || ''),
  province: String(user?.province || ''),
  region: String(user?.region || ''),
  friendRequests: {
    incoming: Array.isArray(user?.friendRequests?.incoming) ? user.friendRequests.incoming.length : 0,
    outgoing: Array.isArray(user?.friendRequests?.outgoing) ? user.friendRequests.outgoing.length : 0,
  },
  aiProfileUpdatedAt: typeof user?.aiProfile?.updatedAt === 'string' ? user.aiProfile.updatedAt : '',
});

const parseAdminToken = (req) => {
  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = String(req.headers['x-admin-token'] || '').trim();
  if (headerToken) return headerToken;
  return String(req.query?.adminToken || '').trim();
};

const requireAdmin = (req, res, next) => {
  const token = parseAdminToken(req);
  if (ADMIN_API_TOKEN) {
    if (token !== ADMIN_API_TOKEN) {
      res.status(401).json({ success: false, message: 'Admin token invalid.' });
      return;
    }
    next();
    return;
  }
  if (!ADMIN_ENABLE_INSECURE) {
    res.status(403).json({
      success: false,
      message: 'Admin API disabled: set ADMIN_API_TOKEN or ADMIN_ENABLE_INSECURE=true.',
    });
    return;
  }
  next();
};

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const normalizeProductStatus = (value, fallback = 'draft') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (PRODUCT_STATUS_SET.has(normalized)) return normalized;
  return fallback;
};

const normalizeTags = (value) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(
    new Set(
      list
        .map((item) => sanitizeText(item, 24))
        .filter(Boolean)
        .slice(0, 12)
    )
  );
};
const normalizeProductRecord = (record, { fallbackId, nowIso }) => {
  if (!record || typeof record !== 'object') return null;
  const name = sanitizeText(record.name, 120);
  if (!name) return null;
  const idRaw = Number(record.id);
  const id = Number.isInteger(idRaw) && idRaw > 0 ? idRaw : fallbackId;
  if (!Number.isInteger(id) || id <= 0) return null;

  const priceRaw = Number(record.price);
  const stockRaw = Number(record.stock);
  const salesRaw = Number(record.sales);
  const costRaw = Number(record.cost);

  return {
    id,
    name,
    sku: sanitizeText(record.sku, 64),
    category: sanitizeText(record.category, 64),
    price: Number.isFinite(priceRaw) && priceRaw >= 0 ? Number(priceRaw) : 0,
    cost: Number.isFinite(costRaw) && costRaw >= 0 ? Number(costRaw) : 0,
    stock: Number.isInteger(stockRaw) && stockRaw >= 0 ? stockRaw : 0,
    sales: Number.isInteger(salesRaw) && salesRaw >= 0 ? salesRaw : 0,
    status: normalizeProductStatus(record.status, 'draft'),
    tags: normalizeTags(record.tags),
    description: sanitizeText(record.description, 600),
    createdAt: typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : nowIso,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : nowIso,
  };
};

const setProductsCache = (products, timestamp = Date.now()) => {
  productsCache = Array.isArray(products) ? products : [];
  productsCacheAt = timestamp;
  productsVersion += 1;
};

const ensureProductsStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(PRODUCTS_PATH);
  } catch {
    await fs.writeFile(PRODUCTS_PATH, '[]', 'utf-8');
  }
};

const queueProductsWriteTask = async (task) => {
  const run = productsWriteQueue.then(task);
  productsWriteQueue = run.catch(() => {});
  return run;
};

const persistProductsSnapshot = async (snapshot) => {
  await fs.writeFile(PRODUCTS_PATH_TMP, JSON.stringify(snapshot, null, 2), 'utf-8');
  await fs.rename(PRODUCTS_PATH_TMP, PRODUCTS_PATH);
  setProductsCache(snapshot, Date.now());
};

const loadProductsFromDisk = async () => {
  await ensureProductsStorage();
  const raw = await fs.readFile(PRODUCTS_PATH, 'utf-8');
  const parsed = JSON.parse(raw || '[]');
  const list = Array.isArray(parsed) ? parsed : [];
  const nowIso = new Date().toISOString();

  let maxId = 0;
  const normalized = [];
  list.forEach((entry, index) => {
    const fallbackId = Math.max(maxId + 1, 1 + index);
    const item = normalizeProductRecord(entry, { fallbackId, nowIso });
    if (!item) return;
    maxId = Math.max(maxId, item.id);
    normalized.push(item);
  });

  setProductsCache(normalized, Date.now());
  return productsCache || [];
};

const readProductsCached = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();
  if (
    !forceRefresh &&
    Array.isArray(productsCache) &&
    now - productsCacheAt < SAFE_PRODUCTS_CACHE_TTL_MS
  ) {
    return productsCache;
  }
  if (productsLoadInFlight) {
    await productsLoadInFlight;
    return productsCache || [];
  }

  productsLoadInFlight = queueProductsWriteTask(() => loadProductsFromDisk())
    .catch(async () => {
      await ensureProductsStorage();
      setProductsCache([], Date.now());
    })
    .finally(() => {
      productsLoadInFlight = null;
    });

  await productsLoadInFlight;
  return productsCache || [];
};

const mutateProducts = async (mutator, { defaultChanged = true } = {}) => {
  if (typeof mutator !== 'function') {
    throw new TypeError('mutateProducts requires a function mutator.');
  }
  await ensureProductsStorage();
  await readProductsCached();

  let changed = defaultChanged;
  let result;
  await queueProductsWriteTask(async () => {
    const working = cloneValue(productsCache || []);
    const output = await mutator(working);
    if (output && typeof output === 'object' && hasOwn(output, 'changed')) {
      changed = Boolean(output.changed);
      result = output.result;
    } else {
      result = output;
    }
    if (changed) {
      await persistProductsSnapshot(working);
    }
  });
  return { changed, result };
};

const getNextProductId = (products) => {
  let maxId = 0;
  (products || []).forEach((item) => {
    const id = Number(item?.id);
    if (Number.isInteger(id) && id > maxId) {
      maxId = id;
    }
  });
  return maxId + 1;
};

const buildProductsCacheInfo = () => ({
  version: productsVersion,
  cachedAt: productsCacheAt ? new Date(productsCacheAt).toISOString() : null,
  ageMs: productsCacheAt ? Math.max(0, Date.now() - productsCacheAt) : null,
});

const aggregateSlowEndpoints = (snapshot) => {
  const map = new Map();
  (snapshot?.histograms || [])
    .filter((entry) => entry?.name === 'http_request_duration_ms')
    .forEach((entry) => {
      const method = String(entry?.labels?.method || 'ALL');
      const pathValue = String(entry?.labels?.path || '/');
      const key = `${method} ${pathValue}`;
      const prev = map.get(key) || { key, method, path: pathValue, count: 0, sum: 0, max: 0 };
      prev.count += Number(entry?.count) || 0;
      prev.sum += Number(entry?.sum) || 0;
      prev.max = Math.max(prev.max, Number(entry?.max) || 0);
      map.set(key, prev);
    });

  return Array.from(map.values())
    .map((item) => ({ ...item, avgMs: item.count > 0 ? item.sum / item.count : 0 }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);
};

const aggregateErrorEndpoints = (snapshot) => {
  const map = new Map();
  (snapshot?.counters || [])
    .filter(
      (entry) =>
        entry?.name === 'http_responses_total' &&
        String(entry?.labels?.statusClass || '').toLowerCase() === '5xx'
    )
    .forEach((entry) => {
      const method = String(entry?.labels?.method || 'ALL');
      const pathValue = String(entry?.labels?.path || '/');
      const key = `${method} ${pathValue}`;
      const prev = map.get(key) || { key, method, path: pathValue, errors: 0 };
      prev.errors += Number(entry?.value) || 0;
      map.set(key, prev);
    });

  return Array.from(map.values())
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);
};

router.use(requireAdmin);
router.get(
  '/users/summary',
  asyncRoute(async (req, res) => {
    const users = await readUsersCached();
    const summary = {
      total: users.length,
      active: 0,
      blocked: 0,
      deleted: 0,
      online: 0,
      tokens: 0,
    };

    users.forEach((user) => {
      const status = normalizeUserStatus(user);
      if (status === 'active') summary.active += 1;
      if (status === 'blocked') summary.blocked += 1;
      if (status === 'deleted') summary.deleted += 1;
      if (user?.online === true) summary.online += 1;
      summary.tokens += resolveTokenCount(user);
    });

    res.json({
      success: true,
      data: {
        ...summary,
        usersCache: getUsersCacheInfo(),
      },
    });
  })
);

router.get(
  '/users',
  asyncRoute(async (req, res) => {
    const page = toPositiveInt(req.query?.page, 1, 1);
    const pageSize = toPositiveInt(req.query?.pageSize, 20, 1, MAX_PAGE_SIZE);
    const q = sanitizeText(req.query?.q, 120).toLowerCase();
    const statusFilter = sanitizeText(req.query?.status, 20).toLowerCase();

    const users = await readUsersCached();
    const list = users
      .map(toUserSummary)
      .filter((item) => {
        if (statusFilter && statusFilter !== 'all' && item.status !== statusFilter) {
          return false;
        }
        if (!q) return true;
        return (
          String(item.uid).includes(q) ||
          item.username.toLowerCase().includes(q) ||
          item.nickname.toLowerCase().includes(q) ||
          item.domain.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.uid - b.uid);

    const total = list.length;
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);

    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        usersCache: getUsersCacheInfo(),
      },
    });
  })
);

router.get(
  '/users/detail',
  asyncRoute(async (req, res) => {
    const uid = Number(req.query?.uid);
    if (!isValidUid(uid)) {
      res.status(400).json({ success: false, message: 'Invalid uid.' });
      return;
    }

    const users = await readUsersCached();
    const user = users.find((item) => item.uid === uid);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    res.json({ success: true, data: toUserDetail(user) });
  })
);

router.post(
  '/users/update',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const uid = Number(payload.uid);
    if (!isValidUid(uid)) {
      res.status(400).json({ success: false, message: 'Invalid uid.' });
      return;
    }

    if (hasOwn(payload, 'nickname')) {
      const nickname = sanitizeText(payload.nickname, MAX_NICKNAME_LEN + 1);
      if (nickname.length > MAX_NICKNAME_LEN) {
        res.status(400).json({ success: false, message: 'Nickname too long.' });
        return;
      }
    }

    if (hasOwn(payload, 'signature')) {
      const signature = sanitizeText(payload.signature, MAX_SIGNATURE_LEN + 1);
      if (signature.length > MAX_SIGNATURE_LEN) {
        res.status(400).json({ success: false, message: 'Signature too long.' });
        return;
      }
    }

    const mutation = await mutateUsers(
      (users) => {
        const index = users.findIndex((item) => item.uid === uid);
        if (index < 0) {
          return { changed: false, result: null };
        }

        const current = users[index];
        const next = { ...current };
        let changed = false;

        if (hasOwn(payload, 'nickname')) {
          const nickname = sanitizeText(payload.nickname, MAX_NICKNAME_LEN);
          const finalNickname = nickname || next.nickname || next.username;
          if (finalNickname !== next.nickname) {
            next.nickname = finalNickname;
            changed = true;
          }
        }

        if (hasOwn(payload, 'signature')) {
          const signature = sanitizeText(payload.signature, MAX_SIGNATURE_LEN) || DEFAULT_SIGNATURE;
          if (signature !== next.signature) {
            next.signature = signature;
            changed = true;
          }
        }

        if (hasOwn(payload, 'domain')) {
          const domain = sanitizeText(payload.domain, 253);
          if (domain !== String(next.domain || '')) {
            next.domain = domain;
            changed = true;
          }
        }

        ['gender', 'birthday', 'country', 'province', 'region'].forEach((field) => {
          if (!hasOwn(payload, field)) return;
          const value = sanitizeText(payload[field], 120);
          if (value !== String(next[field] || '')) {
            next[field] = value;
            changed = true;
          }
        });

        if (hasOwn(payload, 'status')) {
          const status = sanitizeText(payload.status, 20).toLowerCase();
          if (status === 'active') {
            if (next.blocked || (typeof next.deletedAt === 'string' && next.deletedAt)) {
              next.blocked = false;
              next.deletedAt = '';
              changed = true;
            }
          } else if (status === 'blocked') {
            if (next.blocked !== true) {
              next.blocked = true;
              changed = true;
            }
          } else if (status === 'deleted') {
            if (!next.deletedAt) {
              next.deletedAt = new Date().toISOString();
              changed = true;
            }
            if (next.blocked !== true) {
              next.blocked = true;
              changed = true;
            }
          }
        }

        if (hasOwn(payload, 'blocked')) {
          const blocked = Boolean(payload.blocked);
          if (blocked !== Boolean(next.blocked)) {
            next.blocked = blocked;
            changed = true;
          }
        }

        if (next.blocked === true || (typeof next.deletedAt === 'string' && next.deletedAt)) {
          const tokenCount = resolveTokenCount(next);
          if (tokenCount > 0) changed = true;
          if (next.online) changed = true;
          next.online = false;
          next.tokens = [];
          next.token = null;
          next.tokenExpiresAt = null;
        }

        if (!changed) {
          return { changed: false, result: toUserSummary(next) };
        }

        users[index] = next;
        return { changed: true, result: toUserSummary(next) };
      },
      { defaultChanged: false }
    );

    if (!mutation.result) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);

router.post(
  '/users/revoke-all',
  asyncRoute(async (req, res) => {
    const uid = Number(req.body?.uid);
    if (!isValidUid(uid)) {
      res.status(400).json({ success: false, message: 'Invalid uid.' });
      return;
    }

    const mutation = await mutateUsers(
      (users) => {
        const index = users.findIndex((item) => item.uid === uid);
        if (index < 0) return { changed: false, result: null };

        const user = users[index];
        const revokedCount = resolveTokenCount(user);
        if (revokedCount <= 0 && user.online !== true) {
          return {
            changed: false,
            result: { uid, revokedCount: 0, user: toUserSummary(user) },
          };
        }

        users[index] = {
          ...users[index],
          online: false,
          tokens: [],
          token: null,
          tokenExpiresAt: null,
        };

        return {
          changed: true,
          result: { uid, revokedCount, user: toUserSummary(users[index]) },
        };
      },
      { defaultChanged: false }
    );

    if (!mutation.result) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);

router.post(
  '/users/soft-delete',
  asyncRoute(async (req, res) => {
    const uid = Number(req.body?.uid);
    if (!isValidUid(uid)) {
      res.status(400).json({ success: false, message: 'Invalid uid.' });
      return;
    }

    const restore = Boolean(req.body?.restore);
    const mutation = await mutateUsers(
      (users) => {
        const index = users.findIndex((item) => item.uid === uid);
        if (index < 0) return { changed: false, result: null };

        const user = { ...users[index] };
        if (restore) {
          user.deletedAt = '';
          user.blocked = false;
        } else {
          user.deletedAt = new Date().toISOString();
          user.blocked = true;
          user.online = false;
          user.tokens = [];
          user.token = null;
          user.tokenExpiresAt = null;
        }

        users[index] = user;
        return { changed: true, result: toUserSummary(user) };
      },
      { defaultChanged: false }
    );

    if (!mutation.result) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);
router.get(
  '/products/summary',
  asyncRoute(async (req, res) => {
    const lowStockThreshold = toPositiveInt(req.query?.lowStockThreshold, 10, 1, 100000);
    const list = await readProductsCached();

    const summary = {
      total: list.length,
      active: 0,
      inactive: 0,
      draft: 0,
      archived: 0,
      lowStock: 0,
      totalStock: 0,
      totalSales: 0,
      inventoryValue: 0,
      grossRevenue: 0,
    };

    list.forEach((item) => {
      const status = normalizeProductStatus(item?.status, 'draft');
      if (status === 'active') summary.active += 1;
      if (status === 'inactive') summary.inactive += 1;
      if (status === 'draft') summary.draft += 1;
      if (status === 'archived') summary.archived += 1;

      const stock = Number(item?.stock);
      const sales = Number(item?.sales);
      const price = Number(item?.price);

      if (Number.isInteger(stock) && stock >= 0) {
        summary.totalStock += stock;
        if (stock <= lowStockThreshold) {
          summary.lowStock += 1;
        }
      }
      if (Number.isInteger(sales) && sales >= 0) {
        summary.totalSales += sales;
      }
      if (Number.isFinite(price) && price >= 0 && Number.isInteger(stock) && stock >= 0) {
        summary.inventoryValue += price * stock;
      }
      if (Number.isFinite(price) && price >= 0 && Number.isInteger(sales) && sales >= 0) {
        summary.grossRevenue += price * sales;
      }
    });

    res.json({
      success: true,
      data: {
        ...summary,
        lowStockThreshold,
        cache: buildProductsCacheInfo(),
      },
    });
  })
);

router.get(
  '/products',
  asyncRoute(async (req, res) => {
    const page = toPositiveInt(req.query?.page, 1, 1);
    const pageSize = toPositiveInt(req.query?.pageSize, 20, 1, MAX_PAGE_SIZE);
    const q = sanitizeText(req.query?.q, 120).toLowerCase();
    const statusFilter = sanitizeText(req.query?.status, 20).toLowerCase();

    const list = await readProductsCached();
    const filtered = list
      .filter((item) => {
        if (statusFilter && statusFilter !== 'all' && item.status !== statusFilter) {
          return false;
        }
        if (!q) return true;
        return (
          String(item.id).includes(q) ||
          item.name.toLowerCase().includes(q) ||
          item.sku.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        cache: buildProductsCacheInfo(),
      },
    });
  })
);

router.post(
  '/products/create',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const name = sanitizeText(payload.name, 120);
    if (!name) {
      res.status(400).json({ success: false, message: 'Product name is required.' });
      return;
    }

    const mutation = await mutateProducts(
      (products) => {
        if (products.length >= MAX_PRODUCTS) {
          return { changed: false, result: { error: 'Product limit reached.' } };
        }

        const nowIso = new Date().toISOString();
        const id = getNextProductId(products);
        const normalized = normalizeProductRecord(
          {
            ...payload,
            id,
            name,
            createdAt: nowIso,
            updatedAt: nowIso,
            sales: Number(payload.sales) || 0,
          },
          { fallbackId: id, nowIso }
        );

        if (!normalized) {
          return { changed: false, result: { error: 'Invalid product payload.' } };
        }

        products.unshift(normalized);
        return { changed: true, result: normalized };
      },
      { defaultChanged: false }
    );

    if (mutation.result?.error) {
      res.status(400).json({ success: false, message: mutation.result.error });
      return;
    }
    if (!mutation.result) {
      res.status(500).json({ success: false, message: 'Create product failed.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);

router.post(
  '/products/update',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: 'Invalid product id.' });
      return;
    }

    const mutation = await mutateProducts(
      (products) => {
        const index = products.findIndex((item) => item.id === id);
        if (index < 0) return { changed: false, result: null };

        const current = products[index];
        const next = { ...current };
        let changed = false;

        if (hasOwn(payload, 'name')) {
          const name = sanitizeText(payload.name, 120);
          if (!name) return { changed: false, result: { error: 'Product name is required.' } };
          if (name !== next.name) {
            next.name = name;
            changed = true;
          }
        }
        if (hasOwn(payload, 'sku')) {
          const sku = sanitizeText(payload.sku, 64);
          if (sku !== next.sku) {
            next.sku = sku;
            changed = true;
          }
        }
        if (hasOwn(payload, 'category')) {
          const category = sanitizeText(payload.category, 64);
          if (category !== next.category) {
            next.category = category;
            changed = true;
          }
        }
        if (hasOwn(payload, 'description')) {
          const description = sanitizeText(payload.description, 600);
          if (description !== next.description) {
            next.description = description;
            changed = true;
          }
        }
        if (hasOwn(payload, 'status')) {
          const status = normalizeProductStatus(payload.status, next.status || 'draft');
          if (status !== next.status) {
            next.status = status;
            changed = true;
          }
        }
        if (hasOwn(payload, 'tags')) {
          const tags = normalizeTags(payload.tags);
          if (JSON.stringify(tags) !== JSON.stringify(next.tags || [])) {
            next.tags = tags;
            changed = true;
          }
        }

        if (hasOwn(payload, 'price')) {
          const priceRaw = Number(payload.price);
          const price = Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0;
          if (price !== Number(next.price || 0)) {
            next.price = price;
            changed = true;
          }
        }
        if (hasOwn(payload, 'cost')) {
          const costRaw = Number(payload.cost);
          const cost = Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : 0;
          if (cost !== Number(next.cost || 0)) {
            next.cost = cost;
            changed = true;
          }
        }
        if (hasOwn(payload, 'stock')) {
          const stockRaw = Number(payload.stock);
          const stock = Number.isInteger(stockRaw) && stockRaw >= 0 ? stockRaw : 0;
          if (stock !== Number(next.stock || 0)) {
            next.stock = stock;
            changed = true;
          }
        }
        if (hasOwn(payload, 'sales')) {
          const salesRaw = Number(payload.sales);
          const sales = Number.isInteger(salesRaw) && salesRaw >= 0 ? salesRaw : 0;
          if (sales !== Number(next.sales || 0)) {
            next.sales = sales;
            changed = true;
          }
        }

        if (changed) {
          next.updatedAt = new Date().toISOString();
          products[index] = next;
        }

        return { changed, result: next };
      },
      { defaultChanged: false }
    );

    if (mutation.result?.error) {
      res.status(400).json({ success: false, message: mutation.result.error });
      return;
    }
    if (!mutation.result) {
      res.status(404).json({ success: false, message: 'Product not found.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);

router.delete(
  '/products/delete',
  asyncRoute(async (req, res) => {
    const id = Number(req.body?.id || req.query?.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: 'Invalid product id.' });
      return;
    }

    const mutation = await mutateProducts(
      (products) => {
        const index = products.findIndex((item) => item.id === id);
        if (index < 0) return { changed: false, result: null };
        const [removed] = products.splice(index, 1);
        return { changed: true, result: removed };
      },
      { defaultChanged: false }
    );

    if (!mutation.result) {
      res.status(404).json({ success: false, message: 'Product not found.' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  })
);

router.get(
  '/bottlenecks',
  asyncRoute(async (req, res) => {
    const snapshot = metrics.snapshot();
    const slowEndpoints = aggregateSlowEndpoints(snapshot);
    const errorEndpoints = aggregateErrorEndpoints(snapshot);
    const memory = process.memoryUsage();
    const heapUsageRatio =
      memory.heapTotal > 0 ? Number((memory.heapUsed / memory.heapTotal).toFixed(4)) : 0;

    const counterValue = (name) =>
      (snapshot.counters || [])
        .filter((entry) => entry?.name === name)
        .reduce((sum, entry) => sum + (Number(entry?.value) || 0), 0);

    const wsBackpressureDrops = counterValue('ws_backpressure_disconnect_total');
    const wsMessageErrors = counterValue('ws_message_error_total');

    const recommendations = [];
    if (slowEndpoints[0] && slowEndpoints[0].avgMs >= 350) {
      recommendations.push(
        `Slow endpoint hotspot: ${slowEndpoints[0].key} avg ${slowEndpoints[0].avgMs.toFixed(1)}ms`
      );
    }
    if (errorEndpoints[0] && errorEndpoints[0].errors > 0) {
      recommendations.push(
        `Error hotspot: ${errorEndpoints[0].key} with ${errorEndpoints[0].errors} 5xx responses`
      );
    }
    if (heapUsageRatio >= 0.8) {
      recommendations.push(
        `Heap usage is high (${(heapUsageRatio * 100).toFixed(1)}%), inspect allocations and cache TTL`
      );
    }
    if (wsBackpressureDrops > 0) {
      recommendations.push(
        `Detected ${wsBackpressureDrops} backpressure disconnects, consider message fanout and payload size limits`
      );
    }
    if (wsMessageErrors > 0) {
      recommendations.push(
        `Detected ${wsMessageErrors} websocket message handler errors, inspect malformed payload patterns`
      );
    }
    if (!recommendations.length) {
      recommendations.push('No obvious bottleneck in current window.');
    }

    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        slowEndpoints,
        errorEndpoints,
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          heapUsageRatio,
        },
        ws: {
          backpressureDisconnects: wsBackpressureDrops,
          messageErrors: wsMessageErrors,
        },
        recommendations,
      },
    });
  })
);

export default router;