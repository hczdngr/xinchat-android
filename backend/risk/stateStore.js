/**
 * Risk guard persistence store:
 * - risk decision logs
 * - ignore list
 * - appeal logs
 * - friend add behavior logs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizeText } from './rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_STATE_PATH = path.join(DATA_DIR, 'risk-state.json');

const RISK_STATE_PATH = String(process.env.RISK_STATE_PATH || '').trim() || DEFAULT_STATE_PATH;
const MAX_DECISIONS = Number.parseInt(String(process.env.RISK_STATE_MAX_DECISIONS || '6000'), 10) || 6000;
const MAX_APPEALS = Number.parseInt(String(process.env.RISK_STATE_MAX_APPEALS || '1500'), 10) || 1500;
const MAX_FRIEND_ATTEMPTS =
  Number.parseInt(String(process.env.RISK_STATE_MAX_FRIEND_ATTEMPTS || '10000'), 10) || 10_000;
const MAX_IGNORE_HOURS =
  Number.parseInt(String(process.env.RISK_MAX_IGNORE_HOURS || String(24 * 30)), 10) || 24 * 30;

const DEFAULT_RISK_STATE = Object.freeze({
  version: 1,
  updatedAt: '',
  ignored: {},
  appeals: [],
  decisions: [],
  friendAddAttempts: [],
});

let riskStateCache = null;
let riskStateLoadPromise = null;
let riskStateWriteChain = Promise.resolve();

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const nowIso = () => new Date().toISOString();

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const toIso = (value, fallback = nowIso()) => {
  const raw = sanitizeText(String(value || ''), 64);
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return fallback;
  return new Date(ts).toISOString();
};

const toUid = (value) => {
  const uid = Number(value);
  return Number.isInteger(uid) && uid > 0 ? uid : 0;
};

const normalizeTargetType = (value) => (String(value || '').trim() === 'group' ? 'group' : 'private');

const normalizeRiskLevel = (value) => {
  const level = String(value || '').trim().toLowerCase();
  if (level === 'high' || level === 'medium') return level;
  return 'low';
};

const normalizeTags = (value) => {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const list = [];
  source.forEach((entry) => {
    const safe = sanitizeText(String(entry || ''), 48).toLowerCase();
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    list.push(safe);
  });
  return list.slice(0, 12);
};

const normalizeEvidence = (value) => {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const rule = sanitizeText(String(entry.rule || ''), 48).toLowerCase();
      const type = sanitizeText(String(entry.type || ''), 24).toLowerCase();
      const description = sanitizeText(String(entry.description || ''), 240);
      const snippet = sanitizeText(String(entry.snippet || ''), 240);
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
};

const normalizeDecisionRecord = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const subjectUid = toUid(entry.subjectUid || entry.actorUid);
  const channel = sanitizeText(String(entry.channel || ''), 40).toLowerCase() || 'unknown';
  const id =
    sanitizeText(String(entry.id || ''), 64) ||
    `${channel}:${subjectUid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  return {
    id,
    createdAt: toIso(entry.createdAt),
    actorUid: toUid(entry.actorUid),
    subjectUid,
    targetUid: toUid(entry.targetUid),
    targetType: normalizeTargetType(entry.targetType),
    channel,
    score: Math.min(100, Math.max(0, Number(entry.score) || 0)),
    level: normalizeRiskLevel(entry.level),
    tags: normalizeTags(entry.tags),
    evidence: normalizeEvidence(entry.evidence),
    summary: sanitizeText(String(entry.summary || ''), 280),
    metadata: entry.metadata && typeof entry.metadata === 'object' ? cloneValue(entry.metadata) : {},
  };
};

const normalizeAppealRecord = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const actorUid = toUid(entry.actorUid);
  if (!actorUid) return null;
  return {
    id:
      sanitizeText(String(entry.id || ''), 64) ||
      `appeal:${actorUid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    actorUid,
    targetUid: toUid(entry.targetUid),
    targetType: normalizeTargetType(entry.targetType),
    reason: sanitizeText(String(entry.reason || ''), 300),
    createdAt: toIso(entry.createdAt),
    status: sanitizeText(String(entry.status || 'pending'), 24).toLowerCase() || 'pending',
    context: entry.context && typeof entry.context === 'object' ? cloneValue(entry.context) : {},
  };
};

const normalizeFriendAttemptRecord = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const actorUid = toUid(entry.actorUid);
  if (!actorUid) return null;
  return {
    actorUid,
    targetUid: toUid(entry.targetUid),
    status: sanitizeText(String(entry.status || 'unknown'), 24).toLowerCase() || 'unknown',
    createdAt: toIso(entry.createdAt),
    createdAtMs: Number(entry.createdAtMs) || Date.now(),
  };
};

const normalizeIgnoredRecord = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const actorUid = toUid(entry.actorUid);
  const targetUid = toUid(entry.targetUid);
  if (!actorUid || !targetUid) return null;
  const ignoredAt = toIso(entry.ignoredAt);
  const expiresAt = toIso(entry.expiresAt, ignoredAt);
  return {
    actorUid,
    targetUid,
    targetType: normalizeTargetType(entry.targetType),
    reason: sanitizeText(String(entry.reason || ''), 180),
    ignoredAt,
    expiresAt,
  };
};

const normalizeIgnoredMap = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  Object.entries(source).forEach(([key, entry]) => {
    const normalized = normalizeIgnoredRecord(entry);
    if (!normalized) return;
    result[String(key)] = normalized;
  });
  return result;
};

const normalizeRiskState = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const state = {
    version: 1,
    updatedAt: toIso(source.updatedAt, ''),
    ignored: normalizeIgnoredMap(source.ignored),
    appeals: (Array.isArray(source.appeals) ? source.appeals : [])
      .map(normalizeAppealRecord)
      .filter(Boolean)
      .slice(-MAX_APPEALS),
    decisions: (Array.isArray(source.decisions) ? source.decisions : [])
      .map(normalizeDecisionRecord)
      .filter(Boolean)
      .slice(-MAX_DECISIONS),
    friendAddAttempts: (Array.isArray(source.friendAddAttempts) ? source.friendAddAttempts : [])
      .map(normalizeFriendAttemptRecord)
      .filter(Boolean)
      .slice(-MAX_FRIEND_ATTEMPTS),
  };
  return state;
};

const ensureStateFile = async () => {
  await fs.mkdir(path.dirname(RISK_STATE_PATH), { recursive: true });
};

const readRiskStateFromDisk = async () => {
  try {
    const raw = await fs.readFile(RISK_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeRiskState(parsed);
  } catch {
    return normalizeRiskState(DEFAULT_RISK_STATE);
  }
};

const writeRiskStateWithRetry = async (state, retries = 2) => {
  let lastError = null;
  await ensureStateFile();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let tempPath = '';
    try {
      tempPath = `${RISK_STATE_PATH}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2, 10)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
      try {
        await fs.rename(tempPath, RISK_STATE_PATH);
      } catch (renameError) {
        const code = String(renameError?.code || '');
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') {
          throw renameError;
        }
        await fs.writeFile(RISK_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
        await fs.unlink(tempPath).catch(() => undefined);
      }
      return;
    } catch (error) {
      lastError = error;
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('risk_state_write_failed');
};

const ensureRiskStateLoaded = async () => {
  if (riskStateCache) return riskStateCache;
  if (riskStateLoadPromise) return riskStateLoadPromise;
  riskStateLoadPromise = readRiskStateFromDisk()
    .then((state) => {
      riskStateCache = state;
      return state;
    })
    .finally(() => {
      riskStateLoadPromise = null;
    });
  return riskStateLoadPromise;
};

const persistRiskState = async () => {
  if (!riskStateCache) return;
  const next = normalizeRiskState({
    ...riskStateCache,
    updatedAt: nowIso(),
  });
  riskStateCache = next;
  await writeRiskStateWithRetry(next);
};

const withRiskStateMutation = async (mutator, { defaultResult = null } = {}) => {
  await ensureRiskStateLoaded();
  const working = cloneValue(riskStateCache || DEFAULT_RISK_STATE);
  const mutation = (await mutator(working)) || {};
  const changed = mutation.changed === true;
  const result = Object.prototype.hasOwnProperty.call(mutation, 'result')
    ? mutation.result
    : defaultResult;
  if (changed) {
    riskStateCache = normalizeRiskState(working);
    riskStateWriteChain = riskStateWriteChain
      .catch(() => undefined)
      .then(() => persistRiskState());
    await riskStateWriteChain;
  }
  return { changed, result };
};

const makeIgnoreKey = ({ actorUid, targetType, targetUid }) =>
  `${toUid(actorUid)}:${normalizeTargetType(targetType)}:${toUid(targetUid)}`;

const upsertRiskIgnore = async ({
  actorUid,
  targetUid,
  targetType = 'private',
  reason = '',
  ttlHours = 24 * 7,
} = {}) => {
  const safeActorUid = toUid(actorUid);
  const safeTargetUid = toUid(targetUid);
  if (!safeActorUid || !safeTargetUid) return null;
  const safeTtlHours = toPositiveInt(ttlHours, 24 * 7, 1, MAX_IGNORE_HOURS);
  const ignoredAt = nowIso();
  const expiresAt = new Date(Date.now() + safeTtlHours * 60 * 60 * 1000).toISOString();
  const entry = normalizeIgnoredRecord({
    actorUid: safeActorUid,
    targetUid: safeTargetUid,
    targetType,
    reason,
    ignoredAt,
    expiresAt,
  });
  if (!entry) return null;

  const key = makeIgnoreKey(entry);
  await withRiskStateMutation((working) => {
    const ignored = working.ignored && typeof working.ignored === 'object' ? working.ignored : {};
    ignored[key] = entry;
    working.ignored = ignored;
    return { changed: true, result: entry };
  });
  return entry;
};

const getRiskIgnore = async ({ actorUid, targetUid, targetType = 'private' } = {}) => {
  await ensureRiskStateLoaded();
  const key = makeIgnoreKey({ actorUid, targetUid, targetType });
  const entry = riskStateCache?.ignored?.[key] || null;
  if (!entry) return null;
  const expiresAtMs = Date.parse(String(entry.expiresAt || ''));
  if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
    return entry;
  }
  await withRiskStateMutation((working) => {
    if (!working.ignored || typeof working.ignored !== 'object') {
      return { changed: false, result: null };
    }
    if (!Object.prototype.hasOwnProperty.call(working.ignored, key)) {
      return { changed: false, result: null };
    }
    delete working.ignored[key];
    return { changed: true, result: null };
  });
  return null;
};

const appendRiskAppeal = async ({
  actorUid,
  targetUid,
  targetType = 'private',
  reason = '',
  context = {},
} = {}) => {
  const entry = normalizeAppealRecord({
    actorUid,
    targetUid,
    targetType,
    reason,
    context,
    createdAt: nowIso(),
    status: 'pending',
  });
  if (!entry) return null;
  await withRiskStateMutation((working) => {
    const appeals = Array.isArray(working.appeals) ? working.appeals : [];
    appeals.push(entry);
    working.appeals = appeals.slice(-MAX_APPEALS);
    return { changed: true, result: entry };
  });
  return entry;
};

const appendRiskDecision = async (entry = {}) => {
  const normalized = normalizeDecisionRecord({
    ...entry,
    createdAt: entry.createdAt || nowIso(),
  });
  if (!normalized) return null;
  await withRiskStateMutation((working) => {
    const decisions = Array.isArray(working.decisions) ? working.decisions : [];
    decisions.push(normalized);
    working.decisions = decisions.slice(-MAX_DECISIONS);
    return { changed: true, result: normalized };
  });
  return normalized;
};

const appendFriendAddAttempt = async ({ actorUid, targetUid, status = 'unknown' } = {}) => {
  const normalized = normalizeFriendAttemptRecord({
    actorUid,
    targetUid,
    status,
    createdAt: nowIso(),
    createdAtMs: Date.now(),
  });
  if (!normalized) return null;
  await withRiskStateMutation((working) => {
    const attempts = Array.isArray(working.friendAddAttempts) ? working.friendAddAttempts : [];
    attempts.push(normalized);
    working.friendAddAttempts = attempts.slice(-MAX_FRIEND_ATTEMPTS);
    return { changed: true, result: normalized };
  });
  return normalized;
};

const listFriendAddAttemptsByActor = async ({ actorUid, windowMs = 60 * 60 * 1000 } = {}) => {
  await ensureRiskStateLoaded();
  const safeActorUid = toUid(actorUid);
  if (!safeActorUid) return [];
  const safeWindowMs = toPositiveInt(windowMs, 60 * 60 * 1000, 1, 14 * 24 * 60 * 60 * 1000);
  const sinceMs = Date.now() - safeWindowMs;
  const source = Array.isArray(riskStateCache?.friendAddAttempts) ? riskStateCache.friendAddAttempts : [];
  return source
    .filter((item) => Number(item?.actorUid) === safeActorUid && Number(item?.createdAtMs) >= sinceMs)
    .slice(-200);
};

const listRiskDecisions = async ({ subjectUid = 0, targetUid = 0, targetType = '', sinceMs = 0, limit = 40 } = {}) => {
  await ensureRiskStateLoaded();
  const safeLimit = toPositiveInt(limit, 40, 1, 400);
  const safeSubjectUid = toUid(subjectUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = targetType ? normalizeTargetType(targetType) : '';
  const safeSinceMs = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0 ? Number(sinceMs) : 0;
  const source = Array.isArray(riskStateCache?.decisions) ? riskStateCache.decisions : [];
  const filtered = source.filter((item) => {
    if (safeSubjectUid && Number(item?.subjectUid) !== safeSubjectUid) return false;
    if (safeTargetUid && Number(item?.targetUid) !== safeTargetUid) return false;
    if (safeTargetType && String(item?.targetType || '') !== safeTargetType) return false;
    if (safeSinceMs > 0) {
      const ts = Date.parse(String(item?.createdAt || ''));
      if (!Number.isFinite(ts) || ts < safeSinceMs) return false;
    }
    return true;
  });
  return filtered.slice(-safeLimit);
};

const getRiskDecisionWatermark = async ({
  subjectUid = 0,
  targetUid = 0,
  targetType = '',
  sinceMs = 0,
  maxScan = 1600,
} = {}) => {
  await ensureRiskStateLoaded();
  const safeSubjectUid = toUid(subjectUid);
  const safeTargetUid = toUid(targetUid);
  const safeTargetType = targetType ? normalizeTargetType(targetType) : '';
  const safeSinceMs = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0 ? Number(sinceMs) : 0;
  const safeMaxScan = toPositiveInt(maxScan, 1600, 50, 20000);
  const source = Array.isArray(riskStateCache?.decisions) ? riskStateCache.decisions : [];
  let scanned = 0;
  let matched = 0;
  let latestAtMs = 0;
  let latestId = '';

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    scanned += 1;
    if (scanned > safeMaxScan) break;

    const createdAtMs = Date.parse(String(item?.createdAt || ''));
    if (safeSinceMs > 0 && Number.isFinite(createdAtMs) && createdAtMs < safeSinceMs && latestAtMs > 0) {
      break;
    }
    if (safeSubjectUid && Number(item?.subjectUid) !== safeSubjectUid) continue;
    if (safeTargetUid && Number(item?.targetUid) !== safeTargetUid) continue;
    if (safeTargetType && String(item?.targetType || '') !== safeTargetType) continue;
    if (safeSinceMs > 0) {
      if (!Number.isFinite(createdAtMs) || createdAtMs < safeSinceMs) continue;
    }
    matched += 1;
    if (!latestAtMs && Number.isFinite(createdAtMs) && createdAtMs > 0) {
      latestAtMs = createdAtMs;
      latestId = sanitizeText(String(item?.id || ''), 64);
    }
  }

  return {
    matched,
    latestAtMs: Number.isFinite(latestAtMs) && latestAtMs > 0 ? latestAtMs : 0,
    latestId,
    scanned,
  };
};

const getRiskAdminOverview = async ({ limit = 120 } = {}) => {
  await ensureRiskStateLoaded();
  const safeLimit = toPositiveInt(limit, 120, 10, 500);
  const decisions = (Array.isArray(riskStateCache?.decisions) ? riskStateCache.decisions : []).slice(-safeLimit);
  const appeals = (Array.isArray(riskStateCache?.appeals) ? riskStateCache.appeals : []).slice(-80);
  const byLevel = { low: 0, medium: 0, high: 0 };
  const byChannel = {};
  const byTag = {};
  decisions.forEach((item) => {
    const level = normalizeRiskLevel(item?.level);
    byLevel[level] = (byLevel[level] || 0) + 1;
    const channel = sanitizeText(String(item?.channel || 'unknown'), 40).toLowerCase() || 'unknown';
    byChannel[channel] = (byChannel[channel] || 0) + 1;
    (Array.isArray(item?.tags) ? item.tags : []).forEach((tag) => {
      const safeTag = sanitizeText(String(tag || ''), 48).toLowerCase();
      if (!safeTag) return;
      byTag[safeTag] = (byTag[safeTag] || 0) + 1;
    });
  });
  return {
    generatedAt: nowIso(),
    counts: {
      decisions: decisions.length,
      appeals: appeals.length,
      ignored: Object.keys(riskStateCache?.ignored || {}).length,
      byLevel,
      byChannel,
      byTag,
    },
    recentDecisions: decisions.slice(-30).reverse(),
    recentAppeals: appeals.slice(-30).reverse(),
  };
};

const resetRiskStateForTests = async () => {
  await riskStateWriteChain.catch(() => undefined);
  const nextState = normalizeRiskState(DEFAULT_RISK_STATE);
  riskStateCache = nextState;
  riskStateWriteChain = riskStateWriteChain
    .catch(() => undefined)
    .then(() => writeRiskStateWithRetry(nextState, 3));
  await riskStateWriteChain;
};

export {
  appendFriendAddAttempt,
  appendRiskAppeal,
  appendRiskDecision,
  getRiskAdminOverview,
  getRiskIgnore,
  getRiskDecisionWatermark,
  listFriendAddAttemptsByActor,
  listRiskDecisions,
  resetRiskStateForTests,
  upsertRiskIgnore,
};
