/**
 * Reco state store:
 * - decision logs
 * - feedback logs
 * - lightweight online preference profiles
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { threadId } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const IS_NODE_TEST = process.argv.includes('--test');
const DEFAULT_STATE_PATH = path.join(
  DATA_DIR,
  IS_NODE_TEST ? `reco-state.${process.pid}.${threadId}.json` : 'reco-state.json'
);
const RECO_STATE_PATH = String(process.env.RECO_STATE_PATH || '').trim() || DEFAULT_STATE_PATH;
const MAX_DECISIONS = Number.parseInt(String(process.env.RECO_STATE_MAX_DECISIONS || '12000'), 10) || 12_000;
const MAX_FEEDBACKS = Number.parseInt(String(process.env.RECO_STATE_MAX_FEEDBACKS || '20000'), 10) || 20_000;
const MAX_USER_PROFILES = Number.parseInt(String(process.env.RECO_STATE_MAX_USERS || '10000'), 10) || 10_000;
const MAX_TAGS_PER_USER = Number.parseInt(String(process.env.RECO_STATE_MAX_TAGS_PER_USER || '128'), 10) || 128;
const MAX_HOUR_KEYS = 24;

const DEFAULT_RECO_STATE = Object.freeze({
  version: 1,
  updatedAt: '',
  decisions: [],
  feedbacks: [],
  userProfiles: {},
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeText = (value, maxLen = 200) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const normalizeCandidateId = (value) => sanitizeText(value, 120).toLowerCase();

const normalizeDecisionRecord = (entry) => {
  const uid = Math.max(0, Math.floor(toFiniteNumber(entry?.uid, 0)));
  const createdAtMs = Math.max(0, Math.floor(toFiniteNumber(entry?.createdAtMs, Date.now())));
  const ranking = Array.isArray(entry?.ranking)
    ? entry.ranking
        .map((item) => ({
          candidateId: normalizeCandidateId(item?.candidateId),
          score: toFiniteNumber(item?.score, 0),
          rank: Math.max(1, Math.floor(toFiniteNumber(item?.rank, 1))),
          provider: sanitizeText(item?.provider, 40),
        }))
        .filter((item) => item.candidateId)
        .slice(0, 120)
    : [];
  return {
    id: sanitizeText(entry?.id, 80),
    uid,
    mode: sanitizeText(entry?.mode, 20) || 'disabled',
    provider: sanitizeText(entry?.provider, 40),
    selectedCandidateId: normalizeCandidateId(entry?.selectedCandidateId),
    ranking,
    createdAt: sanitizeText(entry?.createdAt, 40) || new Date(createdAtMs).toISOString(),
    createdAtMs,
    epsilon: toFiniteNumber(entry?.epsilon, 0),
    rolloutPercent: toFiniteNumber(entry?.rolloutPercent, 0),
    eligibleOnline: entry?.eligibleOnline === true,
    context: entry?.context && typeof entry.context === 'object' ? entry.context : {},
    metadata: entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
  };
};

const normalizeFeedbackRecord = (entry) => {
  const uid = Math.max(0, Math.floor(toFiniteNumber(entry?.uid, 0)));
  const createdAtMs = Math.max(0, Math.floor(toFiniteNumber(entry?.createdAtMs, Date.now())));
  return {
    id: sanitizeText(entry?.id, 80),
    decisionId: sanitizeText(entry?.decisionId, 80),
    uid,
    action: sanitizeText(entry?.action, 32).toLowerCase() || 'unknown',
    reward: toFiniteNumber(entry?.reward, 0),
    candidateId: normalizeCandidateId(entry?.candidateId),
    createdAt: sanitizeText(entry?.createdAt, 40) || new Date(createdAtMs).toISOString(),
    createdAtMs,
    metadata: entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
  };
};

const normalizeUserProfile = (uid, profile) => {
  const userId = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  const source = profile && typeof profile === 'object' ? profile : {};
  const tagWeightsSource = source.tagWeights && typeof source.tagWeights === 'object' ? source.tagWeights : {};
  const tagWeights = {};
  Object.entries(tagWeightsSource)
    .map(([key, value]) => [normalizeCandidateId(key), toFiniteNumber(value, 0)])
    .filter(([key]) => Boolean(key))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, MAX_TAGS_PER_USER)
    .forEach(([key, value]) => {
      tagWeights[key] = value;
    });
  const hourWeightsSource = source.hourWeights && typeof source.hourWeights === 'object' ? source.hourWeights : {};
  const hourWeights = {};
  Object.entries(hourWeightsSource).forEach(([key, value]) => {
    const hour = Number.parseInt(String(key), 10);
    if (!Number.isInteger(hour) || hour < 0 || hour >= MAX_HOUR_KEYS) return;
    hourWeights[String(hour)] = toFiniteNumber(value, 0);
  });
  const targetTypeWeightsSource =
    source.targetTypeWeights && typeof source.targetTypeWeights === 'object'
      ? source.targetTypeWeights
      : {};
  return {
    uid: userId,
    updatedAt: sanitizeText(source.updatedAt, 40),
    updatedAtMs: Math.max(0, Math.floor(toFiniteNumber(source.updatedAtMs, 0))),
    interactions: {
      total: Math.max(0, Math.floor(toFiniteNumber(source?.interactions?.total, 0))),
      positive: Math.max(0, Math.floor(toFiniteNumber(source?.interactions?.positive, 0))),
      negative: Math.max(0, Math.floor(toFiniteNumber(source?.interactions?.negative, 0))),
    },
    tagWeights,
    targetTypeWeights: {
      private: toFiniteNumber(targetTypeWeightsSource.private, 0),
      group: toFiniteNumber(targetTypeWeightsSource.group, 0),
    },
    hourWeights,
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : {},
  };
};

const normalizeRecoState = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const decisions = Array.isArray(source.decisions)
    ? source.decisions.map(normalizeDecisionRecord).filter((item) => item.id).slice(-MAX_DECISIONS)
    : [];
  const feedbacks = Array.isArray(source.feedbacks)
    ? source.feedbacks.map(normalizeFeedbackRecord).filter((item) => item.id).slice(-MAX_FEEDBACKS)
    : [];
  const userProfilesSource =
    source.userProfiles && typeof source.userProfiles === 'object' ? source.userProfiles : {};
  const userProfiles = {};
  Object.entries(userProfilesSource)
    .map(([uid, profile]) => normalizeUserProfile(uid, profile))
    .filter((profile) => profile.uid > 0)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, MAX_USER_PROFILES)
    .forEach((profile) => {
      userProfiles[String(profile.uid)] = profile;
    });

  return {
    version: 1,
    updatedAt: sanitizeText(source.updatedAt, 40),
    decisions,
    feedbacks,
    userProfiles,
  };
};

let recoStateCache = null;
let recoStateLoadPromise = null;
let recoStateWriteChain = Promise.resolve();

const ensureStateDir = async () => {
  await fs.mkdir(path.dirname(RECO_STATE_PATH), { recursive: true });
};

const readStateFromDisk = async () => {
  try {
    const raw = await fs.readFile(RECO_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeRecoState(parsed);
  } catch {
    return normalizeRecoState(DEFAULT_RECO_STATE);
  }
};

const writeStateWithRetry = async (state, retries = 2) => {
  await ensureStateDir();
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let tempPath = '';
    try {
      tempPath = `${RECO_STATE_PATH}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tempPath, RECO_STATE_PATH);
      return;
    } catch (error) {
      lastError = error;
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  throw lastError || new Error('reco_state_write_failed');
};

const ensureRecoStateLoaded = async () => {
  if (recoStateCache) return recoStateCache;
  if (recoStateLoadPromise) return recoStateLoadPromise;
  recoStateLoadPromise = readStateFromDisk()
    .then((state) => {
      recoStateCache = state;
      return recoStateCache;
    })
    .finally(() => {
      recoStateLoadPromise = null;
    });
  return recoStateLoadPromise;
};

const persistRecoState = async () => {
  if (!recoStateCache) return;
  const next = normalizeRecoState({
    ...recoStateCache,
    updatedAt: new Date().toISOString(),
  });
  recoStateCache = next;
  await writeStateWithRetry(next, 3);
};

const withRecoStateMutation = async (mutator, { defaultResult = null } = {}) => {
  await ensureRecoStateLoaded();
  const working = cloneValue(recoStateCache || DEFAULT_RECO_STATE);
  let mutationResult = defaultResult;
  try {
    mutationResult = (await mutator(working)) ?? defaultResult;
  } catch {
    return defaultResult;
  }
  recoStateCache = normalizeRecoState(working);
  recoStateWriteChain = recoStateWriteChain.catch(() => undefined).then(() => persistRecoState());
  await recoStateWriteChain;
  return mutationResult;
};

const appendRecoDecision = async (entry = {}) => {
  const normalized = normalizeDecisionRecord(entry);
  if (!normalized.id) return null;
  await withRecoStateMutation((working) => {
    const list = Array.isArray(working.decisions) ? working.decisions : [];
    list.push(normalized);
    working.decisions = list.slice(-MAX_DECISIONS);
    return normalized;
  });
  return normalized;
};

const appendRecoFeedback = async (entry = {}) => {
  const normalized = normalizeFeedbackRecord(entry);
  if (!normalized.id) return null;
  await withRecoStateMutation((working) => {
    const list = Array.isArray(working.feedbacks) ? working.feedbacks : [];
    list.push(normalized);
    working.feedbacks = list.slice(-MAX_FEEDBACKS);
    return normalized;
  });
  return normalized;
};

const listRecoDecisions = async ({ uid = 0, sinceMs = 0, limit = 80 } = {}) => {
  await ensureRecoStateLoaded();
  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  const safeSinceMs = Math.max(0, Math.floor(toFiniteNumber(sinceMs, 0)));
  const safeLimit = Math.max(1, Math.min(400, Math.floor(toFiniteNumber(limit, 80))));
  const source = Array.isArray(recoStateCache?.decisions) ? recoStateCache.decisions : [];
  return source
    .filter((item) => {
      if (safeUid > 0 && Number(item?.uid) !== safeUid) return false;
      if (safeSinceMs > 0 && Number(item?.createdAtMs || 0) < safeSinceMs) return false;
      return true;
    })
    .slice(-safeLimit)
    .reverse();
};

const listRecoFeedback = async ({ uid = 0, sinceMs = 0, limit = 120 } = {}) => {
  await ensureRecoStateLoaded();
  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  const safeSinceMs = Math.max(0, Math.floor(toFiniteNumber(sinceMs, 0)));
  const safeLimit = Math.max(1, Math.min(600, Math.floor(toFiniteNumber(limit, 120))));
  const source = Array.isArray(recoStateCache?.feedbacks) ? recoStateCache.feedbacks : [];
  return source
    .filter((item) => {
      if (safeUid > 0 && Number(item?.uid) !== safeUid) return false;
      if (safeSinceMs > 0 && Number(item?.createdAtMs || 0) < safeSinceMs) return false;
      return true;
    })
    .slice(-safeLimit)
    .reverse();
};

const getRecoDecisionById = async (decisionId = '') => {
  await ensureRecoStateLoaded();
  const target = sanitizeText(decisionId, 80);
  if (!target) return null;
  const source = Array.isArray(recoStateCache?.decisions) ? recoStateCache.decisions : [];
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const item = source[i];
    if (String(item?.id || '') === target) return item;
  }
  return null;
};

const getRecoUserProfile = async (uid = 0) => {
  await ensureRecoStateLoaded();
  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  if (safeUid <= 0) return null;
  const profile = recoStateCache?.userProfiles?.[String(safeUid)];
  return profile ? normalizeUserProfile(safeUid, profile) : null;
};

const upsertRecoUserProfile = async (uid = 0, updater = null) => {
  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  if (safeUid <= 0 || typeof updater !== 'function') return null;
  return await withRecoStateMutation((working) => {
    const profiles =
      working.userProfiles && typeof working.userProfiles === 'object' ? working.userProfiles : {};
    const key = String(safeUid);
    const current = normalizeUserProfile(safeUid, profiles[key] || {});
    const nextRaw = updater(cloneValue(current)) || current;
    const next = normalizeUserProfile(safeUid, {
      ...current,
      ...nextRaw,
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    });
    profiles[key] = next;
    const trimmedProfiles = {};
    Object.values(profiles)
      .map((item) => normalizeUserProfile(item?.uid, item))
      .filter((item) => item.uid > 0)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, MAX_USER_PROFILES)
      .forEach((item) => {
        trimmedProfiles[String(item.uid)] = item;
      });
    working.userProfiles = trimmedProfiles;
    return next;
  });
};

const listRecoUserProfiles = async ({ limit = 60 } = {}) => {
  await ensureRecoStateLoaded();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(toFiniteNumber(limit, 60))));
  const source =
    recoStateCache?.userProfiles && typeof recoStateCache.userProfiles === 'object'
      ? recoStateCache.userProfiles
      : {};
  return Object.values(source)
    .map((item) => normalizeUserProfile(item?.uid, item))
    .filter((item) => item.uid > 0)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, safeLimit);
};

const getRecoStateStats = async () => {
  await ensureRecoStateLoaded();
  const decisions = Array.isArray(recoStateCache?.decisions) ? recoStateCache.decisions : [];
  const feedbacks = Array.isArray(recoStateCache?.feedbacks) ? recoStateCache.feedbacks : [];
  const userProfiles =
    recoStateCache?.userProfiles && typeof recoStateCache.userProfiles === 'object'
      ? recoStateCache.userProfiles
      : {};
  return {
    path: RECO_STATE_PATH,
    updatedAt: recoStateCache?.updatedAt || '',
    decisions: decisions.length,
    feedbacks: feedbacks.length,
    users: Object.keys(userProfiles).length,
  };
};

const resetRecoStateForTests = async () => {
  await recoStateWriteChain.catch(() => undefined);
  const next = normalizeRecoState(DEFAULT_RECO_STATE);
  recoStateCache = next;
  recoStateWriteChain = recoStateWriteChain
    .catch(() => undefined)
    .then(() => writeStateWithRetry(next, 3));
  await recoStateWriteChain;
};

export {
  appendRecoDecision,
  appendRecoFeedback,
  getRecoDecisionById,
  getRecoStateStats,
  getRecoUserProfile,
  listRecoDecisions,
  listRecoFeedback,
  listRecoUserProfiles,
  resetRecoStateForTests,
  upsertRecoUserProfile,
};
