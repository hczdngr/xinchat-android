/**
 * Summary center core service.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { isFeatureEnabled } from '../featureFlags.js';
import { metrics, logger, serializeError } from '../observability.js';
import { readUsersCached } from '../routes/auth.js';
import { readGroups } from '../routes/groups.js';
import { getChatDatabaseForOps } from '../routes/chat.js';
import { atomicWriteFile } from '../utils/filePersistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'summary-center.json');
const STORE_LOCK_PATH = path.join(DATA_DIR, 'summary-center.json.lock');

const HISTORY_LIMIT = 80;
const DEFAULT_HISTORY_PAGE = 20;
const AUTO_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(String(process.env.SUMMARY_AUTO_INTERVAL_MS || '3600000'), 10) || 3_600_000
);
const AUTO_MAX_USERS = Math.max(
  1,
  Number.parseInt(String(process.env.SUMMARY_AUTO_MAX_USERS || '150'), 10) || 150
);
const FULL_REBUILD_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(String(process.env.SUMMARY_FULL_REBUILD_INTERVAL_MS || '1800000'), 10) ||
    1_800_000
);
const TODO_DELAY_MS = Math.max(
  60_000,
  Number.parseInt(String(process.env.SUMMARY_TODO_DELAY_MS || '300000'), 10) || 300_000
);
const SLOW_QUERY_MS = Math.max(
  10,
  Number.parseInt(String(process.env.SUMMARY_SLOW_QUERY_MS || '120'), 10) || 120
);
const SLOW_USER_GENERATE_MS = Math.max(
  20,
  Number.parseInt(String(process.env.SUMMARY_SLOW_USER_GENERATE_MS || '420'), 10) || 420
);
const SLOW_BATCH_MS = Math.max(
  100,
  Number.parseInt(String(process.env.SUMMARY_SLOW_BATCH_MS || '2400'), 10) || 2400
);
const SLOW_EVENT_LIMIT = 80;

let storeLoaded = false;
let storeCache = { version: 1, updatedAt: '', users: {} };
let writeChain = Promise.resolve();
let notifier = null;
const conversationCache = new Map();

const runtime = {
  running: false,
  lastRunAtMs: 0,
  lastRunAt: '',
  lastDurationMs: 0,
  lastReason: '',
  lastError: '',
  lastSkippedReason: '',
  totalRuns: 0,
  totalGenerated: 0,
  totalErrors: 0,
  totalPushes: 0,
  totalPushErrors: 0,
  totalSlowQueries: 0,
  totalSlowUsers: 0,
  totalSlowBatches: 0,
  slowQueries: [],
  slowUsers: [],
  slowBatches: [],
};

const toInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const clean = (value, max = 200) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const uidList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );

const parseData = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const previewOf = (row) => {
  const type = String(row?.type || '').toLowerCase();
  const data = parseData(row?.data);
  const text = clean(data?.content || data?.text || '', 120);
  if (text) return text;
  if (type === 'image') return '[image]';
  if (type === 'voice') return '[voice]';
  if (type === 'file') return `[file] ${clean(data?.name || '', 80) || 'file'}`;
  if (type) return `[${type}]`;
  return '[message]';
};

const pushSlowEvent = (target, item) => {
  if (!Array.isArray(target)) return;
  target.unshift(item);
  if (target.length > SLOW_EVENT_LIMIT) {
    target.length = SLOW_EVENT_LIMIT;
  }
};

const queryRows = (database, sql, params = [], options = {}) => {
  const scope = clean(options?.scope || 'unknown', 48) || 'unknown';
  const uid = Number(options?.uid || 0);
  const startedAt = Date.now();
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  const tookMs = Math.max(0, Date.now() - startedAt);
  metrics.observeHistogram('summary_center_query_duration_ms', tookMs, { scope });
  metrics.observeHistogram('summary_center_query_rows_total', rows.length, { scope });
  if (tookMs >= SLOW_QUERY_MS) {
    runtime.totalSlowQueries += 1;
    metrics.incCounter('summary_center_slow_query_total', 1, { scope });
    const event = {
      scope,
      uid: Number.isInteger(uid) && uid > 0 ? uid : 0,
      rows: rows.length,
      tookMs,
      at: new Date().toISOString(),
    };
    pushSlowEvent(runtime.slowQueries, event);
    logger.warn('Summary query is slow', event);
  }
  return rows;
};

const ensureStore = async () => {
  if (storeLoaded) return storeCache;
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    storeCache = {
      version: 1,
      updatedAt: clean(parsed?.updatedAt, 64),
      users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
    };
  } catch {
    storeCache = { version: 1, updatedAt: '', users: {} };
  }
  storeLoaded = true;
  return storeCache;
};

const saveStore = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  storeCache.updatedAt = new Date().toISOString();
  await atomicWriteFile(STORE_PATH, JSON.stringify(storeCache, null, 2), {
    lockPath: STORE_LOCK_PATH,
  });
};

const mutateStore = async (mutator) => {
  await ensureStore();
  const result = mutator(storeCache);
  writeChain = writeChain.catch(() => undefined).then(() => saveStore());
  await writeChain;
  return result;
};

const ensureUserEntry = (uid) => {
  const key = String(uid);
  if (!storeCache.users[key] || typeof storeCache.users[key] !== 'object') {
    storeCache.users[key] = {
      latest: null,
      history: [],
      updatedAt: '',
      stats: { generatedTotal: 0, manualRefreshTotal: 0, archivedTotal: 0, lastError: '' },
    };
  }
  return storeCache.users[key];
};

const bucketOf = (ms) => {
  const hour = new Date(ms).getHours();
  if (hour < 5) return 'night';
  if (hour < 11) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'night';
};

const summarizeItems = (items, nowMs) => {
  const sorted = [...items].sort((a, b) => b.unread - a.unread || b.latestAtMs - a.latestAtMs);
  const highlights = sorted.slice(0, 5).map((item) => ({
    targetUid: item.targetUid,
    targetType: item.targetType,
    title: item.title,
    unread: item.unread,
    lastMessageAt: item.latestAt,
    lastMessagePreview: item.latestPreview,
    reason: item.unread > 0 ? `Unread ${item.unread} message(s).` : 'Recent activity.',
  }));
  const todos = sorted
    .filter((item) => {
      if (item.targetType === 'group') return item.unread > 0;
      return item.lastIncomingAtMs > Math.max(item.lastOutgoingAtMs, 0) && nowMs - item.lastIncomingAtMs >= TODO_DELAY_MS;
    })
    .slice(0, 8)
    .map((item) => ({
      targetUid: item.targetUid,
      targetType: item.targetType,
      title: item.title,
      action: item.targetType === 'group' ? 'check_group' : 'reply',
      reason:
        item.targetType === 'group'
          ? `Group has ${item.unread} unread message(s).`
          : 'Latest incoming message has not been replied yet.',
      lastIncomingAt: item.lastIncomingAt || item.latestAt,
      unread: item.unread,
    }));
  const unreadTotal = items.reduce((sum, item) => sum + item.unread, 0);
  const unreadConversations = items.filter((item) => item.unread > 0).length;
  const summaryText =
    unreadTotal <= 0 && todos.length === 0
      ? 'No unread pressure right now. Keep your conversations warm.'
      : `Unread ${unreadTotal} message(s) in ${unreadConversations} conversation(s). Pending reply actions: ${todos.length}.`;
  return { highlights, todos, unreadTotal, unreadConversations, summaryText };
};

const buildIdsSignature = (ids = []) =>
  (Array.isArray(ids) ? ids : [])
    .filter((item) => Number.isInteger(item) && item > 0)
    .sort((a, b) => a - b)
    .join(',');

const buildConversationItem = (targetType, targetUid, title = '') => ({
  targetType,
  targetUid,
  title: clean(title, 80),
  unread: 0,
  latestAtMs: 0,
  latestAt: '',
  latestPreview: '',
  lastIncomingAtMs: 0,
  lastIncomingAt: '',
  lastOutgoingAtMs: 0,
});

const applyConversationRow = ({ item, row, selfUid }) => {
  const senderUid = Number(row?.senderUid || 0);
  const createdAtMs = Number(row?.createdAtMs || 0);
  if (!item.latestAtMs || createdAtMs > item.latestAtMs) {
    item.latestAtMs = createdAtMs;
    item.latestAt = clean(row?.createdAt, 64);
    item.latestPreview = previewOf(row);
  }
  if (senderUid === selfUid) {
    if (createdAtMs > item.lastOutgoingAtMs) item.lastOutgoingAtMs = createdAtMs;
  } else {
    if (String(row?.type || '').toLowerCase() === 'text') item.unread += 1;
    if (createdAtMs > item.lastIncomingAtMs) {
      item.lastIncomingAtMs = createdAtMs;
      item.lastIncomingAt = clean(row?.createdAt, 64);
    }
  }
  return createdAtMs;
};

const buildConversationItems = ({ database, user, users, groups, nowMs = Date.now() }) => {
  const selfUid = Number(user?.uid || 0);
  const userMap = new Map();
  (Array.isArray(users) ? users : []).forEach((item) => {
    const uid = Number(item?.uid);
    if (Number.isInteger(uid) && uid > 0) userMap.set(uid, item);
  });
  const friendIds = uidList(user?.friends).filter((friendUid) => {
    const friend = userMap.get(friendUid);
    return Boolean(friend) && uidList(friend?.friends).includes(selfUid);
  });
  const joinedGroups = (Array.isArray(groups) ? groups : []).filter((group) => uidList(group?.memberUids).includes(selfUid));
  const groupMap = new Map();
  joinedGroups.forEach((group) => {
    const gid = Number(group?.id);
    if (Number.isInteger(gid) && gid > 0) groupMap.set(gid, group);
  });
  const friendSignature = buildIdsSignature(friendIds);
  const groupIds = Array.from(groupMap.keys()).sort((a, b) => a - b);
  const groupSignature = buildIdsSignature(groupIds);
  const cacheKey = String(selfUid);
  const previous = conversationCache.get(cacheKey);
  const canIncremental =
    Boolean(previous) &&
    previous.friendSignature === friendSignature &&
    previous.groupSignature === groupSignature &&
    Number(previous.lastScanAtMs || 0) > 0 &&
    nowMs - Number(previous.lastFullRebuildAtMs || 0) < FULL_REBUILD_INTERVAL_MS;
  const map = new Map(
    canIncremental
      ? (Array.isArray(previous.items) ? previous.items : []).map((item) => [
          `${item.targetType}:${item.targetUid}`,
          { ...item },
        ])
      : []
  );
  const ensure = (targetType, targetUid, fallbackTitle) => {
    const key = `${targetType}:${targetUid}`;
    if (!map.has(key)) {
      map.set(key, buildConversationItem(targetType, targetUid, fallbackTitle));
    }
    const item = map.get(key);
    if (!item.title && fallbackTitle) {
      item.title = clean(fallbackTitle, 80);
    }
    return item;
  };
  const mode = canIncremental ? 'incremental' : 'full';
  const queryLowerBoundMs = canIncremental ? Number(previous.lastScanAtMs || 0) : 0;
  let maxScannedAtMs = queryLowerBoundMs;
  let scannedRows = 0;

  if (friendIds.length > 0) {
    const placeholders = friendIds.map(() => '?').join(',');
    const lowerBoundSql = canIncremental ? ' AND createdAtMs > ?' : '';
    const rows = queryRows(
      database,
      `SELECT senderUid,targetUid,type,data,createdAt,createdAtMs
       FROM messages
       WHERE targetType='private'
         AND ((senderUid=? AND targetUid IN (${placeholders})) OR (targetUid=? AND senderUid IN (${placeholders})))
         ${lowerBoundSql}
       ORDER BY createdAtMs DESC`,
      canIncremental
        ? [selfUid, ...friendIds, selfUid, ...friendIds, queryLowerBoundMs]
        : [selfUid, ...friendIds, selfUid, ...friendIds],
      { scope: `private_${mode}`, uid: selfUid }
    );
    scannedRows += rows.length;
    rows.forEach((row) => {
      const senderUid = Number(row?.senderUid || 0);
      const targetUid = Number(row?.targetUid || 0);
      const peerUid = senderUid === selfUid ? targetUid : senderUid;
      const peer = userMap.get(peerUid);
      const item = ensure('private', peerUid, peer?.nickname || peer?.username || `User ${peerUid}`);
      const createdAtMs = applyConversationRow({ item, row, selfUid });
      if (createdAtMs > maxScannedAtMs) maxScannedAtMs = createdAtMs;
    });
  }

  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => '?').join(',');
    const lowerBoundSql = canIncremental ? ' AND createdAtMs > ?' : '';
    const rows = queryRows(
      database,
      `SELECT senderUid,targetUid,type,data,createdAt,createdAtMs
       FROM messages
       WHERE targetType='group'
         AND targetUid IN (${placeholders})
         ${lowerBoundSql}
       ORDER BY createdAtMs DESC`,
      canIncremental ? [...groupIds, queryLowerBoundMs] : groupIds,
      { scope: `group_${mode}`, uid: selfUid }
    );
    scannedRows += rows.length;
    rows.forEach((row) => {
      const groupUid = Number(row?.targetUid || 0);
      const group = groupMap.get(groupUid);
      const item = ensure('group', groupUid, group?.name || `Group ${groupUid}`);
      const createdAtMs = applyConversationRow({ item, row, selfUid });
      if (createdAtMs > maxScannedAtMs) maxScannedAtMs = createdAtMs;
    });
  }

  const items = Array.from(map.values());
  conversationCache.set(cacheKey, {
    friendSignature,
    groupSignature,
    lastScanAtMs: Math.max(queryLowerBoundMs, maxScannedAtMs, nowMs),
    lastFullRebuildAtMs: canIncremental ? Number(previous.lastFullRebuildAtMs || 0) : nowMs,
    updatedAtMs: nowMs,
    items,
  });
  return {
    items,
    mode,
    scannedRows,
    scannedSinceMs: queryLowerBoundMs,
  };
};

const pushWs = async (uid, payload) => {
  if (typeof notifier !== 'function') return;
  try {
    await notifier(uid, payload);
    runtime.totalPushes += 1;
    metrics.incCounter('summary_center_push_total', 1, { status: 'ok' });
  } catch (error) {
    runtime.totalPushErrors += 1;
    metrics.incCounter('summary_center_push_total', 1, { status: 'error' });
    logger.warn('Summary push failed', { uid, error: serializeError(error) });
  }
};

const responseOf = (enabled, entry, limit = DEFAULT_HISTORY_PAGE, available = true) => {
  const safe = entry && typeof entry === 'object' ? entry : { latest: null, history: [], stats: {} };
  const history = (Array.isArray(safe.history) ? safe.history : []).slice(0, toInt(limit, DEFAULT_HISTORY_PAGE, 1, 100));
  return {
    enabled,
    available,
    generatedAt: new Date().toISOString(),
    latest: safe.latest || null,
    history,
    badges: {
      hasLatest: Boolean(safe.latest),
      unreadHistory: history.filter((item) => !item.readAt).length,
      unreadTotal: Math.max(0, Number(safe?.latest?.unreadTotal || 0)),
    },
    stats: {
      generatedTotal: Math.max(0, Number(safe?.stats?.generatedTotal || 0)),
      manualRefreshTotal: Math.max(0, Number(safe?.stats?.manualRefreshTotal || 0)),
      archivedTotal: Math.max(0, Number(safe?.stats?.archivedTotal || 0)),
      lastError: clean(safe?.stats?.lastError || '', 200),
    },
  };
};

const generateSummaryForUser = async ({ uid, manual = false, reason = '', users = null, groups = null, database = null, push = true, nowMs = Date.now() }) => {
  const userUid = Number(uid);
  if (!Number.isInteger(userUid) || userUid <= 0) return responseOf(isFeatureEnabled('summaryCenter'), null, DEFAULT_HISTORY_PAGE, false);
  if (!isFeatureEnabled('summaryCenter')) return responseOf(false, null);
  const startedAt = Date.now();
  const source = manual ? 'manual' : 'auto';

  try {
    const [safeUsers, safeGroups, safeDb] = await Promise.all([
      Array.isArray(users) ? users : readUsersCached(),
      Array.isArray(groups) ? groups : readGroups(),
      database || getChatDatabaseForOps(),
    ]);
    const user = (safeUsers || []).find((item) => Number(item?.uid) === userUid);
    if (!user) return responseOf(true, null, DEFAULT_HISTORY_PAGE, false);

    const conversation = buildConversationItems({
      database: safeDb,
      user,
      users: safeUsers,
      groups: safeGroups,
      nowMs,
    });
    const items = Array.isArray(conversation?.items) ? conversation.items : [];
    const summary = summarizeItems(items, nowMs);
    const latest = {
      id: `${userUid}-${nowMs}-${crypto.randomBytes(4).toString('hex')}`,
      userUid,
      generatedAt: new Date(nowMs).toISOString(),
      timeBucket: bucketOf(nowMs),
      source,
      reason: clean(reason, 80) || (manual ? 'manual_refresh' : 'auto_tick'),
      unreadTotal: summary.unreadTotal,
      unreadConversations: summary.unreadConversations,
      totalConversations: items.length,
      summaryText: clean(summary.summaryText, 240),
      buildMode: clean(conversation?.mode || 'full', 16),
      scannedRows: Math.max(0, Number(conversation?.scannedRows || 0)),
      highlights: summary.highlights,
      todos: summary.todos,
      readAt: '',
      archivedAt: '',
    };

    const entry = await mutateStore((store) => {
      const target = ensureUserEntry(userUid);
      if (target.latest && target.latest.id) {
        target.history = [{ ...target.latest, archivedAt: target.latest.archivedAt || new Date(nowMs).toISOString() }, ...(Array.isArray(target.history) ? target.history : [])].slice(0, HISTORY_LIMIT);
      }
      target.latest = latest;
      target.updatedAt = new Date(nowMs).toISOString();
      target.stats.generatedTotal = Math.max(0, Number(target?.stats?.generatedTotal || 0)) + 1;
      if (manual) target.stats.manualRefreshTotal = Math.max(0, Number(target?.stats?.manualRefreshTotal || 0)) + 1;
      target.stats.lastError = '';
      return target;
    });

    const tookMs = Math.max(0, Date.now() - startedAt);
    metrics.incCounter('summary_center_generate_total', 1, {
      source,
      mode: clean(conversation?.mode || 'full', 16),
    });
    metrics.observeHistogram('summary_center_user_generate_duration_ms', tookMs, {
      source,
      mode: clean(conversation?.mode || 'full', 16),
    });
    if (tookMs >= SLOW_USER_GENERATE_MS) {
      runtime.totalSlowUsers += 1;
      metrics.incCounter('summary_center_slow_user_total', 1, { source });
      const event = {
        uid: userUid,
        source,
        mode: clean(conversation?.mode || 'full', 16),
        scannedRows: Math.max(0, Number(conversation?.scannedRows || 0)),
        tookMs,
        at: new Date().toISOString(),
      };
      pushSlowEvent(runtime.slowUsers, event);
      logger.warn('Summary generation is slow', event);
    }
    if (push) {
      await pushWs(userUid, { type: 'summary_center', data: { latest, source: latest.source, generatedAt: latest.generatedAt } });
    }
    return responseOf(true, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateStore(() => {
      const target = ensureUserEntry(userUid);
      target.stats.lastError = clean(message, 200);
      target.updatedAt = new Date().toISOString();
      return target;
    }).catch(() => undefined);
    logger.warn('Summary generation failed', { uid: userUid, error: serializeError(error) });
    metrics.incCounter('summary_center_generate_total', 1, {
      source: manual ? 'manual_error' : 'auto_error',
    });
    return responseOf(true, null, DEFAULT_HISTORY_PAGE, false);
  }
};

const getSummaryCenterForUser = async ({ uid, limit = DEFAULT_HISTORY_PAGE, ensureLatest = false }) => {
  const userUid = Number(uid);
  if (!Number.isInteger(userUid) || userUid <= 0) return responseOf(isFeatureEnabled('summaryCenter'), null, limit, false);
  if (!isFeatureEnabled('summaryCenter')) return responseOf(false, null, limit, true);
  await ensureStore();
  const entry = storeCache.users[String(userUid)] || null;
  if (ensureLatest && !entry?.latest) {
    return generateSummaryForUser({ uid: userUid, manual: false, reason: 'lazy_init', push: false });
  }
  return responseOf(true, entry, limit, true);
};

const archiveSummaryForUser = async ({ uid, summaryId = '' }) => {
  const userUid = Number(uid);
  const safeId = clean(summaryId, 80);
  if (!Number.isInteger(userUid) || userUid <= 0) {
    return { success: false, message: 'Invalid uid.', state: responseOf(isFeatureEnabled('summaryCenter'), null, DEFAULT_HISTORY_PAGE, false) };
  }
  if (!isFeatureEnabled('summaryCenter')) {
    return { success: true, message: 'summary center is disabled.', state: responseOf(false, null) };
  }
  const nowIso = new Date().toISOString();
  let archived = null;
  const entry = await mutateStore(() => {
    const target = ensureUserEntry(userUid);
    if (target.latest && (!safeId || target.latest.id === safeId)) {
      archived = { ...target.latest, readAt: target.latest.readAt || nowIso, archivedAt: target.latest.archivedAt || nowIso };
      target.history = [archived, ...(Array.isArray(target.history) ? target.history : [])].slice(0, HISTORY_LIMIT);
      target.latest = null;
      target.stats.archivedTotal = Math.max(0, Number(target?.stats?.archivedTotal || 0)) + 1;
      target.updatedAt = nowIso;
      return target;
    }
    if (Array.isArray(target.history)) {
      target.history = target.history.map((item) => {
        if (safeId && item?.id !== safeId) return item;
        if (item?.readAt) return item;
        archived = { ...item, readAt: nowIso };
        return archived;
      });
      if (archived) {
        target.stats.archivedTotal = Math.max(0, Number(target?.stats?.archivedTotal || 0)) + 1;
        target.updatedAt = nowIso;
      }
    }
    return target;
  });
  if (!archived) return { success: false, message: 'Summary not found.', state: responseOf(true, entry) };
  metrics.incCounter('summary_center_archive_total', 1);
  return { success: true, message: 'Archived.', archived, state: responseOf(true, entry) };
};

const runSummaryAutoTick = async ({ reason = 'insight_tick', force = false, nowMs = Date.now() } = {}) => {
  if (!isFeatureEnabled('summaryCenter')) {
    runtime.lastSkippedReason = 'feature_disabled';
    return { skipped: true, reason: 'feature_disabled' };
  }
  if (runtime.running) {
    runtime.lastSkippedReason = 'running';
    return { skipped: true, reason: 'running' };
  }
  if (!force && runtime.lastRunAtMs > 0 && nowMs - runtime.lastRunAtMs < AUTO_INTERVAL_MS) {
    runtime.lastSkippedReason = 'cooldown';
    return { skipped: true, reason: 'cooldown' };
  }

  runtime.running = true;
  const startedAt = Date.now();
  try {
    const [users, groups, database] = await Promise.all([readUsersCached(), readGroups(), getChatDatabaseForOps()]);
    const candidates = (Array.isArray(users) ? users : [])
      .filter((user) => {
        const uid = Number(user?.uid);
        if (!Number.isInteger(uid) || uid <= 0) return false;
        return user?.online === true || uidList(user?.friends).length > 0;
      })
      .slice(0, AUTO_MAX_USERS);

    let generated = 0;
    for (const user of candidates) {
      const uid = Number(user?.uid);
      if (!Number.isInteger(uid) || uid <= 0) continue;
      const result = await generateSummaryForUser({ uid, manual: false, reason, users, groups, database, push: true, nowMs: Date.now() });
      if (result?.available) generated += 1;
    }

    runtime.totalRuns += 1;
    runtime.totalGenerated += generated;
    runtime.lastRunAtMs = Date.now();
    runtime.lastRunAt = new Date(runtime.lastRunAtMs).toISOString();
    runtime.lastDurationMs = Date.now() - startedAt;
    runtime.lastReason = clean(reason, 80);
    runtime.lastError = '';
    runtime.lastSkippedReason = '';
    metrics.incCounter('summary_center_auto_tick_total', 1, { status: 'ok' });
    metrics.observeHistogram('summary_center_batch_duration_ms', runtime.lastDurationMs, {
      reason: clean(reason, 80) || 'insight_tick',
      status: 'ok',
    });
    metrics.observeHistogram('summary_center_batch_users_total', generated, {
      reason: clean(reason, 80) || 'insight_tick',
      status: 'ok',
    });
    if (runtime.lastDurationMs >= SLOW_BATCH_MS) {
      runtime.totalSlowBatches += 1;
      metrics.incCounter('summary_center_slow_batch_total', 1, { reason: clean(reason, 80) || 'insight_tick' });
      const event = {
        reason: clean(reason, 80) || 'insight_tick',
        tookMs: runtime.lastDurationMs,
        generated,
        candidates: candidates.length,
        at: runtime.lastRunAt,
      };
      pushSlowEvent(runtime.slowBatches, event);
      logger.warn('Summary auto tick is slow', event);
    }
    return { skipped: false, generated, candidates: candidates.length, tookMs: runtime.lastDurationMs };
  } catch (error) {
    runtime.totalErrors += 1;
    runtime.lastError = error instanceof Error ? error.message : String(error);
    metrics.incCounter('summary_center_auto_tick_total', 1, { status: 'error' });
    metrics.observeHistogram('summary_center_batch_duration_ms', Math.max(0, Date.now() - startedAt), {
      reason: clean(reason, 80) || 'insight_tick',
      status: 'error',
    });
    logger.warn('Summary auto tick failed', { reason, error: serializeError(error) });
    return { skipped: false, generated: 0, error: runtime.lastError };
  } finally {
    runtime.running = false;
  }
};

const buildOverviewInlineSummary = (overviewItems = [], limit = 3) => {
  const list = (Array.isArray(overviewItems) ? overviewItems : [])
    .map((item) => ({
      targetUid: Number(item?.uid || 0),
      targetType: item?.targetType === 'group' ? 'group' : 'private',
      unread: Math.max(0, Number(item?.unread || 0)),
      preview: clean(item?.latest?.data?.content || item?.latest?.data?.text || '', 80),
      createdAtMs: Number(item?.latest?.createdAtMs || 0),
    }))
    .filter((item) => Number.isInteger(item.targetUid) && item.targetUid > 0);
  const unreadTotal = list.reduce((sum, item) => sum + item.unread, 0);
  const unreadConversations = list.filter((item) => item.unread > 0).length;
  const highlights = list
    .sort((a, b) => b.unread - a.unread || b.createdAtMs - a.createdAtMs)
    .slice(0, toInt(limit, 3, 1, 10));
  return {
    unreadTotal,
    unreadConversations,
    highlights,
    summaryText: `Unread ${unreadTotal} message(s) in ${unreadConversations} conversation(s).`,
  };
};

const getSummaryAdminOverview = async ({ limit = 20 } = {}) => {
  await ensureStore();
  const users = storeCache?.users && typeof storeCache.users === 'object' ? storeCache.users : {};
  let usersWithLatest = 0;
  let unreadLatest = 0;
  let historyRecords = 0;
  const topUsers = Object.entries(users)
    .map(([uidKey, entry]) => {
      const uid = Number(uidKey);
      if (!Number.isInteger(uid) || uid <= 0) return null;
      const latest = entry?.latest || null;
      const history = Array.isArray(entry?.history) ? entry.history : [];
      if (latest) {
        usersWithLatest += 1;
        unreadLatest += Math.max(0, Number(latest?.unreadTotal || 0));
      }
      historyRecords += history.length;
      return {
        uid,
        unreadTotal: Math.max(0, Number(latest?.unreadTotal || 0)),
        unreadConversations: Math.max(0, Number(latest?.unreadConversations || 0)),
        todoCount: Array.isArray(latest?.todos) ? latest.todos.length : 0,
        latestGeneratedAt: clean(latest?.generatedAt, 64),
        generatedTotal: Math.max(0, Number(entry?.stats?.generatedTotal || 0)),
        manualRefreshTotal: Math.max(0, Number(entry?.stats?.manualRefreshTotal || 0)),
        archivedTotal: Math.max(0, Number(entry?.stats?.archivedTotal || 0)),
        lastError: clean(entry?.stats?.lastError, 200),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.unreadTotal - a.unreadTotal || b.todoCount - a.todoCount)
    .slice(0, toInt(limit, 20, 1, 100));

  return {
    generatedAt: new Date().toISOString(),
    featureEnabled: isFeatureEnabled('summaryCenter'),
    totals: {
      users: Object.keys(users).length,
      usersWithLatest,
      unreadLatest,
      historyRecords,
    },
    runtime: {
      ...runtime,
      autoIntervalMs: AUTO_INTERVAL_MS,
      autoMaxUsers: AUTO_MAX_USERS,
      fullRebuildIntervalMs: FULL_REBUILD_INTERVAL_MS,
      slowThresholds: {
        queryMs: SLOW_QUERY_MS,
        userGenerateMs: SLOW_USER_GENERATE_MS,
        batchMs: SLOW_BATCH_MS,
      },
      storeLoaded,
      cachedUsers: conversationCache.size,
    },
    topUsers,
  };
};

const setSummaryNotifier = (fn) => {
  notifier = typeof fn === 'function' ? fn : null;
};

const getSummaryRuntimeStats = () => ({
  ...runtime,
  autoIntervalMs: AUTO_INTERVAL_MS,
  autoMaxUsers: AUTO_MAX_USERS,
  fullRebuildIntervalMs: FULL_REBUILD_INTERVAL_MS,
  slowThresholds: {
    queryMs: SLOW_QUERY_MS,
    userGenerateMs: SLOW_USER_GENERATE_MS,
    batchMs: SLOW_BATCH_MS,
  },
  storeLoaded,
  cachedUsers: conversationCache.size,
  storeUsers: Object.keys(storeCache?.users || {}).length,
});

const resetSummaryRuntimeForTests = async () => {
  runtime.running = false;
  runtime.lastRunAtMs = 0;
  runtime.lastRunAt = '';
  runtime.lastDurationMs = 0;
  runtime.lastReason = '';
  runtime.lastError = '';
  runtime.lastSkippedReason = '';
  runtime.totalRuns = 0;
  runtime.totalGenerated = 0;
  runtime.totalErrors = 0;
  runtime.totalPushes = 0;
  runtime.totalPushErrors = 0;
  runtime.totalSlowQueries = 0;
  runtime.totalSlowUsers = 0;
  runtime.totalSlowBatches = 0;
  runtime.slowQueries = [];
  runtime.slowUsers = [];
  runtime.slowBatches = [];
  notifier = null;
  storeLoaded = false;
  storeCache = { version: 1, updatedAt: '', users: {} };
  conversationCache.clear();
  writeChain = Promise.resolve();
  try {
    await fs.unlink(STORE_PATH);
  } catch {}
  try {
    await fs.unlink(STORE_PATH_TMP);
  } catch {}
};

export {
  archiveSummaryForUser,
  buildOverviewInlineSummary,
  generateSummaryForUser,
  getSummaryAdminOverview,
  getSummaryCenterForUser,
  getSummaryRuntimeStats,
  resetSummaryRuntimeForTests,
  runSummaryAutoTick,
  setSummaryNotifier,
};
