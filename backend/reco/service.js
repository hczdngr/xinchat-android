/**
 * Phase5 recommendation service.
 * - Shadow/online decision
 * - Feedback logging with lightweight online updates
 * - Admin overview with offline IPS/DR approximations
 */

import crypto from 'crypto';
import { isFeatureEnabled } from '../featureFlags.js';
import { metrics } from '../observability.js';
import {
  DEFAULT_RECO_RUNTIME_CONFIG,
  getRecoConfigStoreInfo,
  getRecoRuntimeConfig,
  updateRecoRuntimeConfig,
} from './configStore.js';
import {
  buildBaseScore,
  buildCandidateFeatures,
  buildCandidateId,
  buildSharedContextFeatures,
} from './featureBuilder.js';
import {
  appendRecoDecision,
  appendRecoFeedback,
  getRecoDecisionById,
  getRecoStateStats,
  getRecoUserProfile,
  listRecoDecisions,
  listRecoFeedback,
  listRecoUserProfiles,
  upsertRecoUserProfile,
} from './stateStore.js';
import { getVwClientStatus, scoreCandidatesWithVw } from './vwClient.js';

const ACTION_REWARD = Object.freeze({
  click: 0.35,
  reply: 1,
  mute: -0.8,
  report: -1.2,
  ignore: -0.1,
  dismiss: -0.2,
  risk_hit: -1,
});

const RECO_RUNTIME = {
  decisionsTotal: 0,
  decisionsFailed: 0,
  feedbackTotal: 0,
  feedbackFailed: 0,
  fallbackTotal: 0,
  lastError: '',
  lastErrorAt: '',
};

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeText = (value, maxLen = 200) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const buildDeterministicBucket = (uid = 0) => {
  const text = String(Math.max(0, Math.floor(toFiniteNumber(uid, 0))));
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const normalized = Math.abs(hash >>> 0) % 10_000;
  return normalized / 100;
};

const safeCandidateArray = (input = []) =>
  (Array.isArray(input) ? input : [])
    .map((item, index) => ({
      raw: item,
      position: index,
      candidateId: buildCandidateId(item),
    }))
    .filter((item) => item.candidateId);

const isOnlineEligible = ({ uid = 0, rolloutPercent = 0 } = {}) => {
  const safeRollout = clampNumber(rolloutPercent, 0, 100, 0);
  if (safeRollout <= 0) return false;
  const bucket = buildDeterministicBucket(uid);
  return bucket < safeRollout;
};

const getModeFromFlags = ({ uid, rolloutPercent }) => {
  const featureEnabled = isFeatureEnabled('recoVw');
  const shadowEnabled = isFeatureEnabled('recoVwShadow');
  const onlineEnabled = isFeatureEnabled('recoVwOnline');
  const eligibleOnline = onlineEnabled && isOnlineEligible({ uid, rolloutPercent });
  if (!featureEnabled) {
    return {
      mode: 'disabled',
      featureEnabled: false,
      shadowEnabled,
      onlineEnabled,
      eligibleOnline,
      appliedOnline: false,
    };
  }
  if (eligibleOnline) {
    return {
      mode: 'online',
      featureEnabled: true,
      shadowEnabled,
      onlineEnabled,
      eligibleOnline,
      appliedOnline: true,
    };
  }
  if (shadowEnabled || onlineEnabled) {
    return {
      mode: 'shadow',
      featureEnabled: true,
      shadowEnabled,
      onlineEnabled,
      eligibleOnline,
      appliedOnline: false,
    };
  }
  return {
    mode: 'disabled',
    featureEnabled: true,
    shadowEnabled,
    onlineEnabled,
    eligibleOnline,
    appliedOnline: false,
  };
};

const getRewardByAction = (action, reward) => {
  if (Number.isFinite(Number(reward))) {
    return clampNumber(Number(reward), -2, 2, 0);
  }
  const key = sanitizeText(action, 32).toLowerCase();
  if (!key) return 0;
  return ACTION_REWARD[key] ?? 0;
};

const pickTopTags = (tagWeights = {}, limit = 16) =>
  Object.entries(tagWeights || {})
    .map(([name, value]) => ({
      name: sanitizeText(name, 120),
      weight: toFiniteNumber(value, 0),
    }))
    .filter((item) => item.name)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, Math.max(1, Math.min(100, Math.floor(toFiniteNumber(limit, 16)))))
    .map((item) => ({ ...item, polarity: item.weight >= 0 ? 'positive' : 'negative' }));

const buildProfileBoost = ({ profile, candidateId, targetType, hourOfDay }) => {
  if (!profile || typeof profile !== 'object') return 0;
  const tagWeight = toFiniteNumber(profile?.tagWeights?.[candidateId], 0);
  const typeWeight = toFiniteNumber(profile?.targetTypeWeights?.[targetType], 0);
  const hourWeight = toFiniteNumber(profile?.hourWeights?.[String(hourOfDay)], 0);
  return tagWeight * 0.6 + typeWeight * 0.25 + hourWeight * 0.15;
};

const getDecisionPropensity = ({ mode, explored, epsilon, candidateCount }) => {
  const safeEpsilon = clampNumber(epsilon, 0, 0.8, 0);
  const safeCount = Math.max(1, Math.floor(toFiniteNumber(candidateCount, 1)));
  if (mode !== 'online') return 1;
  if (explored) {
    return Math.max(1 / safeCount, 0.01);
  }
  return Math.max(1 - safeEpsilon, 0.01);
};

const updateRuntimeError = (error) => {
  RECO_RUNTIME.lastError = sanitizeText(error?.message || String(error || ''), 240);
  RECO_RUNTIME.lastErrorAt = new Date().toISOString();
};

const makeDecisionLogRecord = (payload = {}) => ({
  id: String(payload.id || ''),
  uid: Number(payload.uid) || 0,
  mode: sanitizeText(payload.mode, 20) || 'disabled',
  provider: sanitizeText(payload.provider, 40),
  selectedCandidateId: sanitizeText(payload.selectedCandidateId, 120),
  ranking: Array.isArray(payload.ranking) ? payload.ranking : [],
  createdAt: payload.createdAt || new Date().toISOString(),
  createdAtMs: Number(payload.createdAtMs) || Date.now(),
  epsilon: toFiniteNumber(payload.epsilon, 0),
  rolloutPercent: toFiniteNumber(payload.rolloutPercent, 0),
  eligibleOnline: payload.eligibleOnline === true,
  context: payload.context && typeof payload.context === 'object' ? payload.context : {},
  metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
});

const decideConversationRanking = async ({
  uid = 0,
  candidates = [],
  context = {},
  nowMs = Date.now(),
} = {}) => {
  RECO_RUNTIME.decisionsTotal += 1;
  metrics.incCounter('reco_decision_total', 1);

  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  const safeCandidates = safeCandidateArray(candidates);
  const config = await getRecoRuntimeConfig();
  const modeInfo = getModeFromFlags({ uid: safeUid, rolloutPercent: config.rolloutPercent });
  const createdAtMs = Math.max(0, Math.floor(toFiniteNumber(nowMs, Date.now())));
  const createdAt = new Date(createdAtMs).toISOString();
  const hourOfDay = new Date(createdAtMs).getHours();
  const decisionId = crypto.randomUUID();

  if (safeCandidates.length === 0) {
    return {
      decisionId,
      mode: 'disabled',
      featureEnabled: modeInfo.featureEnabled,
      eligibleOnline: modeInfo.eligibleOnline,
      provider: 'none',
      rolloutPercent: config.rolloutPercent,
      epsilon: config.epsilon,
      selectedCandidateId: '',
      ranking: [],
      appliedOrder: [],
      shadowOrder: [],
      reason: 'empty_candidates',
      degraded: false,
    };
  }

  if (safeCandidates.length < Math.max(1, Number(config.minCandidates) || 1)) {
    return {
      decisionId,
      mode: 'disabled',
      featureEnabled: modeInfo.featureEnabled,
      eligibleOnline: modeInfo.eligibleOnline,
      provider: 'none',
      rolloutPercent: config.rolloutPercent,
      epsilon: config.epsilon,
      selectedCandidateId: safeCandidates[0].candidateId,
      ranking: safeCandidates.map((item, idx) => ({
        candidateId: item.candidateId,
        score: 0,
        rank: idx + 1,
        provider: 'none',
      })),
      appliedOrder: safeCandidates.map((item) => item.candidateId),
      shadowOrder: safeCandidates.map((item) => item.candidateId),
      reason: 'not_enough_candidates',
      degraded: false,
    };
  }

  const maxCandidates = Math.max(1, Math.floor(toFiniteNumber(config.maxCandidates, 60)));
  const limitedCandidates = safeCandidates.slice(0, maxCandidates);
  const userProfile = await getRecoUserProfile(safeUid);
  const sharedFeatures = buildSharedContextFeatures({ uid: safeUid, hourOfDay });

  const scored = limitedCandidates.map((item) => {
    const features = buildCandidateFeatures({
      candidate: item.raw,
      nowMs: createdAtMs,
      position: item.position,
    });
    const targetType =
      String(item.raw?.targetType || '').trim().toLowerCase() === 'group' ? 'group' : 'private';
    const baseScore = buildBaseScore(features);
    const profileBoost = buildProfileBoost({
      profile: userProfile,
      candidateId: item.candidateId,
      targetType,
      hourOfDay,
    });
    const preVwScore = baseScore + profileBoost * 0.35;
    return {
      candidateId: item.candidateId,
      targetType,
      raw: item.raw,
      features,
      baseScore,
      profileBoost,
      score: preVwScore,
      provider: 'heuristic',
    };
  });

  let provider = 'heuristic';
  let vwReason = 'skipped';
  let vwUsed = false;
  try {
    if (modeInfo.mode === 'shadow' || modeInfo.mode === 'online') {
      const vwResult = await scoreCandidatesWithVw({
        sharedFeatures,
        candidateFeatures: scored.map((item) => item.features),
        timeoutMs: config.vwTimeoutMs,
        config,
      });
      vwReason = vwResult.reason;
      if (vwResult.available) {
        provider = 'vw_cli';
        vwUsed = true;
        scored.forEach((item, index) => {
          const vwScore = toFiniteNumber(vwResult.scores[index], 0);
          item.score = item.score * 0.65 + vwScore * 0.35;
          item.provider = 'vw_cli';
        });
      } else {
        RECO_RUNTIME.fallbackTotal += 1;
        metrics.incCounter('reco_decision_fallback_total', 1, {
          reason: sanitizeText(vwResult.reason, 60) || 'vw_unavailable',
        });
      }
    }
  } catch (error) {
    RECO_RUNTIME.fallbackTotal += 1;
    updateRuntimeError(error);
    metrics.incCounter('reco_decision_fallback_total', 1, {
      reason: 'vw_exception',
    });
  }

  const ranked = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
    .map((item, index) => ({
      candidateId: item.candidateId,
      score: Number(item.score.toFixed(6)),
      rank: index + 1,
      provider: item.provider,
    }));

  const shadowOrder = safeCandidates.map((item) => item.candidateId);
  const epsilon = clampNumber(config.epsilon, 0, 0.8, DEFAULT_RECO_RUNTIME_CONFIG.epsilon);
  let explored = false;
  let selectedCandidateId = ranked[0]?.candidateId || shadowOrder[0] || '';

  if (modeInfo.mode === 'online' && ranked.length > 1 && Math.random() < epsilon) {
    const k = Math.max(2, Math.min(4, ranked.length));
    const index = Math.floor(Math.random() * k);
    selectedCandidateId = ranked[index]?.candidateId || selectedCandidateId;
    explored = true;
  }

  const appliedOrder =
    modeInfo.mode === 'online'
      ? [
          selectedCandidateId,
          ...ranked
            .map((item) => item.candidateId)
            .filter((candidateId) => candidateId && candidateId !== selectedCandidateId),
        ]
      : shadowOrder.slice();

  const record = makeDecisionLogRecord({
    id: decisionId,
    uid: safeUid,
    mode: modeInfo.mode,
    provider,
    selectedCandidateId,
    ranking: ranked,
    createdAt,
    createdAtMs,
    epsilon,
    rolloutPercent: config.rolloutPercent,
    eligibleOnline: modeInfo.eligibleOnline,
    context: {
      source: sanitizeText(context?.source || 'chat_overview', 40),
      candidateCount: ranked.length,
    },
    metadata: {
      propensity: getDecisionPropensity({
        mode: modeInfo.mode,
        explored,
        epsilon,
        candidateCount: ranked.length,
      }),
      explored,
      shadowOrder,
      appliedOrder,
      vwUsed,
      vwReason,
      hourOfDay,
    },
  });

  try {
    await appendRecoDecision(record);
    metrics.incCounter('reco_decision_persist_total', 1, { mode: modeInfo.mode });
  } catch (error) {
    RECO_RUNTIME.decisionsFailed += 1;
    updateRuntimeError(error);
    metrics.incCounter('reco_decision_error_total', 1, { stage: 'persist' });
  }

  const response = {
    decisionId,
    mode: modeInfo.mode,
    featureEnabled: modeInfo.featureEnabled,
    eligibleOnline: modeInfo.eligibleOnline,
    appliedOnline: modeInfo.appliedOnline,
    rolloutPercent: config.rolloutPercent,
    epsilon,
    provider,
    selectedCandidateId,
    ranking: ranked,
    appliedOrder,
    shadowOrder,
    explored,
    degraded: provider !== 'vw_cli' && (modeInfo.mode === 'shadow' || modeInfo.mode === 'online'),
    reason: vwReason,
  };

  return response;
};

const recordRecoFeedback = async ({
  uid = 0,
  decisionId = '',
  action = '',
  reward,
  candidateId = '',
  metadata = {},
} = {}) => {
  RECO_RUNTIME.feedbackTotal += 1;
  metrics.incCounter('reco_feedback_total', 1, { action: sanitizeText(action, 32).toLowerCase() || 'unknown' });

  const safeUid = Math.max(0, Math.floor(toFiniteNumber(uid, 0)));
  const safeDecisionId = sanitizeText(decisionId, 80);
  const safeAction = sanitizeText(action, 32).toLowerCase() || 'unknown';
  const resolvedReward = getRewardByAction(safeAction, reward);
  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const decision = safeDecisionId ? await getRecoDecisionById(safeDecisionId) : null;
  const resolvedCandidateId =
    sanitizeText(candidateId, 120).toLowerCase() || sanitizeText(decision?.selectedCandidateId, 120).toLowerCase();

  const feedbackRecord = {
    id: crypto.randomUUID(),
    decisionId: safeDecisionId,
    uid: safeUid,
    action: safeAction,
    reward: resolvedReward,
    candidateId: resolvedCandidateId,
    createdAt,
    createdAtMs,
    metadata: {
      ...((metadata && typeof metadata === 'object' ? metadata : {})),
      decisionFound: Boolean(decision),
    },
  };
  const storedFeedback = await appendRecoFeedback(feedbackRecord);
  if (!storedFeedback) {
    RECO_RUNTIME.feedbackFailed += 1;
    metrics.incCounter('reco_feedback_error_total', 1, { stage: 'persist' });
    return {
      success: false,
      reason: 'feedback_persist_failed',
    };
  }

  let updatedProfile = null;
  try {
    const config = await getRecoRuntimeConfig();
    if (config.onlineUpdate && safeUid > 0 && resolvedCandidateId) {
      const learningRate = clampNumber(config.learningRate, 0.001, 0.5, 0.08);
      const targetType =
        String(resolvedCandidateId.split(':')[0] || '').trim().toLowerCase() === 'group'
          ? 'group'
          : 'private';
      const hour = new Date(createdAtMs).getHours();
      updatedProfile = await upsertRecoUserProfile(safeUid, (current) => {
        const next = {
          ...current,
          interactions: {
            total: Math.max(0, Math.floor(toFiniteNumber(current?.interactions?.total, 0))) + 1,
            positive:
              Math.max(0, Math.floor(toFiniteNumber(current?.interactions?.positive, 0))) +
              (resolvedReward > 0 ? 1 : 0),
            negative:
              Math.max(0, Math.floor(toFiniteNumber(current?.interactions?.negative, 0))) +
              (resolvedReward < 0 ? 1 : 0),
          },
          tagWeights: {
            ...(current?.tagWeights && typeof current.tagWeights === 'object' ? current.tagWeights : {}),
          },
          targetTypeWeights: {
            private: toFiniteNumber(current?.targetTypeWeights?.private, 0),
            group: toFiniteNumber(current?.targetTypeWeights?.group, 0),
          },
          hourWeights: {
            ...(current?.hourWeights && typeof current.hourWeights === 'object' ? current.hourWeights : {}),
          },
          metadata: {
            ...(current?.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
            lastAction: safeAction,
            lastDecisionId: safeDecisionId,
          },
        };
        const currentTag = toFiniteNumber(next.tagWeights[resolvedCandidateId], 0);
        next.tagWeights[resolvedCandidateId] = clampNumber(
          currentTag + resolvedReward * learningRate,
          -8,
          8,
          0
        );
        const currentTypeWeight = toFiniteNumber(next.targetTypeWeights[targetType], 0);
        next.targetTypeWeights[targetType] = clampNumber(
          currentTypeWeight + resolvedReward * learningRate * 0.7,
          -6,
          6,
          0
        );
        const hourKey = String(hour);
        const currentHourWeight = toFiniteNumber(next.hourWeights[hourKey], 0);
        next.hourWeights[hourKey] = clampNumber(
          currentHourWeight + resolvedReward * learningRate * 0.3,
          -5,
          5,
          0
        );
        return next;
      });
      metrics.incCounter('reco_feedback_online_update_total', 1, { action: safeAction });
    }
  } catch (error) {
    RECO_RUNTIME.feedbackFailed += 1;
    updateRuntimeError(error);
    metrics.incCounter('reco_feedback_error_total', 1, { stage: 'online_update' });
  }

  return {
    success: true,
    feedback: storedFeedback,
    updatedProfile: updatedProfile
      ? {
          uid: updatedProfile.uid,
          interactions: updatedProfile.interactions,
          topTags: pickTopTags(updatedProfile.tagWeights, 12),
        }
      : null,
  };
};

const evaluateRecoOffline = ({ decisions = [], feedbacks = [] } = {}) => {
  const decisionMap = new Map();
  (Array.isArray(decisions) ? decisions : []).forEach((decision) => {
    const key = String(decision?.id || '');
    if (!key) return;
    decisionMap.set(key, decision);
  });
  let ipsSum = 0;
  let drSum = 0;
  let samples = 0;
  let rewardSum = 0;
  (Array.isArray(feedbacks) ? feedbacks : []).forEach((feedback) => {
    const decision = decisionMap.get(String(feedback?.decisionId || ''));
    if (!decision) return;
    const reward = toFiniteNumber(feedback?.reward, 0);
    const propensity = clampNumber(decision?.metadata?.propensity, 0.01, 1, 1);
    const selected = (Array.isArray(decision?.ranking) ? decision.ranking : []).find(
      (item) => String(item?.candidateId || '') === String(decision?.selectedCandidateId || '')
    );
    const predicted = clampNumber(toFiniteNumber(selected?.score, 0), -2, 2, 0);
    ipsSum += reward / propensity;
    drSum += predicted + (reward - predicted) / propensity;
    rewardSum += reward;
    samples += 1;
  });
  if (samples <= 0) {
    return {
      samples: 0,
      avgReward: 0,
      ips: 0,
      dr: 0,
    };
  }
  return {
    samples,
    avgReward: Number((rewardSum / samples).toFixed(6)),
    ips: Number((ipsSum / samples).toFixed(6)),
    dr: Number((drSum / samples).toFixed(6)),
  };
};

const buildOnlineMetrics = ({ decisions = [], feedbacks = [] } = {}) => {
  const impressions = Math.max(0, (Array.isArray(decisions) ? decisions : []).length);
  const byAction = {};
  (Array.isArray(feedbacks) ? feedbacks : []).forEach((item) => {
    const action = sanitizeText(item?.action, 32).toLowerCase() || 'unknown';
    byAction[action] = (byAction[action] || 0) + 1;
  });
  const clicks = Number(byAction.click || 0);
  const replies = Number(byAction.reply || 0);
  const reports = Number(byAction.report || 0);
  return {
    impressions,
    feedbackTotal: (Array.isArray(feedbacks) ? feedbacks : []).length,
    byAction,
    ctr: impressions > 0 ? Number((clicks / impressions).toFixed(6)) : 0,
    replyRate: impressions > 0 ? Number((replies / impressions).toFixed(6)) : 0,
    reportRate: impressions > 0 ? Number((reports / impressions).toFixed(6)) : 0,
  };
};

const formatUserProfileForAdmin = (profile = null) => {
  if (!profile) return null;
  const topTags = pickTopTags(profile.tagWeights, 20);
  return {
    uid: profile.uid,
    updatedAt: profile.updatedAt,
    interactions: profile.interactions,
    topTags,
    targetTypeWeights: profile.targetTypeWeights,
    hourWeights: profile.hourWeights,
    metadata: profile.metadata,
  };
};

const getRecoUserPersona = async (uid = 0) => {
  const profile = await getRecoUserProfile(uid);
  const formatted = formatUserProfileForAdmin(profile);
  if (!formatted) return null;
  return {
    ...formatted,
    personalizedTags: (formatted.topTags || []).map((item) => item.name).slice(0, 12),
  };
};

const getRecoAdminOverview = async ({ limit = 120, windowHours = 24 } = {}) => {
  const safeLimit = Math.max(20, Math.min(600, Math.floor(toFiniteNumber(limit, 120))));
  const safeWindowHours = Math.max(1, Math.min(24 * 30, Math.floor(toFiniteNumber(windowHours, 24))));
  const sinceMs = Date.now() - safeWindowHours * 3_600_000;

  const [config, stateStats, configStoreInfo, decisions, feedbacks, profiles] = await Promise.all([
    getRecoRuntimeConfig(),
    getRecoStateStats(),
    getRecoConfigStoreInfo(),
    listRecoDecisions({ sinceMs, limit: safeLimit }),
    listRecoFeedback({ sinceMs, limit: Math.max(safeLimit * 2, 120) }),
    listRecoUserProfiles({ limit: 80 }),
  ]);

  const byMode = {};
  const byProvider = {};
  decisions.forEach((item) => {
    const mode = sanitizeText(item?.mode, 20) || 'unknown';
    const provider = sanitizeText(item?.provider, 40) || 'unknown';
    byMode[mode] = (byMode[mode] || 0) + 1;
    byProvider[provider] = (byProvider[provider] || 0) + 1;
  });

  const flags = {
    recoVw: isFeatureEnabled('recoVw'),
    recoVwShadow: isFeatureEnabled('recoVwShadow'),
    recoVwOnline: isFeatureEnabled('recoVwOnline'),
  };

  const vwStatus = getVwClientStatus(config);
  const onlineMetrics = buildOnlineMetrics({ decisions, feedbacks });
  const offline = evaluateRecoOffline({ decisions, feedbacks });

  return {
    generatedAt: new Date().toISOString(),
    flags,
    config,
    configStore: configStoreInfo,
    vwStatus,
    counts: {
      decisions: decisions.length,
      feedbacks: feedbacks.length,
      users: profiles.length,
      byMode,
      byProvider,
    },
    online: onlineMetrics,
    offline,
    runtime: { ...RECO_RUNTIME },
    store: stateStats,
    recentDecisions: decisions.slice(0, 80),
    recentFeedbacks: feedbacks.slice(0, 120),
    userProfiles: profiles.slice(0, 60).map((item) => formatUserProfileForAdmin(item)),
  };
};

const updateRecoAdminConfig = async (patch = {}, { actor = 'admin' } = {}) => {
  const updated = await updateRecoRuntimeConfig(patch, { actor });
  return {
    config: updated,
    vwStatus: getVwClientStatus(updated),
  };
};

const getRecoRuntimeStats = () => ({ ...RECO_RUNTIME });

export {
  decideConversationRanking,
  getRecoAdminOverview,
  getRecoRuntimeStats,
  getRecoUserPersona,
  recordRecoFeedback,
  updateRecoAdminConfig,
};

