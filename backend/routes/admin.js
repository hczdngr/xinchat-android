/**
 * 模块说明：管理路由模块：提供用户与商品管理及瓶颈诊断接口。
 */
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUsersCacheInfo, mutateUsers, readUsersCached } from './auth.js';
import { requireAdminAccess } from './adminAuth.js';
import { readGroups } from './groups.js';
import {
  getChatDatabaseForOps,
  deleteMessageByIdForAdmin,
  findMessageByIdForAdmin,
  searchMessagesForAdmin,
  summarizeMessagesForAdmin,
} from './chat.js';
import { metrics } from '../observability.js';
import {
  bulkUpdateFeatureFlagOverrides,
  FEATURE_DEFINITIONS,
  getFeatureFlagDetails,
  getFeatureFlagRuntimeState,
  getFeatureFlagsSnapshot,
  isFeatureEnabled,
  setFeatureFlagOverride,
} from '../featureFlags.js';
import { createRequestEvent, getEventLoggerStats, trackEventSafe } from '../events/eventLogger.js';
import { getRiskAdminOverview } from '../risk/stateStore.js';
import { getRiskProfileRuntimeStats } from '../risk/scorer.js';
import { buildRelationshipOpsSnapshot, normalizeScope, normalizeWindowDays } from '../ops/relationshipService.js';
import { DEFAULT_ASSISTANT_PROFILE, resolveAssistantProfileFromUser } from '../assistant/preferences.js';
import { getSummaryAdminOverview } from '../summary/service.js';
import { getRecoAdminOverview, getRecoUserPersona, updateRecoAdminConfig } from '../reco/index.js';
import { atomicWriteFile, createSerialQueue } from '../utils/filePersistence.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const PRODUCTS_LOCK_PATH = path.join(DATA_DIR, 'products.json.lock');
const MESSAGE_REVIEWS_PATH = path.join(DATA_DIR, 'message-reviews.json');
const MESSAGE_REVIEWS_LOCK_PATH = path.join(DATA_DIR, 'message-reviews.json.lock');
const PRODUCTS_CACHE_TTL_MS = Number.parseInt(String(process.env.PRODUCTS_CACHE_TTL_MS || '5000'), 10);
const PRODUCTS_WRITE_QUEUE_MAX = Number.parseInt(
  String(process.env.PRODUCTS_WRITE_QUEUE_MAX || '2000'),
  10
);
const MESSAGE_REVIEWS_WRITE_QUEUE_MAX = Number.parseInt(
  String(process.env.MESSAGE_REVIEWS_WRITE_QUEUE_MAX || '2000'),
  10
);
const SAFE_PRODUCTS_CACHE_TTL_MS =
  Number.isInteger(PRODUCTS_CACHE_TTL_MS) && PRODUCTS_CACHE_TTL_MS >= 200
    ? PRODUCTS_CACHE_TTL_MS
    : 5000;
const SAFE_PRODUCTS_WRITE_QUEUE_MAX =
  Number.isInteger(PRODUCTS_WRITE_QUEUE_MAX) && PRODUCTS_WRITE_QUEUE_MAX >= 20
    ? PRODUCTS_WRITE_QUEUE_MAX
    : 2000;
const SAFE_MESSAGE_REVIEWS_WRITE_QUEUE_MAX =
  Number.isInteger(MESSAGE_REVIEWS_WRITE_QUEUE_MAX) && MESSAGE_REVIEWS_WRITE_QUEUE_MAX >= 20
    ? MESSAGE_REVIEWS_WRITE_QUEUE_MAX
    : 2000;
const MAX_PAGE_SIZE = 100;
const MAX_PRODUCTS = Number.parseInt(String(process.env.MAX_PRODUCTS || '5000'), 10) || 5000;
const MAX_NICKNAME_LEN = 36;
const MAX_SIGNATURE_LEN = 80;
const MAX_UID = Number.parseInt(String(process.env.MAX_UID || '2147483647'), 10);
const SAFE_MAX_UID = Number.isInteger(MAX_UID) && MAX_UID > 0 ? MAX_UID : 2147483647;
const DEFAULT_SIGNATURE =
  '\u8fd9\u4e2a\u4eba\u5f88\u795e\u79d8\uff0c\u6682\u672a\u586b\u5199\u7b7e\u540d';
const PRODUCT_STATUS_SET = new Set(['active', 'inactive', 'draft', 'archived']);
const USER_BATCH_ACTION_SET = new Set([
  'activate',
  'block',
  'soft-delete',
  'restore',
  'revoke-sessions',
]);
const MESSAGE_REVIEW_STATUS_SET = new Set(['approved', 'flagged', 'blocked', 'deleted']);
const MESSAGE_REVIEW_RISK_SET = new Set(['low', 'medium', 'high']);
const MESSAGE_RISK_RULES = [
  {
    id: 'violence',
    label: 'Violence/Threat',
    risk: 'high',
    tags: ['violence'],
    pattern: /(kill|murder|shoot|stab|threat|\u6740|\u5f04\u6b7b|\u7838\u6bc1|\u5a01\u80c1)/i,
  },
  {
    id: 'hate',
    label: 'Hate/Abuse',
    risk: 'high',
    tags: ['hate', 'abuse'],
    pattern: /(hate|racist|slur|nazi|\u6c11\u65cf\u6b67\u89c6|\u4fae\u8fb1|\u4ec7\u6068)/i,
  },
  {
    id: 'fraud',
    label: 'Fraud/Scam',
    risk: 'high',
    tags: ['fraud'],
    pattern: /(scam|fraud|loan shark|ponzi|btc transfer|\u8bd0\u9a97|\u8d37\u6b3e\u9a97\u5c40|\u6d17\u94b1)/i,
  },
  {
    id: 'ads',
    label: 'Spam/Ads',
    risk: 'medium',
    tags: ['spam', 'ads'],
    pattern: /(telegram|whatsapp|vx[:\s]|buy now|discount code|\u5fae\u4fe1|\u4ee3\u7406|\u5237\u5355|\u5e7f\u544a)/i,
  },
  {
    id: 'sensitive',
    label: 'Sensitive Content',
    risk: 'medium',
    tags: ['sensitive'],
    pattern: /(porn|drug|weapon|\u9ec4\u7247|\u6bd2\u54c1|\u67aa\u652f|\u88f8\u804a)/i,
  },
];
const MAX_BATCH_USERS = 200;
const MAX_MESSAGE_REVIEW_NOTE_LEN = 300;
const MAX_MESSAGE_REVIEW_TAGS = 12;
const MAX_SOCIAL_TREE_DEPTH = 4;
const MAX_SOCIAL_TREE_NODES = 1500;
const MAX_SOCIAL_TREE_EDGES = 3500;
const MAX_RELATIONSHIP_ADMIN_LIMIT = 60;
const router = express.Router();
let productsCache = null;
let productsCacheAt = 0;
let productsLoadInFlight = null;
const productsWriteQueue = createSerialQueue({
  maxPending: SAFE_PRODUCTS_WRITE_QUEUE_MAX,
  overflowError: 'products_write_queue_overflow',
});
let productsVersion = 0;
let messageReviewsCache = null;
let messageReviewsLoadInFlight = null;
const messageReviewsWriteQueue = createSerialQueue({
  maxPending: SAFE_MESSAGE_REVIEWS_WRITE_QUEUE_MAX,
  overflowError: 'message_reviews_write_queue_overflow',
});
// asyncRoute?处理 asyncRoute 相关逻辑。
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const trackAdminEvent = (req, payload = {}) => {
  void trackEventSafe(
    createRequestEvent(req, {
      actorUid: 0,
      source: 'admin',
      ...payload,
    })
  );
};
// hasOwn：判断是否具备指定状态。
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// isValidUid：判断条件是否成立。
const isValidUid = (value) => Number.isInteger(value) && value > 0 && value <= SAFE_MAX_UID;
// toPositiveInt?处理 toPositiveInt 相关逻辑。
const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};
// sanitizeText：清洗不可信输入。
const sanitizeText = (value, maxLen = 200) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
// normalizeUserStatus：归一化外部输入。
const normalizeUserStatus = (user) => {
  if (typeof user?.deletedAt === 'string' && user.deletedAt.trim()) return 'deleted';
  if (user?.blocked === true) return 'blocked';
  return 'active';
};
// resolveTokenCount：解析并确定最终值。
const resolveTokenCount = (user) => {
  const list = Array.isArray(user?.tokens)
    ? user.tokens.filter((entry) => entry && typeof entry.token === 'string' && entry.token)
    : [];
  const single = typeof user?.token === 'string' && user.token ? 1 : 0;
  if (!single) return list.length;
  return list.some((entry) => entry.token === user.token) ? list.length : list.length + 1;
};
// toUserSummary?处理 toUserSummary 相关逻辑。
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
// toUserDetail?处理 toUserDetail 相关逻辑。
const buildDepressionRating = (user) => {
  const analysis = user?.aiProfile?.analysis && typeof user.aiProfile.analysis === 'object'
    ? user.aiProfile.analysis
    : null;
  const depression = analysis?.depressionTendency && typeof analysis.depressionTendency === 'object'
    ? analysis.depressionTendency
    : null;
  return {
    level: sanitizeText(depression?.level, 20) || 'unknown',
    score: Number.isFinite(Number(depression?.score)) ? Number(depression.score) : null,
    reason: sanitizeText(depression?.reason, 240),
    riskSignals: extractAiTagNames(analysis?.riskSignals),
  };
};
const buildAiProfileDetail = (user) => {
  const analysis = user?.aiProfile?.analysis && typeof user.aiProfile.analysis === 'object'
    ? user.aiProfile.analysis
    : {};
  return {
    updatedAt: typeof user?.aiProfile?.updatedAt === 'string' ? user.aiProfile.updatedAt : '',
    profileSummary: sanitizeText(analysis?.profileSummary, 1200),
    personalityTraits: extractAiTagNames(analysis?.personalityTraits),
    preferences: extractAiTagNames(analysis?.preferences),
    riskSignals: extractAiTagNames(analysis?.riskSignals),
    depressionTendency: buildDepressionRating(user),
    raw: analysis,
  };
};
const toUserDetail = (user, { recoPersona = null } = {}) => ({
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
  assistantProfile: resolveAssistantProfileFromUser(user),
  aiProfile: buildAiProfileDetail(user),
  depressionRating: buildDepressionRating(user),
  recoPersona: recoPersona || null,
});
const isDefaultAssistantProfile = (profile) =>
  profile.translateStyle === DEFAULT_ASSISTANT_PROFILE.translateStyle &&
  profile.explanationLevel === DEFAULT_ASSISTANT_PROFILE.explanationLevel &&
  profile.replyStyle === DEFAULT_ASSISTANT_PROFILE.replyStyle;
const extractAiTagNames = (input) => {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => {
      if (typeof entry === 'string') return sanitizeText(entry, 80);
      if (entry && typeof entry === 'object') {
        return sanitizeText(entry.name || entry.label || entry.tag || '', 80);
      }
      return '';
    })
    .filter(Boolean);
};
const collectAiTagsForUser = (user) => {
  const analysis = user?.aiProfile?.analysis && typeof user.aiProfile.analysis === 'object'
    ? user.aiProfile.analysis
    : null;
  if (!analysis) return [];
  return Array.from(
    new Set(
      [
        ...extractAiTagNames(analysis.preferences),
        ...extractAiTagNames(analysis.personalityTraits),
        ...extractAiTagNames(analysis.riskSignals),
      ].filter(Boolean)
    )
  ).slice(0, 20);
};
const pickCounterValue = (snapshot, name, predicate = () => true) =>
  (snapshot?.counters || [])
    .filter((entry) => entry?.name === name && predicate(entry?.labels || {}))
    .reduce((sum, entry) => sum + (Number(entry?.value) || 0), 0);
const pickResponseValue = (snapshot, path) =>
  (snapshot?.counters || [])
    .filter(
      (entry) =>
        entry?.name === 'http_responses_total' &&
        String(entry?.labels?.path || '') === String(path || '')
    )
    .reduce((acc, entry) => {
      const statusClass = String(entry?.labels?.statusClass || 'unknown');
      const value = Number(entry?.value) || 0;
      acc.total += value;
      acc.byStatus[statusClass] = (acc.byStatus[statusClass] || 0) + value;
      return acc;
    }, { total: 0, byStatus: {} });
const buildPhase1Overview = ({ users, flags, snapshot }) => {
  const safeUsers = Array.isArray(users) ? users : [];
  const byReplyStyle = { polite: 0, concise: 0, formal: 0 };
  const byTranslateStyle = { formal: 0, casual: 0 };
  const byExplanationLevel = { short: 0, medium: 0, detailed: 0 };
  const tagMap = new Map();
  const samples = [];
  let customizedUsers = 0;
  safeUsers.forEach((user) => {
    const profile = resolveAssistantProfileFromUser(user);
    byReplyStyle[profile.replyStyle] = (byReplyStyle[profile.replyStyle] || 0) + 1;
    byTranslateStyle[profile.translateStyle] = (byTranslateStyle[profile.translateStyle] || 0) + 1;
    byExplanationLevel[profile.explanationLevel] =
      (byExplanationLevel[profile.explanationLevel] || 0) + 1;
    const isCustomized = !isDefaultAssistantProfile(profile);
    if (isCustomized) {
      customizedUsers += 1;
      if (samples.length < 20) {
        samples.push({
          uid: Number(user?.uid) || 0,
          username: String(user?.username || ''),
          nickname: String(user?.nickname || user?.username || ''),
          profile,
        });
      }
    }
    collectAiTagsForUser(user).forEach((tag) => {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    });
  });
  const tagTop = Array.from(tagMap.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([name, count]) => ({ name, count }));
  const requestVolume = {
    replySuggest: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/chat/reply-suggest'
    ),
    chatSend: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/chat/send'
    ),
    translate: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/translate'
    ),
    translateProfileWrite: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/translate/profile' && labels.method === 'POST'
    ),
  };
  return {
    generatedAt: new Date().toISOString(),
    featureEnabled: {
      replyAssistant: Boolean(flags.replyAssistant),
      translatePersonalization: Boolean(flags.translatePersonalization),
    },
    users: {
      total: safeUsers.length,
      customizedUsers,
      defaultUsers: Math.max(0, safeUsers.length - customizedUsers),
      byReplyStyle,
      byTranslateStyle,
      byExplanationLevel,
    },
    requestVolume,
    responses: {
      replySuggest: pickResponseValue(snapshot, '/api/chat/reply-suggest'),
      translate: pickResponseValue(snapshot, '/api/translate'),
      translateProfile: pickResponseValue(snapshot, '/api/translate/profile'),
    },
    topTags: tagTop,
    samples,
  };
};
const buildPhase4Overview = async ({ snapshot }) => {
  const summary = await getSummaryAdminOverview({ limit: 30 });
  const requestVolume = {
    summaryRead: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/summary' && labels.method === 'GET'
    ),
    summaryRefresh: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/summary/refresh' && labels.method === 'POST'
    ),
    summaryArchive: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/summary/archive' && labels.method === 'POST'
    ),
    chatOverview: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/chat/overview' && labels.method === 'POST'
    ),
  };
  return {
    generatedAt: new Date().toISOString(),
    featureEnabled: {
      summaryCenter: Boolean(isFeatureEnabled('summaryCenter')),
    },
    requestVolume,
    responses: {
      summaryRead: pickResponseValue(snapshot, '/api/summary'),
      summaryRefresh: pickResponseValue(snapshot, '/api/summary/refresh'),
      summaryArchive: pickResponseValue(snapshot, '/api/summary/archive'),
      chatOverview: pickResponseValue(snapshot, '/api/chat/overview'),
    },
    summary,
  };
};
const buildPhase5Overview = async ({ snapshot }) => {
  const reco = await getRecoAdminOverview({ limit: 180, windowHours: 24 });
  const requestVolume = {
    recoDecision: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/reco/decision' && labels.method === 'POST'
    ),
    recoFeedback: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/reco/feedback' && labels.method === 'POST'
    ),
    recoAdmin: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/reco/admin' && labels.method === 'GET'
    ),
    chatOverview: pickCounterValue(
      snapshot,
      'http_requests_total',
      (labels) => labels.path === '/api/chat/overview' && labels.method === 'POST'
    ),
  };
  return {
    generatedAt: new Date().toISOString(),
    featureEnabled: {
      recoVw: Boolean(isFeatureEnabled('recoVw')),
      recoVwShadow: Boolean(isFeatureEnabled('recoVwShadow')),
      recoVwOnline: Boolean(isFeatureEnabled('recoVwOnline')),
    },
    requestVolume,
    responses: {
      recoDecision: pickResponseValue(snapshot, '/api/reco/decision'),
      recoFeedback: pickResponseValue(snapshot, '/api/reco/feedback'),
      recoAdmin: pickResponseValue(snapshot, '/api/reco/admin'),
      chatOverview: pickResponseValue(snapshot, '/api/chat/overview'),
    },
    reco,
  };
};
const buildGroupMembershipCountMap = (groups = []) => {
  const map = new Map();
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    normalizeUidArray(group?.memberUids).forEach((uid) => {
      map.set(uid, (map.get(uid) || 0) + 1);
    });
  });
  return map;
};
const buildRelationshipViewerSelector = (users = [], groups = [], selectedUid = 0) => {
  const membershipMap = buildGroupMembershipCountMap(groups);
  const items = (Array.isArray(users) ? users : [])
    .map((user) => {
      const uid = Number(user?.uid);
      if (!isValidUid(uid)) return null;
      const friendsCount = normalizeUidArray(user?.friends).length;
      const groupsCount = Number(membershipMap.get(uid) || 0);
      return {
        uid,
        username: String(user?.username || ''),
        nickname: String(user?.nickname || user?.username || ''),
        friendsCount,
        groupsCount,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.friendsCount - a.friendsCount ||
        b.groupsCount - a.groupsCount ||
        a.uid - b.uid
    );
  const selected =
    items.find((item) => item.uid === Number(selectedUid)) ||
    items.find((item) => item.friendsCount > 0 || item.groupsCount > 0) ||
    items[0] ||
    null;
  return {
    selectedUid: selected ? selected.uid : 0,
    users: items.slice(0, 80),
  };
};
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
const normalizeUidArray = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => Number(item))
        .filter((item) => isValidUid(item))
    )
  );
const buildUsersLookup = (users) => {
  const map = new Map();
  (Array.isArray(users) ? users : []).forEach((user) => {
    const uid = Number(user?.uid);
    if (!isValidUid(uid)) return;
    map.set(uid, user);
  });
  return map;
};
const buildMutualAdjacency = (users) => {
  const userMap = buildUsersLookup(users);
  const adjacency = new Map();
  const oneWayEdges = [];
  const mutualEdgeSet = new Set();
  const ensureSet = (uid) => {
    if (!adjacency.has(uid)) adjacency.set(uid, new Set());
    return adjacency.get(uid);
  };
  userMap.forEach((user, uid) => {
    ensureSet(uid);
    const list = normalizeUidArray(user?.friends);
    list.forEach((friendUid) => {
      if (!userMap.has(friendUid) || friendUid === uid) return;
      const peer = userMap.get(friendUid);
      const peerFriends = normalizeUidArray(peer?.friends);
      if (peerFriends.includes(uid)) {
        const minUid = Math.min(uid, friendUid);
        const maxUid = Math.max(uid, friendUid);
        const edgeKey = `${minUid}-${maxUid}`;
        if (!mutualEdgeSet.has(edgeKey)) {
          mutualEdgeSet.add(edgeKey);
          ensureSet(minUid).add(maxUid);
          ensureSet(maxUid).add(minUid);
        }
      } else {
        oneWayEdges.push({ fromUid: uid, toUid: friendUid });
      }
    });
  });
  return {
    adjacency,
    oneWayEdges,
    mutualEdges: Array.from(mutualEdgeSet).map((key) => {
      const [fromUid, toUid] = key.split('-').map((item) => Number(item));
      return { fromUid, toUid };
    }),
  };
};
const computeConnectedComponents = (adjacency) => {
  const visited = new Set();
  const components = [];
  Array.from(adjacency.keys()).forEach((uid) => {
    if (visited.has(uid)) return;
    const queue = [uid];
    visited.add(uid);
    let size = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      size += 1;
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      neighbors.forEach((neighborUid) => {
        if (visited.has(neighborUid)) return;
        visited.add(neighborUid);
        queue.push(neighborUid);
      });
    }
    components.push(size);
  });
  components.sort((a, b) => b - a);
  return components;
};
const buildSocialOverview = ({ users, groups }) => {
  const safeUsers = Array.isArray(users) ? users : [];
  const safeGroups = Array.isArray(groups) ? groups : [];
  const userMap = buildUsersLookup(safeUsers);
  const { adjacency, oneWayEdges, mutualEdges } = buildMutualAdjacency(safeUsers);
  const components = computeConnectedComponents(adjacency);
  const friendCounts = [];
  let isolatedUsers = 0;
  const topUsers = [];
  userMap.forEach((user, uid) => {
    const friends = adjacency.get(uid);
    const friendCount = friends ? friends.size : 0;
    friendCounts.push(friendCount);
    if (friendCount === 0) isolatedUsers += 1;
    topUsers.push({
      uid,
      username: String(user?.username || ''),
      nickname: String(user?.nickname || user?.username || ''),
      friendCount,
    });
  });
  topUsers.sort((a, b) => b.friendCount - a.friendCount || a.uid - b.uid);
  const groupItems = [];
  let groupMemberTotal = 0;
  let usersWithGroup = 0;
  const userInGroupSet = new Set();
  safeGroups.forEach((group) => {
    const gid = Number(group?.id);
    if (!Number.isInteger(gid) || gid <= 0) return;
    const memberUids = normalizeUidArray(group?.memberUids).filter((uid) => userMap.has(uid));
    if (memberUids.length === 0) return;
    memberUids.forEach((uid) => userInGroupSet.add(uid));
    groupMemberTotal += memberUids.length;
    groupItems.push({
      id: gid,
      name: sanitizeText(group?.name, 80) || `群聊${gid}`,
      memberCount: memberUids.length,
    });
  });
  usersWithGroup = userInGroupSet.size;
  const noSocialUsers = safeUsers.filter((user) => {
    const uid = Number(user?.uid);
    if (!isValidUid(uid)) return false;
    const friendCount = adjacency.get(uid)?.size || 0;
    const inGroup = userInGroupSet.has(uid);
    return friendCount === 0 && !inGroup;
  }).length;
  groupItems.sort((a, b) => b.memberCount - a.memberCount || a.id - b.id);
  friendCounts.sort((a, b) => a - b);
  const medianFriendCount =
    friendCounts.length === 0
      ? 0
      : friendCounts.length % 2 === 1
        ? friendCounts[Math.floor(friendCounts.length / 2)]
        : (friendCounts[friendCounts.length / 2 - 1] + friendCounts[friendCounts.length / 2]) / 2;
  const friendCountSum = friendCounts.reduce((sum, value) => sum + value, 0);
  const avgFriendCount = friendCounts.length ? Number((friendCountSum / friendCounts.length).toFixed(2)) : 0;
  const avgGroupSize = groupItems.length ? Number((groupMemberTotal / groupItems.length).toFixed(2)) : 0;
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      users: userMap.size,
      groups: groupItems.length,
      mutualFriendEdges: mutualEdges.length,
      oneWayFriendEdges: oneWayEdges.length,
      isolatedUsers,
      noSocialUsers,
      usersWithGroup,
      groupMemberships: groupMemberTotal,
    },
    metrics: {
      avgFriendCount,
      medianFriendCount,
      avgGroupSize,
      connectedComponents: components.length,
      largestComponentSize: components[0] || 0,
    },
    topUsers: topUsers.slice(0, 12),
    topGroups: groupItems.slice(0, 12),
    componentSizes: components.slice(0, 10),
    usersCache: getUsersCacheInfo(),
  };
};
const buildSocialTree = ({ rootUid, depth, includeGroups, users, groups }) => {
  if (!isValidUid(rootUid)) return null;
  const safeDepth = toPositiveInt(depth, 2, 1, MAX_SOCIAL_TREE_DEPTH);
  const safeIncludeGroups = Boolean(includeGroups);
  const safeUsers = Array.isArray(users) ? users : [];
  const safeGroups = Array.isArray(groups) ? groups : [];
  const userMap = buildUsersLookup(safeUsers);
  const rootUser = userMap.get(rootUid);
  if (!rootUser) return null;
  const { adjacency } = buildMutualAdjacency(safeUsers);
  const nodes = [];
  const edges = [];
  const nodeKeys = new Set();
  const edgeKeys = new Set();
  const levelMap = new Map();
  const pushNode = (node) => {
    if (!node || !node.id || nodeKeys.has(node.id)) return;
    if (nodes.length >= MAX_SOCIAL_TREE_NODES) return;
    nodeKeys.add(node.id);
    nodes.push(node);
  };
  const pushEdge = (edge) => {
    if (!edge || !edge.from || !edge.to) return;
    const key = `${edge.type}:${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) return;
    if (edges.length >= MAX_SOCIAL_TREE_EDGES) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  const toUserNode = (uid, level) => {
    const user = userMap.get(uid);
    return {
      id: `u:${uid}`,
      type: 'user',
      uid,
      label: sanitizeText(user?.nickname || user?.username || `用户${uid}`, 64),
      username: sanitizeText(user?.username, 64),
      level,
      friendCount: adjacency.get(uid)?.size || 0,
      online: user?.online === true,
    };
  };
  const queue = [{ uid: rootUid, level: 0 }];
  levelMap.set(rootUid, 0);
  pushNode(toUserNode(rootUid, 0));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.level >= safeDepth) continue;
    const neighbors = adjacency.get(current.uid) || new Set();
    Array.from(neighbors).forEach((nextUid) => {
      if (!userMap.has(nextUid)) return;
      const nextLevel = current.level + 1;
      const prevLevel = levelMap.get(nextUid);
      if (typeof prevLevel !== 'number' || nextLevel < prevLevel) {
        levelMap.set(nextUid, nextLevel);
      }
      pushNode(toUserNode(nextUid, levelMap.get(nextUid) || nextLevel));
      const minUid = Math.min(current.uid, nextUid);
      const maxUid = Math.max(current.uid, nextUid);
      pushEdge({
        id: `f:${minUid}-${maxUid}`,
        type: 'friend',
        from: `u:${minUid}`,
        to: `u:${maxUid}`,
      });
      if (typeof prevLevel !== 'number' && nodes.length < MAX_SOCIAL_TREE_NODES) {
        queue.push({ uid: nextUid, level: nextLevel });
      }
    });
    if (nodes.length >= MAX_SOCIAL_TREE_NODES || edges.length >= MAX_SOCIAL_TREE_EDGES) break;
  }
  const discoveredUids = new Set(
    nodes
      .filter((item) => item.type === 'user')
      .map((item) => Number(item.uid))
      .filter((uid) => isValidUid(uid))
  );
  if (safeIncludeGroups && discoveredUids.size > 0) {
    safeGroups.forEach((group) => {
      if (nodes.length >= MAX_SOCIAL_TREE_NODES || edges.length >= MAX_SOCIAL_TREE_EDGES) return;
      const gid = Number(group?.id);
      if (!Number.isInteger(gid) || gid <= 0) return;
      const memberUids = normalizeUidArray(group?.memberUids).filter((uid) => discoveredUids.has(uid));
      if (!memberUids.length) return;
      const groupNodeId = `g:${gid}`;
      pushNode({
        id: groupNodeId,
        type: 'group',
        gid,
        label: sanitizeText(group?.name, 80) || `群聊${gid}`,
        level: Math.max(
          0,
          ...memberUids.map((uid) => Number(levelMap.get(uid) || 0))
        ),
        memberCount: normalizeUidArray(group?.memberUids).length,
      });
      memberUids.forEach((uid) => {
        pushEdge({
          id: `gm:${gid}-${uid}`,
          type: 'group_member',
          from: `u:${uid}`,
          to: groupNodeId,
        });
      });
    });
  }
  const levelSummary = {};
  nodes.forEach((node) => {
    const level = Number(node?.level) || 0;
    levelSummary[level] = (levelSummary[level] || 0) + 1;
  });
  return {
    generatedAt: new Date().toISOString(),
    rootUid,
    depth: safeDepth,
    includeGroups: safeIncludeGroups,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      userNodes: nodes.filter((item) => item.type === 'user').length,
      groupNodes: nodes.filter((item) => item.type === 'group').length,
      levelSummary,
      truncated:
        nodes.length >= MAX_SOCIAL_TREE_NODES || edges.length >= MAX_SOCIAL_TREE_EDGES,
    },
    nodes,
    edges,
  };
};
// cloneValue?处理 cloneValue 相关逻辑。
const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};
// normalizeProductStatus：归一化外部输入。
const normalizeProductStatus = (value, fallback = 'draft') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (PRODUCT_STATUS_SET.has(normalized)) return normalized;
  return fallback;
};
// normalizeTags：归一化外部输入。
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
// normalizeProductRecord：归一化外部输入。
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
// setProductsCache：设置运行时状态。
const setProductsCache = (products, timestamp = Date.now()) => {
  productsCache = Array.isArray(products) ? products : [];
  productsCacheAt = timestamp;
  productsVersion += 1;
};
// ensureProductsStorage：确保前置条件与资源可用。
const ensureProductsStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(PRODUCTS_PATH);
  } catch {
    await atomicWriteFile(PRODUCTS_PATH, '[]', {
      lockPath: PRODUCTS_LOCK_PATH,
    });
  }
};
// queueProductsWriteTask：将任务按顺序排队处理。
const queueProductsWriteTask = async (task) => {
  return productsWriteQueue.enqueue(task);
};
// persistProductsSnapshot?处理 persistProductsSnapshot 相关逻辑。
const persistProductsSnapshot = async (snapshot) => {
  await atomicWriteFile(PRODUCTS_PATH, JSON.stringify(snapshot, null, 2), {
    lockPath: PRODUCTS_LOCK_PATH,
  });
  setProductsCache(snapshot, Date.now());
};
// loadProductsFromDisk?处理 loadProductsFromDisk 相关逻辑。
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
// readProductsCached：读取持久化或缓存数据。
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
// mutateProducts?处理 mutateProducts 相关逻辑。
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
// getNextProductId：获取并返回目标数据。
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
// buildProductsCacheInfo：构建对外输出数据。
const buildProductsCacheInfo = () => ({
  version: productsVersion,
  cachedAt: productsCacheAt ? new Date(productsCacheAt).toISOString() : null,
  ageMs: productsCacheAt ? Math.max(0, Date.now() - productsCacheAt) : null,
});
// aggregateSlowEndpoints?处理 aggregateSlowEndpoints 相关逻辑。
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
// aggregateErrorEndpoints?处理 aggregateErrorEndpoints 相关逻辑。
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
const normalizeMessageReviewStatus = (value) => {
  const status = sanitizeText(value, 24).toLowerCase();
  return MESSAGE_REVIEW_STATUS_SET.has(status) ? status : '';
};
const normalizeMessageReviewRiskLevel = (value) => {
  const riskLevel = sanitizeText(value, 24).toLowerCase();
  return MESSAGE_REVIEW_RISK_SET.has(riskLevel) ? riskLevel : '';
};
const normalizeMessageReviewTags = (value) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(
    new Set(
      list
        .map((item) => sanitizeText(item, 24).toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_MESSAGE_REVIEW_TAGS)
    )
  );
};
const parseIsoTimestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : '';
};
const normalizeMessageReviewRecord = (messageId, record) => {
  if (typeof messageId !== 'string' || !messageId.trim()) return null;
  if (!record || typeof record !== 'object') return null;
  const id = messageId.trim();
  const status = normalizeMessageReviewStatus(record.status);
  if (!status) return null;
  const riskLevel = normalizeMessageReviewRiskLevel(record.riskLevel) || 'low';
  const reviewedAt = parseIsoTimestamp(record.reviewedAt) || new Date().toISOString();
  const reviewer = sanitizeText(record.reviewer, 64);
  const reason = sanitizeText(record.reason, MAX_MESSAGE_REVIEW_NOTE_LEN);
  const tags = normalizeMessageReviewTags(record.tags);
  const historyRaw = Array.isArray(record.history) ? record.history : [];
  const history = historyRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const entryStatus = normalizeMessageReviewStatus(entry.status);
      if (!entryStatus) return null;
      return {
        status: entryStatus,
        riskLevel: normalizeMessageReviewRiskLevel(entry.riskLevel) || 'low',
        reviewer: sanitizeText(entry.reviewer, 64),
        reason: sanitizeText(entry.reason, MAX_MESSAGE_REVIEW_NOTE_LEN),
        tags: normalizeMessageReviewTags(entry.tags),
        reviewedAt: parseIsoTimestamp(entry.reviewedAt) || reviewedAt,
      };
    })
    .filter(Boolean)
    .slice(-30);
  return {
    messageId: id,
    status,
    riskLevel,
    reviewer,
    reason,
    tags,
    reviewedAt,
    history,
  };
};
const ensureMessageReviewsStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(MESSAGE_REVIEWS_PATH);
  } catch {
    const seed = { version: 1, updatedAt: '', records: {} };
    await atomicWriteFile(MESSAGE_REVIEWS_PATH, JSON.stringify(seed, null, 2), {
      lockPath: MESSAGE_REVIEWS_LOCK_PATH,
    });
  }
};
const queueMessageReviewsWriteTask = async (task) => {
  return messageReviewsWriteQueue.enqueue(task);
};
const loadMessageReviewsFromDisk = async () => {
  await ensureMessageReviewsStorage();
  const raw = await fs.readFile(MESSAGE_REVIEWS_PATH, 'utf-8');
  const parsed = JSON.parse(raw || '{}');
  const recordsSource = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
  const records = {};
  Object.entries(recordsSource).forEach(([messageId, record]) => {
    const normalized = normalizeMessageReviewRecord(messageId, record);
    if (normalized) {
      records[messageId] = normalized;
    }
  });
  messageReviewsCache = {
    version: 1,
    updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
    records,
  };
  return messageReviewsCache;
};
const persistMessageReviewsSnapshot = async (snapshot) => {
  const normalized = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: snapshot?.records && typeof snapshot.records === 'object' ? snapshot.records : {},
  };
  await atomicWriteFile(MESSAGE_REVIEWS_PATH, JSON.stringify(normalized, null, 2), {
    lockPath: MESSAGE_REVIEWS_LOCK_PATH,
  });
  messageReviewsCache = normalized;
};
const readMessageReviewsCached = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh && messageReviewsCache) {
    return messageReviewsCache;
  }
  if (messageReviewsLoadInFlight) {
    await messageReviewsLoadInFlight;
    return messageReviewsCache || { version: 1, updatedAt: '', records: {} };
  }
  messageReviewsLoadInFlight = queueMessageReviewsWriteTask(() => loadMessageReviewsFromDisk())
    .catch(async () => {
      await ensureMessageReviewsStorage();
      messageReviewsCache = { version: 1, updatedAt: '', records: {} };
    })
    .finally(() => {
      messageReviewsLoadInFlight = null;
    });
  await messageReviewsLoadInFlight;
  return messageReviewsCache || { version: 1, updatedAt: '', records: {} };
};
const mutateMessageReviews = async (mutator, { defaultChanged = true } = {}) => {
  if (typeof mutator !== 'function') {
    throw new TypeError('mutateMessageReviews requires a function mutator.');
  }
  await ensureMessageReviewsStorage();
  await readMessageReviewsCached();
  let changed = defaultChanged;
  let result = null;
  await queueMessageReviewsWriteTask(async () => {
    const working = cloneValue(messageReviewsCache || { version: 1, updatedAt: '', records: {} });
    const output = await mutator(working);
    if (output && typeof output === 'object' && hasOwn(output, 'changed')) {
      changed = Boolean(output.changed);
      result = output.result;
    } else {
      result = output;
    }
    if (changed) {
      await persistMessageReviewsSnapshot(working);
    } else {
      messageReviewsCache = working;
    }
  });
  return { changed, result };
};
const getMessageAuditText = (message) => {
  const data = message?.data && typeof message.data === 'object' ? message.data : {};
  const parts = [];
  if (typeof data.content === 'string' && data.content.trim()) parts.push(data.content.trim());
  if (typeof data.text === 'string' && data.text.trim()) parts.push(data.text.trim());
  if (typeof data.caption === 'string' && data.caption.trim()) parts.push(data.caption.trim());
  if (typeof data.name === 'string' && data.name.trim()) parts.push(data.name.trim());
  if (!parts.length && typeof message?.preview === 'string') {
    parts.push(message.preview.trim());
  }
  return parts.join(' ').trim();
};
const riskRank = (value) => {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
};
const inspectMessageRisk = (message) => {
  const text = getMessageAuditText(message);
  if (!text) {
    return { textSample: '', autoRiskLevel: 'low', hitRules: [] };
  }
  let autoRiskLevel = 'low';
  const hitRules = [];
  MESSAGE_RISK_RULES.forEach((rule) => {
    if (!rule.pattern.test(text)) return;
    hitRules.push({
      id: rule.id,
      label: rule.label,
      risk: rule.risk,
      tags: Array.isArray(rule.tags) ? rule.tags : [],
    });
    if (riskRank(rule.risk) > riskRank(autoRiskLevel)) {
      autoRiskLevel = rule.risk;
    }
  });
  return {
    textSample: text.slice(0, 220),
    autoRiskLevel,
    hitRules,
  };
};
const attachMessageAudit = (message, reviewsMap) => {
  const review = reviewsMap?.[message.id] || null;
  const inspection = inspectMessageRisk(message);
  const reviewStatus = review?.status || 'unreviewed';
  const riskLevel = normalizeMessageReviewRiskLevel(review?.riskLevel) || inspection.autoRiskLevel;
  return {
    ...message,
    reviewStatus,
    riskLevel,
    review,
    inspection,
  };
};
const summarizeMessageReviewRecords = (records) => {
  const list = Object.values(records || {});
  const byStatus = { approved: 0, flagged: 0, blocked: 0, deleted: 0 };
  const byRisk = { low: 0, medium: 0, high: 0 };
  list.forEach((item) => {
    const status = normalizeMessageReviewStatus(item?.status);
    if (status) {
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    const risk = normalizeMessageReviewRiskLevel(item?.riskLevel) || 'low';
    byRisk[risk] = (byRisk[risk] || 0) + 1;
  });
  return {
    totalReviewed: list.length,
    byStatus,
    byRisk,
  };
};
const applyUserBatchAction = (user, action, nowIso) => {
  const next = { ...user };
  let changed = false;
  const clearSessions = () => {
    const tokenCount = resolveTokenCount(next);
    if (tokenCount > 0 || next.online === true) {
      changed = true;
    }
    next.online = false;
    next.tokens = [];
    next.token = null;
    next.tokenExpiresAt = null;
  };
  if (action === 'activate' || action === 'restore') {
    if (next.blocked === true) {
      next.blocked = false;
      changed = true;
    }
    if (typeof next.deletedAt === 'string' && next.deletedAt) {
      next.deletedAt = '';
      changed = true;
    }
    return { changed, user: next };
  }
  if (action === 'block') {
    if (next.blocked !== true) {
      next.blocked = true;
      changed = true;
    }
    clearSessions();
    return { changed, user: next };
  }
  if (action === 'soft-delete') {
    if (!next.deletedAt) {
      next.deletedAt = nowIso;
      changed = true;
    }
    if (next.blocked !== true) {
      next.blocked = true;
      changed = true;
    }
    clearSessions();
    return { changed, user: next };
  }
  if (action === 'revoke-sessions') {
    clearSessions();
    return { changed, user: next };
  }
  return { changed: false, user: next };
};
const buildMessageReviewRecord = ({
  current,
  messageId,
  status,
  riskLevel,
  reason,
  tags,
  reviewer,
  reviewedAt = new Date().toISOString(),
}) => {
  const nextHistory = Array.isArray(current?.history) ? [...current.history] : [];
  nextHistory.push({
    status,
    riskLevel,
    reason,
    tags,
    reviewer,
    reviewedAt,
  });
  return {
    messageId,
    status,
    riskLevel,
    reason,
    tags,
    reviewer,
    reviewedAt,
    history: nextHistory.slice(-30),
  };
};
router.use(requireAdminAccess);
router.get(
  '/feature-flags',
  asyncRoute(async (_req, res) => {
    const flags = getFeatureFlagsSnapshot();
    const definitions = getFeatureFlagDetails();
    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        flags,
        definitions,
        runtime: getFeatureFlagRuntimeState(),
      },
    });
  })
);
router.post(
  '/feature-flags/update',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const actor =
      sanitizeText(req?.admin?.username, 80) ||
      sanitizeText(req.headers?.['x-admin-user'], 80) ||
      'admin';
    const changes = payload?.changes && typeof payload.changes === 'object' ? payload.changes : null;
    if (changes) {
      const normalizedChanges = {};
      Object.entries(changes).forEach(([name, value]) => {
        if (!hasOwn(FEATURE_DEFINITIONS, name)) return;
        if (value === null || typeof value === 'undefined') {
          normalizedChanges[name] = null;
          return;
        }
        normalizedChanges[name] = Boolean(value);
      });
      const updated = await bulkUpdateFeatureFlagOverrides(normalizedChanges, { actor });
      trackAdminEvent(req, {
        eventType: 'click',
        targetType: 'feature_flag',
        tags: ['feature_flag_batch_update'],
        metadata: {
          actor,
          changed: updated.length,
          names: updated.map((item) => item.name),
        },
      });
      res.json({
        success: true,
        data: {
          updated,
          flags: getFeatureFlagsSnapshot(),
          definitions: getFeatureFlagDetails(),
          runtime: getFeatureFlagRuntimeState(),
        },
      });
      return;
    }
    const name = sanitizeText(payload?.name, 60);
    if (!name || !hasOwn(FEATURE_DEFINITIONS, name)) {
      res.status(400).json({ success: false, message: 'Invalid feature flag name.' });
      return;
    }
    let enabled = null;
    if (payload?.clearOverride === true || payload?.enabled === null) {
      enabled = null;
    } else if (typeof payload?.enabled === 'boolean') {
      enabled = payload.enabled;
    } else if (typeof payload?.override === 'boolean') {
      enabled = payload.override;
    } else {
      res.status(400).json({ success: false, message: 'enabled must be boolean or null.' });
      return;
    }
    const updated = await setFeatureFlagOverride(name, enabled, { actor });
    trackAdminEvent(req, {
      eventType: 'click',
      targetType: 'feature_flag',
      tags: ['feature_flag_update', name],
      metadata: {
        actor,
        enabled: updated.enabled,
        override: updated.override,
      },
    });
    res.json({
      success: true,
      data: {
        updated,
        flags: getFeatureFlagsSnapshot(),
        definitions: getFeatureFlagDetails(),
        runtime: getFeatureFlagRuntimeState(),
      },
    });
  })
);
router.get(
  '/events/summary',
  asyncRoute(async (_req, res) => {
    const loggerSummary = await getEventLoggerStats();
    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        logger: loggerSummary,
      },
    });
  })
);
// 路由：GET /phase1/overview。
router.get(
  '/phase1/overview',
  asyncRoute(async (_req, res) => {
    const users = await readUsersCached();
    const flags = getFeatureFlagsSnapshot();
    const snapshot = metrics.snapshot();
    res.json({
      success: true,
      data: buildPhase1Overview({
        users,
        flags,
        snapshot,
      }),
    });
  })
);
router.get(
  '/phase4/overview',
  asyncRoute(async (_req, res) => {
    const snapshot = metrics.snapshot();
    const data = await buildPhase4Overview({ snapshot });
    res.json({
      success: true,
      data,
    });
  })
);
router.get(
  '/phase5/overview',
  asyncRoute(async (_req, res) => {
    const snapshot = metrics.snapshot();
    const data = await buildPhase5Overview({ snapshot });
    res.json({
      success: true,
      data,
    });
  })
);
router.post(
  '/phase5/config',
  asyncRoute(async (req, res) => {
    const actor =
      sanitizeText(req?.admin?.username, 80) ||
      sanitizeText(req.headers?.['x-admin-user'], 80) ||
      'admin';
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await updateRecoAdminConfig(patch, { actor });
    trackAdminEvent(req, {
      eventType: 'click',
      targetType: 'phase5',
      tags: ['phase5_config_update'],
      metadata: {
        actor,
      },
    });
    res.json({
      success: true,
      data,
    });
  })
);
// 路由：GET /users/summary。
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
// 路由：GET /users。
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
// 路由：GET /users/detail。
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
    const recoPersona = await getRecoUserPersona(uid);
    res.json({ success: true, data: toUserDetail(user, { recoPersona }) });
  })
);
// 路由：POST /users/update。
router.get(
  '/social/overview',
  asyncRoute(async (_req, res) => {
    const [users, groups] = await Promise.all([readUsersCached(), readGroups()]);
    const overview = buildSocialOverview({ users, groups });
    res.json({ success: true, data: overview });
  })
);
router.get(
  '/social/tree',
  asyncRoute(async (req, res) => {
    const uid = Number(req.query?.uid);
    if (!isValidUid(uid)) {
      res.status(400).json({ success: false, message: 'Invalid uid.' });
      return;
    }
    const depth = toPositiveInt(req.query?.depth, 2, 1, MAX_SOCIAL_TREE_DEPTH);
    const includeGroups = toBoolean(req.query?.includeGroups, true);
    const [users, groups] = await Promise.all([readUsersCached(), readGroups()]);
    const tree = buildSocialTree({
      rootUid: uid,
      depth,
      includeGroups,
      users,
      groups,
    });
    if (!tree) {
      res.status(404).json({ success: false, message: 'User not found.' });
      return;
    }
    trackAdminEvent(req, {
      eventType: 'impression',
      targetUid: uid,
      targetType: 'social_tree',
      tags: ['social_tree', `depth_${depth}`, includeGroups ? 'with_group' : 'user_only'],
      metadata: {
        nodes: Number(tree?.summary?.nodes) || 0,
        edges: Number(tree?.summary?.edges) || 0,
      },
    });
    res.json({ success: true, data: tree });
  })
);
router.get(
  '/ops/relationship',
  asyncRoute(async (req, res) => {
    const requestedUid = Number(req.query?.uid);
    const scope = normalizeScope(req.query?.scope);
    const windowDays = normalizeWindowDays(req.query?.windowDays);
    const limit = toPositiveInt(req.query?.limit, 20, 1, MAX_RELATIONSHIP_ADMIN_LIMIT);
    const includeStable = toBoolean(req.query?.includeStable, false);
    const [users, groups] = await Promise.all([readUsersCached(), readGroups()]);
    const selector = buildRelationshipViewerSelector(users, groups, requestedUid);
    const selectedUid = Number(selector.selectedUid) || 0;
    const selectedUser = users.find((item) => Number(item?.uid) === selectedUid) || null;
    const generatedAt = new Date().toISOString();
    if (!selectedUser) {
      res.json({
        success: true,
        data: {
          enabled: Boolean(isFeatureEnabled('relationshipOps')),
          available: false,
          selectedUid: 0,
          selector,
          generatedAt,
          scope,
          windowDays,
          summary: {
            totalCandidates: 0,
            totalDeclined: 0,
            inactive7d: 0,
            privateCount: 0,
            groupCount: 0,
          },
          items: [],
        },
      });
      return;
    }
    if (!isFeatureEnabled('relationshipOps')) {
      res.json({
        success: true,
        data: {
          enabled: false,
          available: true,
          selectedUid,
          selector,
          generatedAt,
          scope,
          windowDays,
          summary: {
            totalCandidates: 0,
            totalDeclined: 0,
            inactive7d: 0,
            privateCount: 0,
            groupCount: 0,
          },
          items: [],
        },
      });
      return;
    }
    const database = await getChatDatabaseForOps();
    const snapshot = buildRelationshipOpsSnapshot({
      database,
      user: selectedUser,
      users,
      groups,
      options: {
        scope,
        windowDays,
        limit,
        includeStable,
      },
    });
    trackAdminEvent(req, {
      eventType: 'impression',
      targetUid: selectedUid,
      targetType: 'admin_relationship_ops',
      tags: ['admin_relationship_ops', scope, 'window_' + windowDays],
      metadata: {
        limit,
        includeStable,
        items: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      },
    });
    res.json({
      success: true,
      data: {
        enabled: true,
        available: true,
        selectedUid,
        selector,
        ...snapshot,
      },
    });
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
// 路由：POST /users/revoke-all。
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
// 路由：POST /users/soft-delete。
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
// 路由：GET /products/summary。
router.post(
  '/users/batch-action',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const action = sanitizeText(payload.action, 32).toLowerCase();
    if (!USER_BATCH_ACTION_SET.has(action)) {
      res.status(400).json({ success: false, message: 'Invalid batch action.' });
      return;
    }
    const source = Array.isArray(payload.uids) ? payload.uids : [];
    const uids = Array.from(
      new Set(
        source
          .map((value) => Number(value))
          .filter((uid) => isValidUid(uid))
          .slice(0, MAX_BATCH_USERS)
      )
    );
    if (!uids.length) {
      res.status(400).json({ success: false, message: 'uids is required.' });
      return;
    }
    const nowIso = new Date().toISOString();
    const mutation = await mutateUsers(
      (users) => {
        const updated = [];
        const skipped = [];
        let changed = false;
        uids.forEach((uid) => {
          const index = users.findIndex((item) => item.uid === uid);
          if (index < 0) {
            skipped.push(uid);
            return;
          }
          const output = applyUserBatchAction(users[index], action, nowIso);
          if (!output.changed) {
            updated.push({ uid, changed: false, status: normalizeUserStatus(users[index]) });
            return;
          }
          users[index] = output.user;
          changed = true;
          updated.push({ uid, changed: true, status: normalizeUserStatus(output.user) });
        });
        return { changed, result: { action, updated, skipped } };
      },
      { defaultChanged: false }
    );
    res.json({
      success: true,
      data: {
        action,
        requested: uids.length,
        changed: mutation.result?.updated?.filter((entry) => entry.changed).length || 0,
        updated: mutation.result?.updated || [],
        skipped: mutation.result?.skipped || [],
      },
    });
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
// 路由：GET /products。
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
// 路由：POST /products/create。
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
// 路由：POST /products/update。
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
// 路由：DELETE /products/delete。
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
// 路由：GET /bottlenecks。
router.get(
  '/messages/summary',
  asyncRoute(async (req, res) => {
    const windowHours = toPositiveInt(req.query?.windowHours, 24, 1, 24 * 365);
    const [messageSummary, reviews] = await Promise.all([
      summarizeMessagesForAdmin({ windowHours }),
      readMessageReviewsCached(),
    ]);
    const reviewSummary = summarizeMessageReviewRecords(reviews.records);
    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        messages: messageSummary,
        reviews: reviewSummary,
      },
    });
  })
);
router.get(
  '/risk/overview',
  asyncRoute(async (req, res) => {
    const limit = toPositiveInt(req.query?.limit, 120, 10, 500);
    const overview = await getRiskAdminOverview({ limit });
    res.json({
      success: true,
      data: {
        featureEnabled: isFeatureEnabled('riskGuard'),
        profileRuntime: getRiskProfileRuntimeStats(),
        ...overview,
      },
    });
  })
);
router.get(
  '/reco/overview',
  asyncRoute(async (req, res) => {
    const limit = toPositiveInt(req.query?.limit, 180, 20, 600);
    const windowHours = toPositiveInt(req.query?.windowHours, 24, 1, 24 * 30);
    const data = await getRecoAdminOverview({ limit, windowHours });
    res.json({
      success: true,
      data,
    });
  })
);
router.post(
  '/reco/config',
  asyncRoute(async (req, res) => {
    const actor =
      sanitizeText(req?.admin?.username, 80) ||
      sanitizeText(req.headers?.['x-admin-user'], 80) ||
      'admin';
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await updateRecoAdminConfig(patch, { actor });
    trackAdminEvent(req, {
      eventType: 'click',
      targetType: 'reco_config',
      tags: ['reco_admin_config_update'],
      metadata: {
        actor,
      },
    });
    res.json({
      success: true,
      data,
    });
  })
);
router.get(
  '/messages/search',
  asyncRoute(async (req, res) => {
    const result = await searchMessagesForAdmin(req.query || {});
    const reviews = await readMessageReviewsCached();
    const reviewStatusFilter = sanitizeText(req.query?.reviewStatus, 24).toLowerCase();
    const riskLevelFilter = normalizeMessageReviewRiskLevel(req.query?.riskLevel);
    const itemsWithAudit = result.items.map((message) => attachMessageAudit(message, reviews.records));
    const items = itemsWithAudit.filter((item) => {
      if (reviewStatusFilter && reviewStatusFilter !== 'all' && item.reviewStatus !== reviewStatusFilter) {
        return false;
      }
      if (riskLevelFilter && item.riskLevel !== riskLevelFilter) {
        return false;
      }
      return true;
    });
    res.json({
      success: true,
      data: {
        items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        filters: result.filters,
        note:
          reviewStatusFilter || riskLevelFilter
            ? 'reviewStatus/riskLevel filters are applied after pagination.'
            : '',
      },
    });
  })
);
router.get(
  '/messages/detail',
  asyncRoute(async (req, res) => {
    const messageId = sanitizeText(req.query?.id, 160);
    if (!messageId) {
      res.status(400).json({ success: false, message: 'Message id is required.' });
      return;
    }
    const [message, reviews] = await Promise.all([
      findMessageByIdForAdmin(messageId),
      readMessageReviewsCached(),
    ]);
    if (!message) {
      res.status(404).json({ success: false, message: 'Message not found.' });
      return;
    }
    res.json({
      success: true,
      data: attachMessageAudit(message, reviews.records),
    });
  })
);
router.post(
  '/messages/review',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const messageId = sanitizeText(payload.id, 160);
    if (!messageId) {
      res.status(400).json({ success: false, message: 'Message id is required.' });
      return;
    }
    const message = await findMessageByIdForAdmin(messageId);
    if (!message) {
      res.status(404).json({ success: false, message: 'Message not found.' });
      return;
    }
    const status = normalizeMessageReviewStatus(payload.status);
    if (!status) {
      res.status(400).json({ success: false, message: 'Invalid review status.' });
      return;
    }
    const inspection = inspectMessageRisk(message);
    const riskLevel =
      normalizeMessageReviewRiskLevel(payload.riskLevel) || inspection.autoRiskLevel || 'low';
    const reason = sanitizeText(payload.reason, MAX_MESSAGE_REVIEW_NOTE_LEN);
    const tags = normalizeMessageReviewTags(payload.tags);
    const reviewer = sanitizeText(payload.reviewer || req.headers['x-admin-user'], 64);
    const reviewedAt = new Date().toISOString();
    const mutation = await mutateMessageReviews(
      (working) => {
        const records = working.records && typeof working.records === 'object' ? working.records : {};
        const current = normalizeMessageReviewRecord(messageId, records[messageId]) || null;
        const next = buildMessageReviewRecord({
          current,
          messageId,
          status,
          riskLevel,
          reason,
          tags,
          reviewer,
          reviewedAt,
        });
        records[messageId] = next;
        working.records = records;
        return { changed: true, result: next };
      },
      { defaultChanged: false }
    );
    if (status === 'flagged' || status === 'blocked' || status === 'deleted') {
      trackAdminEvent(req, {
        eventType: 'report',
        targetUid: Number(message?.senderUid) || 0,
        targetType: 'message',
        tags: ['admin_review', status],
        reason: reason || status,
        metadata: {
          messageId,
          riskLevel,
        },
      });
    }
    if (riskLevel === 'high' || riskLevel === 'medium') {
      trackAdminEvent(req, {
        eventType: 'risk_hit',
        targetUid: Number(message?.senderUid) || 0,
        targetType: 'message',
        tags: ['admin_review', riskLevel],
        reason: reason || 'risk_hit',
        metadata: {
          messageId,
          status,
          riskLevel,
        },
      });
    }
    res.json({
      success: true,
      data: {
        review: mutation.result,
        message: attachMessageAudit(message, { [messageId]: mutation.result }),
      },
    });
  })
);
router.post(
  '/messages/delete',
  asyncRoute(async (req, res) => {
    const payload = req.body || {};
    const messageId = sanitizeText(payload.id, 160);
    if (!messageId) {
      res.status(400).json({ success: false, message: 'Message id is required.' });
      return;
    }
    const deletedMessage = await deleteMessageByIdForAdmin(messageId);
    if (!deletedMessage) {
      res.status(404).json({ success: false, message: 'Message not found.' });
      return;
    }
    const reason = sanitizeText(payload.reason, MAX_MESSAGE_REVIEW_NOTE_LEN) || 'Deleted by admin';
    const reviewer = sanitizeText(payload.reviewer || req.headers['x-admin-user'], 64);
    const reviewedAt = new Date().toISOString();
    const inspection = inspectMessageRisk(deletedMessage);
    const riskLevel = inspection.autoRiskLevel || 'low';
    const mutation = await mutateMessageReviews(
      (working) => {
        const records = working.records && typeof working.records === 'object' ? working.records : {};
        const current = normalizeMessageReviewRecord(messageId, records[messageId]) || null;
        const next = buildMessageReviewRecord({
          current,
          messageId,
          status: 'deleted',
          riskLevel,
          reason,
          tags: normalizeMessageReviewTags(payload.tags),
          reviewer,
          reviewedAt,
        });
        records[messageId] = next;
        working.records = records;
        return { changed: true, result: next };
      },
      { defaultChanged: false }
    );
    trackAdminEvent(req, {
      eventType: 'report',
      targetUid: Number(deletedMessage?.senderUid) || 0,
      targetType: 'message',
      tags: ['admin_delete'],
      reason,
      metadata: {
        messageId,
      },
    });
    if (riskLevel === 'high' || riskLevel === 'medium') {
      trackAdminEvent(req, {
        eventType: 'risk_hit',
        targetUid: Number(deletedMessage?.senderUid) || 0,
        targetType: 'message',
        tags: ['admin_delete', riskLevel],
        reason,
        metadata: {
          messageId,
          riskLevel,
        },
      });
    }
    res.json({
      success: true,
      data: {
        deleted: deletedMessage,
        review: mutation.result,
      },
    });
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
