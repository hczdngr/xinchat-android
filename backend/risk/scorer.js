/**
 * Risk scoring service.
 * - chat/send text risk scoring
 * - friends/add behavior scoring
 * - chat conversation risk profile for top warning bubble
 */

import { inspectTextRules, riskLevelFromScore, sanitizeText } from './rules.js';
import {
  appendFriendAddAttempt,
  appendRiskDecision,
  getRiskDecisionWatermark,
  getRiskIgnore,
  listFriendAddAttemptsByActor,
  listRiskDecisions,
} from './stateStore.js';

const DEFAULT_CHAT_WINDOW_MS =
  Number.parseInt(String(process.env.RISK_CHAT_WINDOW_MS || String(10 * 60 * 1000)), 10) ||
  10 * 60 * 1000;
const DEFAULT_CHAT_PROFILE_WINDOW_MS =
  Number.parseInt(String(process.env.RISK_CHAT_PROFILE_WINDOW_MS || String(7 * 24 * 60 * 60 * 1000)), 10) ||
  7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_HISTORY_LIMIT =
  Number.parseInt(String(process.env.RISK_CHAT_HISTORY_LIMIT || '80'), 10) || 80;
const DEFAULT_FRIEND_WINDOW_MS =
  Number.parseInt(String(process.env.RISK_FRIEND_WINDOW_MS || String(60 * 60 * 1000)), 10) ||
  60 * 60 * 1000;
const DEFAULT_FRIEND_SHORT_WINDOW_MS =
  Number.parseInt(String(process.env.RISK_FRIEND_SHORT_WINDOW_MS || String(10 * 60 * 1000)), 10) ||
  10 * 60 * 1000;

const FLOOD_WARN_THRESHOLD =
  Number.parseInt(String(process.env.RISK_FLOOD_WARN_THRESHOLD || '6'), 10) || 6;
const FLOOD_HIGH_THRESHOLD =
  Number.parseInt(String(process.env.RISK_FLOOD_HIGH_THRESHOLD || '10'), 10) || 10;

const FRIEND_WARN_THRESHOLD =
  Number.parseInt(String(process.env.RISK_FRIEND_WARN_THRESHOLD || '5'), 10) || 5;
const FRIEND_HIGH_THRESHOLD =
  Number.parseInt(String(process.env.RISK_FRIEND_HIGH_THRESHOLD || '9'), 10) || 9;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const RISK_PROFILE_CACHE_ENABLED =
  String(process.env.RISK_PROFILE_CACHE_ENABLED || 'true').trim().toLowerCase() !== 'false';
const RISK_PROFILE_ASYNC_QUEUE_ENABLED =
  String(process.env.RISK_PROFILE_ASYNC_QUEUE_ENABLED || 'true').trim().toLowerCase() !== 'false';
const RISK_PROFILE_CACHE_TTL_MS = toPositiveInt(
  process.env.RISK_PROFILE_CACHE_TTL_MS,
  15_000,
  500,
  10 * 60 * 1000
);
const RISK_PROFILE_CACHE_STALE_TTL_MS = toPositiveInt(
  process.env.RISK_PROFILE_CACHE_STALE_TTL_MS,
  120_000,
  RISK_PROFILE_CACHE_TTL_MS,
  30 * 60 * 1000
);
const RISK_PROFILE_CACHE_MAX = toPositiveInt(process.env.RISK_PROFILE_CACHE_MAX, 4000, 100, 100000);
const RISK_PROFILE_QUEUE_MAX = toPositiveInt(process.env.RISK_PROFILE_QUEUE_MAX, 600, 20, 20000);
const RISK_PROFILE_QUEUE_CONCURRENCY = toPositiveInt(
  process.env.RISK_PROFILE_QUEUE_CONCURRENCY,
  2,
  1,
  16
);
const RISK_PROFILE_QUEUE_WAIT_MS = toPositiveInt(
  process.env.RISK_PROFILE_QUEUE_WAIT_MS,
  900,
  60,
  60_000
);
const RISK_PROFILE_STALE_WAIT_MS = toPositiveInt(
  process.env.RISK_PROFILE_STALE_WAIT_MS,
  140,
  20,
  5000
);
const RISK_PROFILE_COMPUTE_TIMEOUT_MS = toPositiveInt(
  process.env.RISK_PROFILE_COMPUTE_TIMEOUT_MS,
  1800,
  80,
  20_000
);

const toUid = (value) => {
  const uid = Number(value);
  return Number.isInteger(uid) && uid > 0 ? uid : 0;
};

const normalizeTargetType = (value) => (String(value || '').trim() === 'group' ? 'group' : 'private');

const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`risk_profile_timeout_${timeoutMs}ms`));
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

const profileRuntime = {
  cache: new Map(),
  queue: [],
  inFlight: new Map(),
  workers: 0,
  stats: {
    cacheHitFresh: 0,
    cacheHitStale: 0,
    cacheMiss: 0,
    cacheBypass: 0,
    queueEnqueued: 0,
    queueDropped: 0,
    queueProcessed: 0,
    queueErrors: 0,
    syncFallback: 0,
    lastQueueError: '',
    lastQueueErrorAt: '',
  },
};

const updateQueueError = (error) => {
  profileRuntime.stats.queueErrors += 1;
  profileRuntime.stats.lastQueueError = String(error?.message || error || '').slice(0, 240);
  profileRuntime.stats.lastQueueErrorAt = new Date().toISOString();
};

const profileCacheKey = ({ viewerUid, targetUid, targetType, windowMs }) =>
  `${toUid(viewerUid)}:${normalizeTargetType(targetType)}:${toUid(targetUid)}:${Math.max(0, Number(windowMs) || 0)}`;

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pruneProfileCache = () => {
  if (profileRuntime.cache.size <= RISK_PROFILE_CACHE_MAX) return;
  const entries = Array.from(profileRuntime.cache.entries());
  entries.sort((a, b) => safeNumber(a[1]?.lastAccessAtMs) - safeNumber(b[1]?.lastAccessAtMs));
  const toRemove = Math.max(0, profileRuntime.cache.size - RISK_PROFILE_CACHE_MAX);
  for (let index = 0; index < toRemove; index += 1) {
    profileRuntime.cache.delete(entries[index][0]);
  }
};

const pickCacheEntry = (cacheKey) => {
  const entry = profileRuntime.cache.get(cacheKey);
  if (!entry) return null;
  entry.lastAccessAtMs = Date.now();
  profileRuntime.cache.set(cacheKey, entry);
  return entry;
};

const upsertCacheEntry = ({ cacheKey, versionToken, profile }) => {
  const nowMs = Date.now();
  const cacheEntry = {
    cacheKey,
    versionToken,
    profile,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + RISK_PROFILE_CACHE_TTL_MS,
    staleUntilMs: nowMs + Math.max(RISK_PROFILE_CACHE_TTL_MS, RISK_PROFILE_CACHE_STALE_TTL_MS),
    lastAccessAtMs: nowMs,
  };
  profileRuntime.cache.set(cacheKey, cacheEntry);
  pruneProfileCache();
  return cacheEntry;
};

const decorateProfileWithRuntime = (profile, runtime = {}) => ({
  ...(profile && typeof profile === 'object' ? profile : {}),
  cache: {
    enabled: RISK_PROFILE_CACHE_ENABLED,
    asyncQueueEnabled: RISK_PROFILE_ASYNC_QUEUE_ENABLED,
    mode: String(runtime.mode || 'none'),
    cacheKey: String(runtime.cacheKey || ''),
    versionToken: String(runtime.versionToken || ''),
    queueDepth: profileRuntime.queue.length,
    queued: runtime.queued === true,
    waitedMs: safeNumber(runtime.waitedMs, 0),
  },
});

const toRiskResponse = ({
  score = 0,
  tags = [],
  evidence = [],
  summary = '',
  source = '',
  available = true,
  ignored = false,
  ignoredEntry = null,
} = {}) => {
  const safeScore = Math.min(100, Math.max(0, Number(score) || 0));
  const safeTags = Array.from(new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || '').trim()).filter(Boolean))).slice(0, 12);
  const safeEvidence = (Array.isArray(evidence) ? evidence : [])
    .map((item) => {
      const rule = sanitizeText(String(item?.rule || ''), 48);
      const type = sanitizeText(String(item?.type || ''), 24);
      const description = sanitizeText(String(item?.description || ''), 240);
      const snippet = sanitizeText(String(item?.snippet || ''), 240);
      if (!rule && !description) return null;
      return {
        rule: rule || 'unknown',
        type: type || 'rule',
        description,
        snippet,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
  const safeSummary =
    sanitizeText(summary, 280) ||
    safeEvidence[0]?.description ||
    (safeTags.length ? `Risk tags: ${safeTags.join(', ')}` : 'No high-risk signal.');
  return {
    available: available !== false,
    source: sanitizeText(String(source || ''), 40).toLowerCase() || 'unknown',
    score: safeScore,
    level: riskLevelFromScore(safeScore),
    tags: safeTags,
    evidence: safeEvidence,
    summary: safeSummary,
    ignored: ignored === true,
    ignoredEntry: ignoredEntry && typeof ignoredEntry === 'object' ? ignoredEntry : null,
    generatedAt: new Date().toISOString(),
  };
};

const parseMessageText = (rawData) => {
  if (!rawData) return '';
  if (typeof rawData === 'string') {
    try {
      const parsed = JSON.parse(rawData);
      return parseMessageText(parsed);
    } catch {
      return '';
    }
  }
  if (typeof rawData !== 'object') return '';
  const content = sanitizeText(String(rawData.content || rawData.text || rawData.caption || ''), 1200);
  return content;
};

const queryTextMessages = (database, sql, params = []) => {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
};

const computeFloodEvidence = ({
  rows = [],
  currentText = '',
  senderUid = 0,
  targetUid = 0,
  targetType = 'private',
} = {}) => {
  const texts = rows
    .map((row) => parseMessageText(row?.data))
    .filter(Boolean);
  const uniqueTexts = new Set(texts.map((entry) => entry.toLowerCase()));
  const normalizedCurrent = sanitizeText(currentText, 1200).toLowerCase();
  const duplicateCount = normalizedCurrent
    ? texts.filter((entry) => entry.toLowerCase() === normalizedCurrent).length
    : 0;

  const evidence = [];
  let score = 0;
  if (texts.length >= FLOOD_HIGH_THRESHOLD) {
    score += 36;
    evidence.push({
      rule: 'flooding',
      type: 'frequency',
      description: `High frequency sending in short window (${texts.length} messages).`,
      snippet: `${senderUid} -> ${targetType}:${targetUid}`,
    });
  } else if (texts.length >= FLOOD_WARN_THRESHOLD) {
    score += 20;
    evidence.push({
      rule: 'flooding',
      type: 'frequency',
      description: `Frequent sending behavior (${texts.length} messages).`,
      snippet: `${senderUid} -> ${targetType}:${targetUid}`,
    });
  }
  if (duplicateCount >= 4) {
    score += 28;
    evidence.push({
      rule: 'duplicate_spam',
      type: 'repeat',
      description: `Repeated same message ${duplicateCount} times.`,
      snippet: sanitizeText(currentText, 120),
    });
  } else if (duplicateCount >= 2) {
    score += 14;
    evidence.push({
      rule: 'duplicate_spam',
      type: 'repeat',
      description: `Repeated same message ${duplicateCount} times.`,
      snippet: sanitizeText(currentText, 120),
    });
  }
  if (texts.length >= 5 && uniqueTexts.size <= 2) {
    score += 12;
    evidence.push({
      rule: 'low_variance_spam',
      type: 'repeat',
      description: 'Low variance content in message burst.',
      snippet: `unique=${uniqueTexts.size}, total=${texts.length}`,
    });
  }
  return { score, evidence };
};

const summarizeReasons = (evidence = [], fallback = 'No high-risk signal.') => {
  const parts = (Array.isArray(evidence) ? evidence : [])
    .map((item) => sanitizeText(String(item?.description || ''), 120))
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return fallback;
  return parts.join(' ');
};

const assessOutgoingTextRisk = async ({
  database,
  senderUid,
  targetUid,
  targetType = 'private',
  text = '',
  nowMs = Date.now(),
} = {}) => {
  const safeSenderUid = toUid(senderUid);
  const safeTargetUid = toUid(targetUid);
  if (!database || !safeSenderUid || !safeTargetUid) {
    return toRiskResponse({
      source: 'chat_send',
      available: false,
      score: 0,
      summary: 'Risk scorer unavailable.',
    });
  }
  const safeTargetType = normalizeTargetType(targetType);
  const safeText = sanitizeText(text, 1200);
  if (!safeText) {
    return toRiskResponse({ source: 'chat_send', score: 0, summary: 'Empty text payload.' });
  }

  const windowMs = Math.max(1_000, DEFAULT_CHAT_WINDOW_MS);
  const sinceMs = Math.max(0, Number(nowMs) - windowMs);
  const rows = queryTextMessages(
    database,
    `
      SELECT data, createdAtMs
      FROM messages
      WHERE targetType = ?
        AND senderUid = ?
        AND targetUid = ?
        AND type = 'text'
        AND createdAtMs >= ?
      ORDER BY createdAtMs DESC
      LIMIT ?
    `,
    [safeTargetType, safeSenderUid, safeTargetUid, sinceMs, DEFAULT_CHAT_HISTORY_LIMIT]
  );

  let score = 0;
  const tags = new Set();
  const evidence = [];

  const textRuleResult = inspectTextRules(safeText);
  textRuleResult.tags.forEach((tag) => tags.add(tag));
  textRuleResult.evidence.forEach((item) => evidence.push(item));

  if (textRuleResult.tags.includes('malicious_link')) {
    score += 62;
  }
  if (textRuleResult.tags.includes('ads_spam')) {
    score += 28;
  }

  const flood = computeFloodEvidence({
    rows,
    currentText: safeText,
    senderUid: safeSenderUid,
    targetUid: safeTargetUid,
    targetType: safeTargetType,
  });
  score += flood.score;
  flood.evidence.forEach((item) => evidence.push(item));
  if (flood.evidence.length) {
    tags.add('flooding');
  }

  score = Math.min(100, Math.max(0, score));
  return toRiskResponse({
    source: 'chat_send',
    score,
    tags: Array.from(tags),
    evidence,
    summary: summarizeReasons(evidence),
  });
};

const assessFriendAddRisk = async ({
  actorUid,
  targetUid,
  actorUser = null,
  nowMs = Date.now(),
} = {}) => {
  const safeActorUid = toUid(actorUid);
  if (!safeActorUid) {
    return toRiskResponse({
      source: 'friends_add',
      available: false,
      summary: 'Invalid actor uid.',
    });
  }
  const safeTargetUid = toUid(targetUid);
  const hourWindowMs = Math.max(60_000, DEFAULT_FRIEND_WINDOW_MS);
  const shortWindowMs = Math.max(60_000, DEFAULT_FRIEND_SHORT_WINDOW_MS);
  const [attemptsHour, attemptsShort] = await Promise.all([
    listFriendAddAttemptsByActor({ actorUid: safeActorUid, windowMs: hourWindowMs }),
    listFriendAddAttemptsByActor({ actorUid: safeActorUid, windowMs: shortWindowMs }),
  ]);
  const uniqueTargetsHour = new Set(
    attemptsHour
      .map((item) => Number(item?.targetUid))
      .filter((uid) => Number.isInteger(uid) && uid > 0)
  );
  const duplicateTargetShort = safeTargetUid
    ? attemptsShort.filter((item) => Number(item?.targetUid) === safeTargetUid).length
    : 0;
  const outgoingPendingCount = Array.isArray(actorUser?.friendRequests?.outgoing)
    ? actorUser.friendRequests.outgoing.filter((entry) => String(entry?.status || 'pending') === 'pending').length
    : 0;

  let score = 0;
  const tags = new Set();
  const evidence = [];

  if (attemptsShort.length >= FRIEND_HIGH_THRESHOLD) {
    score += 78;
    tags.add('abnormal_add_friend');
    evidence.push({
      rule: 'friend_add_burst',
      type: 'frequency',
      description: `High friend add frequency in short window (${attemptsShort.length} requests/10m).`,
      snippet: `actor=${safeActorUid}`,
    });
  } else if (attemptsShort.length >= FRIEND_WARN_THRESHOLD) {
    score += 45;
    tags.add('abnormal_add_friend');
    evidence.push({
      rule: 'friend_add_burst',
      type: 'frequency',
      description: `Frequent friend add behavior (${attemptsShort.length} requests/10m).`,
      snippet: `actor=${safeActorUid}`,
    });
  }
  if (uniqueTargetsHour.size >= 12) {
    score += 26;
    tags.add('abnormal_add_friend');
    evidence.push({
      rule: 'friend_add_wide_scan',
      type: 'spread',
      description: `Too many unique friend targets in 1h (${uniqueTargetsHour.size}).`,
      snippet: `actor=${safeActorUid}`,
    });
  }
  if (outgoingPendingCount >= 8) {
    score += 22;
    tags.add('abnormal_add_friend');
    evidence.push({
      rule: 'friend_add_pending_overflow',
      type: 'pending',
      description: `Large pending friend request queue (${outgoingPendingCount}).`,
      snippet: `actor=${safeActorUid}`,
    });
  }
  if (duplicateTargetShort >= 2) {
    score += 12;
    tags.add('abnormal_add_friend');
    evidence.push({
      rule: 'friend_add_repeat_target',
      type: 'repeat',
      description: `Repeated same target in short window (${duplicateTargetShort}).`,
      snippet: `target=${safeTargetUid}`,
    });
  }

  return toRiskResponse({
    source: 'friends_add',
    score: Math.min(100, score),
    tags: Array.from(tags),
    evidence,
    summary: summarizeReasons(evidence),
  });
};

const getRecentIncomingRows = ({
  database,
  viewerUid,
  targetUid,
  targetType,
  sinceMs,
  limit,
} = {}) => {
  if (!database) return [];
  const safeViewerUid = toUid(viewerUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = normalizeTargetType(targetType);
  if (!safeViewerUid || !safeTargetUid) return [];
  if (safeTargetType === 'private') {
    return queryTextMessages(
      database,
      `
        SELECT senderUid, data, createdAtMs
        FROM messages
        WHERE type = 'text'
          AND targetType = 'private'
          AND senderUid = ?
          AND targetUid = ?
          AND createdAtMs >= ?
        ORDER BY createdAtMs DESC
        LIMIT ?
      `,
      [safeTargetUid, safeViewerUid, sinceMs, limit]
    );
  }
  return queryTextMessages(
    database,
    `
      SELECT senderUid, data, createdAtMs
      FROM messages
      WHERE type = 'text'
        AND targetType = 'group'
        AND targetUid = ?
        AND senderUid != ?
        AND createdAtMs >= ?
      ORDER BY createdAtMs DESC
      LIMIT ?
    `,
    [safeTargetUid, safeViewerUid, sinceMs, limit]
  );
};

const queryConversationTextMeta = ({
  database,
  viewerUid,
  targetUid,
  targetType,
  sinceMs,
} = {}) => {
  if (!database) return { total: 0, maxCreatedAtMs: 0 };
  const safeViewerUid = toUid(viewerUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = normalizeTargetType(targetType);
  if (!safeViewerUid || !safeTargetUid) {
    return { total: 0, maxCreatedAtMs: 0 };
  }
  const stmt =
    safeTargetType === 'private'
      ? database.prepare(`
          SELECT COUNT(1) AS total, MAX(createdAtMs) AS maxCreatedAtMs
          FROM messages
          WHERE type = 'text'
            AND targetType = 'private'
            AND senderUid = ?
            AND targetUid = ?
            AND createdAtMs >= ?
        `)
      : database.prepare(`
          SELECT COUNT(1) AS total, MAX(createdAtMs) AS maxCreatedAtMs
          FROM messages
          WHERE type = 'text'
            AND targetType = 'group'
            AND targetUid = ?
            AND senderUid != ?
            AND createdAtMs >= ?
        `);
  const bindParams =
    safeTargetType === 'private'
      ? [safeTargetUid, safeViewerUid, Math.max(0, Number(sinceMs) || 0)]
      : [safeTargetUid, safeViewerUid, Math.max(0, Number(sinceMs) || 0)];
  stmt.bind(bindParams);
  let total = 0;
  let maxCreatedAtMs = 0;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    total = Number(row?.total) || 0;
    maxCreatedAtMs = Number(row?.maxCreatedAtMs) || 0;
  }
  stmt.free();
  return {
    total: Math.max(0, total),
    maxCreatedAtMs: Math.max(0, maxCreatedAtMs),
  };
};

const resolveConversationProfileVersion = async ({
  database,
  viewerUid,
  targetUid,
  targetType = 'private',
  windowMs,
} = {}) => {
  const safeViewerUid = toUid(viewerUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = normalizeTargetType(targetType);
  if (!database || !safeViewerUid || !safeTargetUid) {
    return {
      versionToken: `invalid:${safeViewerUid}:${safeTargetType}:${safeTargetUid}`,
      ignoreEntry: null,
      windowMs: Math.max(60_000, Number(windowMs) || DEFAULT_CHAT_PROFILE_WINDOW_MS),
      msgMeta: { total: 0, maxCreatedAtMs: 0 },
      decisionMeta: { latestAtMs: 0, latestId: '', matched: 0 },
    };
  }

  const safeWindowMs = Math.max(60_000, Number(windowMs) || DEFAULT_CHAT_PROFILE_WINDOW_MS);
  const sinceMs = Date.now() - safeWindowMs;
  const [ignoreEntry, msgMeta, decisionMeta] = await Promise.all([
    getRiskIgnore({
      actorUid: safeViewerUid,
      targetUid: safeTargetUid,
      targetType: safeTargetType,
    }),
    Promise.resolve(
      queryConversationTextMeta({
        database,
        viewerUid: safeViewerUid,
        targetUid: safeTargetUid,
        targetType: safeTargetType,
        sinceMs,
      })
    ),
    getRiskDecisionWatermark({
      subjectUid: safeTargetType === 'private' ? safeTargetUid : 0,
      targetUid: safeTargetType === 'private' ? safeViewerUid : 0,
      targetType: safeTargetType,
      sinceMs,
      maxScan: 1800,
    }),
  ]);

  const ignoreToken = ignoreEntry
    ? `${Date.parse(String(ignoreEntry.ignoredAt || '')) || 0}:${Date.parse(
        String(ignoreEntry.expiresAt || '')
      ) || 0}`
    : '0:0';
  const versionToken = [
    'v2',
    safeViewerUid,
    safeTargetType,
    safeTargetUid,
    safeWindowMs,
    Number(msgMeta?.total) || 0,
    Number(msgMeta?.maxCreatedAtMs) || 0,
    Number(decisionMeta?.matched) || 0,
    Number(decisionMeta?.latestAtMs) || 0,
    String(decisionMeta?.latestId || ''),
    ignoreToken,
  ].join(':');
  return {
    versionToken,
    ignoreEntry,
    windowMs: safeWindowMs,
    msgMeta,
    decisionMeta,
  };
};

const computeConversationRiskProfileCore = async ({
  database,
  viewerUid,
  targetUid,
  targetType = 'private',
  ignoreEntry = null,
  windowMs,
} = {}) => {
  const safeViewerUid = toUid(viewerUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = normalizeTargetType(targetType);
  if (!database || !safeViewerUid || !safeTargetUid) {
    return toRiskResponse({
      source: 'chat_profile',
      available: false,
      summary: 'Risk profile unavailable.',
    });
  }

  const safeWindowMs = Math.max(60_000, Number(windowMs) || DEFAULT_CHAT_PROFILE_WINDOW_MS);
  const sinceMs = Date.now() - safeWindowMs;
  const limit = Math.max(20, DEFAULT_CHAT_HISTORY_LIMIT);

  const [rows, priorDecisions, ignoredEntryResolved] = await Promise.all([
    Promise.resolve(
      getRecentIncomingRows({
        database,
        viewerUid: safeViewerUid,
        targetUid: safeTargetUid,
        targetType: safeTargetType,
        sinceMs,
        limit,
      })
    ),
    listRiskDecisions({
      subjectUid: safeTargetType === 'private' ? safeTargetUid : 0,
      targetUid: safeTargetType === 'private' ? safeViewerUid : 0,
      targetType: safeTargetType,
      sinceMs,
      limit: 80,
    }),
    ignoreEntry
      ? Promise.resolve(ignoreEntry)
      : getRiskIgnore({
          actorUid: safeViewerUid,
          targetUid: safeTargetUid,
          targetType: safeTargetType,
        }),
  ]);

  let score = 0;
  const tags = new Set();
  const evidence = [];

  rows.forEach((row) => {
    const text = parseMessageText(row?.data);
    if (!text) return;
    const inspected = inspectTextRules(text);
    inspected.tags.forEach((tag) => tags.add(tag));
    inspected.evidence.forEach((item) => {
      evidence.push({
        ...item,
        snippet: item.snippet || sanitizeText(text, 120),
      });
    });
  });
  if (tags.has('malicious_link')) score = Math.max(score, 70);
  if (tags.has('ads_spam')) score = Math.max(score, 45);

  const senderCountMap = new Map();
  rows.forEach((row) => {
    const sender = toUid(row?.senderUid);
    if (!sender) return;
    senderCountMap.set(sender, (senderCountMap.get(sender) || 0) + 1);
  });
  if (Array.from(senderCountMap.values()).some((count) => count >= FLOOD_HIGH_THRESHOLD)) {
    score = Math.max(score, 76);
    tags.add('flooding');
    evidence.push({
      rule: 'flooding',
      type: 'frequency',
      description: 'Sender has frequent recent messages in this conversation.',
      snippet: `window=${Math.floor(safeWindowMs / 1000)}s`,
    });
  }

  let priorMaxScore = 0;
  (Array.isArray(priorDecisions) ? priorDecisions : []).forEach((item) => {
    priorMaxScore = Math.max(priorMaxScore, Math.min(100, Math.max(0, Number(item?.score) || 0)));
    (Array.isArray(item?.tags) ? item.tags : []).forEach((tag) => tags.add(String(tag || '')));
  });
  if (priorMaxScore > 0) {
    score = Math.max(score, Math.round(priorMaxScore * 0.88));
    evidence.push({
      rule: 'prior_risk_history',
      type: 'history',
      description: `Recent risk history score max=${priorMaxScore}.`,
      snippet: `decisions=${priorDecisions.length}`,
    });
  }

  const response = toRiskResponse({
    source: 'chat_profile',
    score,
    tags: Array.from(tags),
    evidence,
    summary: summarizeReasons(evidence, 'No obvious risk from recent conversation.'),
    ignored: Boolean(ignoredEntryResolved),
    ignoredEntry: ignoredEntryResolved,
  });
  return {
    ...response,
    targetUid: safeTargetUid,
    targetType: safeTargetType,
    decisionWindowMs: safeWindowMs,
  };
};

const drainProfileQueue = () => {
  if (!RISK_PROFILE_ASYNC_QUEUE_ENABLED) return;
  while (
    profileRuntime.workers < RISK_PROFILE_QUEUE_CONCURRENCY &&
    profileRuntime.queue.length > 0
  ) {
    profileRuntime.workers += 1;
    void (async () => {
      try {
        while (profileRuntime.queue.length > 0) {
          const job = profileRuntime.queue.shift();
          if (!job) break;
          try {
            const profile = await withTimeout(
              computeConversationRiskProfileCore(job.payload),
              RISK_PROFILE_COMPUTE_TIMEOUT_MS
            );
            const cacheEntry = upsertCacheEntry({
              cacheKey: job.cacheKey,
              versionToken: job.versionToken,
              profile,
            });
            profileRuntime.stats.queueProcessed += 1;
            job.resolve({
              profile,
              cacheEntry,
            });
          } catch (error) {
            updateQueueError(error);
            job.reject(error);
          } finally {
            profileRuntime.inFlight.delete(job.cacheKey);
          }
        }
      } finally {
        profileRuntime.workers = Math.max(0, profileRuntime.workers - 1);
        if (profileRuntime.queue.length > 0) {
          setImmediate(() => drainProfileQueue());
        }
      }
    })();
  }
};

const enqueueProfileComputation = ({ cacheKey, versionToken, payload }) => {
  const existing = profileRuntime.inFlight.get(cacheKey);
  if (existing) return existing.promise;
  if (!RISK_PROFILE_ASYNC_QUEUE_ENABLED) {
    return Promise.reject(new Error('risk_profile_async_queue_disabled'));
  }
  if (profileRuntime.queue.length >= RISK_PROFILE_QUEUE_MAX) {
    profileRuntime.stats.queueDropped += 1;
    return Promise.reject(new Error('risk_profile_queue_overflow'));
  }

  let resolvePromise = null;
  let rejectPromise = null;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  profileRuntime.queue.push({
    cacheKey,
    versionToken,
    payload,
    resolve: resolvePromise,
    reject: rejectPromise,
  });
  profileRuntime.stats.queueEnqueued += 1;
  profileRuntime.inFlight.set(cacheKey, {
    promise,
    enqueuedAtMs: Date.now(),
  });
  drainProfileQueue();
  return promise;
};

const buildConversationRiskProfile = async ({
  database,
  viewerUid,
  targetUid,
  targetType = 'private',
} = {}) => {
  const safeViewerUid = toUid(viewerUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = normalizeTargetType(targetType);
  if (!database || !safeViewerUid || !safeTargetUid) {
    profileRuntime.stats.cacheBypass += 1;
    return decorateProfileWithRuntime(
      await computeConversationRiskProfileCore({
        database,
        viewerUid: safeViewerUid,
        targetUid: safeTargetUid,
        targetType: safeTargetType,
      }),
      {
        mode: 'bypass_invalid',
      }
    );
  }

  const versionInfo = await resolveConversationProfileVersion({
    database,
    viewerUid: safeViewerUid,
    targetUid: safeTargetUid,
    targetType: safeTargetType,
    windowMs: DEFAULT_CHAT_PROFILE_WINDOW_MS,
  });
  const cacheKey = profileCacheKey({
    viewerUid: safeViewerUid,
    targetUid: safeTargetUid,
    targetType: safeTargetType,
    windowMs: versionInfo.windowMs,
  });
  const nowMs = Date.now();

  if (!RISK_PROFILE_CACHE_ENABLED) {
    profileRuntime.stats.cacheBypass += 1;
    const profile = await computeConversationRiskProfileCore({
      database,
      viewerUid: safeViewerUid,
      targetUid: safeTargetUid,
      targetType: safeTargetType,
      ignoreEntry: versionInfo.ignoreEntry,
      windowMs: versionInfo.windowMs,
    });
    return decorateProfileWithRuntime(profile, {
      mode: 'cache_disabled',
      cacheKey,
      versionToken: versionInfo.versionToken,
    });
  }

  const cacheEntry = pickCacheEntry(cacheKey);
  if (cacheEntry && cacheEntry.versionToken === versionInfo.versionToken) {
    if (nowMs <= Number(cacheEntry.expiresAtMs || 0)) {
      profileRuntime.stats.cacheHitFresh += 1;
      return decorateProfileWithRuntime(cacheEntry.profile, {
        mode: 'hit_fresh',
        cacheKey,
        versionToken: versionInfo.versionToken,
      });
    }
    if (nowMs <= Number(cacheEntry.staleUntilMs || 0)) {
      profileRuntime.stats.cacheHitStale += 1;
      if (RISK_PROFILE_ASYNC_QUEUE_ENABLED) {
        void enqueueProfileComputation({
          cacheKey,
          versionToken: versionInfo.versionToken,
          payload: {
            database,
            viewerUid: safeViewerUid,
            targetUid: safeTargetUid,
            targetType: safeTargetType,
            ignoreEntry: versionInfo.ignoreEntry,
            windowMs: versionInfo.windowMs,
          },
        }).catch((error) => {
          updateQueueError(error);
        });
      }
      return decorateProfileWithRuntime(cacheEntry.profile, {
        mode: 'hit_stale',
        cacheKey,
        versionToken: versionInfo.versionToken,
        queued: RISK_PROFILE_ASYNC_QUEUE_ENABLED,
      });
    }
  }

  profileRuntime.stats.cacheMiss += 1;
  if (!RISK_PROFILE_ASYNC_QUEUE_ENABLED) {
    profileRuntime.stats.syncFallback += 1;
    const profile = await computeConversationRiskProfileCore({
      database,
      viewerUid: safeViewerUid,
      targetUid: safeTargetUid,
      targetType: safeTargetType,
      ignoreEntry: versionInfo.ignoreEntry,
      windowMs: versionInfo.windowMs,
    });
    upsertCacheEntry({
      cacheKey,
      versionToken: versionInfo.versionToken,
      profile,
    });
    return decorateProfileWithRuntime(profile, {
      mode: 'miss_sync',
      cacheKey,
      versionToken: versionInfo.versionToken,
    });
  }

  let queueResult = null;
  try {
    const queued = enqueueProfileComputation({
      cacheKey,
      versionToken: versionInfo.versionToken,
      payload: {
        database,
        viewerUid: safeViewerUid,
        targetUid: safeTargetUid,
        targetType: safeTargetType,
        ignoreEntry: versionInfo.ignoreEntry,
        windowMs: versionInfo.windowMs,
      },
    });
    const waitMs = cacheEntry ? RISK_PROFILE_STALE_WAIT_MS : RISK_PROFILE_QUEUE_WAIT_MS;
    const startedAtMs = Date.now();
    queueResult = await withTimeout(queued, waitMs);
    return decorateProfileWithRuntime(queueResult.profile, {
      mode: cacheEntry ? 'miss_refresh_wait' : 'miss_wait',
      cacheKey,
      versionToken: versionInfo.versionToken,
      queued: true,
      waitedMs: Date.now() - startedAtMs,
    });
  } catch (error) {
    updateQueueError(error);
    if (cacheEntry?.profile) {
      return decorateProfileWithRuntime(cacheEntry.profile, {
        mode: 'miss_fallback_stale',
        cacheKey,
        versionToken: versionInfo.versionToken,
        queued: true,
      });
    }
    profileRuntime.stats.syncFallback += 1;
    const profile = await computeConversationRiskProfileCore({
      database,
      viewerUid: safeViewerUid,
      targetUid: safeTargetUid,
      targetType: safeTargetType,
      ignoreEntry: versionInfo.ignoreEntry,
      windowMs: versionInfo.windowMs,
    });
    upsertCacheEntry({
      cacheKey,
      versionToken: versionInfo.versionToken,
      profile,
    });
    return decorateProfileWithRuntime(profile, {
      mode: 'miss_sync_fallback',
      cacheKey,
      versionToken: versionInfo.versionToken,
    });
  }
};

const recordRiskDecision = async ({
  channel = '',
  actorUid = 0,
  subjectUid = 0,
  targetUid = 0,
  targetType = 'private',
  risk = null,
  metadata = {},
} = {}) => {
  if (!risk || typeof risk !== 'object') return null;
  const safeRiskLevel = String(risk.level || '').toLowerCase();
  if (safeRiskLevel !== 'medium' && safeRiskLevel !== 'high') return null;
  return appendRiskDecision({
    channel: sanitizeText(String(channel || ''), 40).toLowerCase() || 'unknown',
    actorUid: toUid(actorUid),
    subjectUid: toUid(subjectUid || actorUid),
    targetUid: toUid(targetUid),
    targetType: normalizeTargetType(targetType),
    score: Number(risk.score) || 0,
    level: safeRiskLevel,
    tags: Array.isArray(risk.tags) ? risk.tags : [],
    evidence: Array.isArray(risk.evidence) ? risk.evidence : [],
    summary: sanitizeText(String(risk.summary || ''), 280),
    metadata,
  });
};

const recordFriendAddAttempt = async ({ actorUid, targetUid, status = 'unknown' } = {}) =>
  appendFriendAddAttempt({ actorUid, targetUid, status });

const getRiskProfileRuntimeStats = () => ({
  cache: {
    enabled: RISK_PROFILE_CACHE_ENABLED,
    ttlMs: RISK_PROFILE_CACHE_TTL_MS,
    staleTtlMs: RISK_PROFILE_CACHE_STALE_TTL_MS,
    max: RISK_PROFILE_CACHE_MAX,
    size: profileRuntime.cache.size,
  },
  queue: {
    enabled: RISK_PROFILE_ASYNC_QUEUE_ENABLED,
    max: RISK_PROFILE_QUEUE_MAX,
    concurrency: RISK_PROFILE_QUEUE_CONCURRENCY,
    pending: profileRuntime.queue.length,
    workers: profileRuntime.workers,
    inflightKeys: profileRuntime.inFlight.size,
    waitMs: RISK_PROFILE_QUEUE_WAIT_MS,
    staleWaitMs: RISK_PROFILE_STALE_WAIT_MS,
    computeTimeoutMs: RISK_PROFILE_COMPUTE_TIMEOUT_MS,
  },
  stats: { ...profileRuntime.stats },
  generatedAt: new Date().toISOString(),
});

const resetRiskProfileRuntimeForTests = () => {
  profileRuntime.cache.clear();
  profileRuntime.queue.length = 0;
  profileRuntime.inFlight.clear();
  profileRuntime.workers = 0;
  profileRuntime.stats = {
    cacheHitFresh: 0,
    cacheHitStale: 0,
    cacheMiss: 0,
    cacheBypass: 0,
    queueEnqueued: 0,
    queueDropped: 0,
    queueProcessed: 0,
    queueErrors: 0,
    syncFallback: 0,
    lastQueueError: '',
    lastQueueErrorAt: '',
  };
};

export {
  assessFriendAddRisk,
  assessOutgoingTextRisk,
  buildConversationRiskProfile,
  getRiskProfileRuntimeStats,
  recordFriendAddAttempt,
  recordRiskDecision,
  resetRiskProfileRuntimeForTests,
};
