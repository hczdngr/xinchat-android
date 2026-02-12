/**
 * Phase5 reco routes.
 * - /api/reco/decision
 * - /api/reco/feedback
 * - /api/reco/admin
 */

import express from 'express';
import { createAuthenticateMiddleware } from './session.js';
import { requireAdminAccess } from './adminAuth.js';
import { createMemoryRateLimiter } from '../assistant/rateLimiter.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';
import {
  decideConversationRanking,
  getRecoAdminOverview,
  recordRecoFeedback,
  updateRecoAdminConfig,
} from '../reco/index.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Reco' });

const decisionLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RECO_DECISION_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RECO_DECISION_RATE_MAX || '180'), 10) || 180,
});
const feedbackLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RECO_FEEDBACK_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RECO_FEEDBACK_RATE_MAX || '240'), 10) || 240,
});
const adminLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RECO_ADMIN_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RECO_ADMIN_RATE_MAX || '80'), 10) || 80,
});

const sanitizeText = (value, maxLen = 200) =>
  typeof value === 'string' ? value.trim().slice(0, maxLen) : '';

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const makeRateKey = (req, suffix = 'reco') => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const admin = String(req?.admin?.username || '').trim();
  const ipRaw = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || '');
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || admin || ip || 'unknown'}:${suffix}`;
};

const normalizeCandidates = (input = []) =>
  (Array.isArray(input) ? input : [])
    .map((item) => ({
      uid: Math.max(0, Math.floor(toFiniteNumber(item?.uid || item?.targetUid, 0))),
      targetUid: Math.max(0, Math.floor(toFiniteNumber(item?.targetUid || item?.uid, 0))),
      targetType:
        String(item?.targetType || '').trim().toLowerCase() === 'group' ? 'group' : 'private',
      unread: Math.max(0, Math.floor(toFiniteNumber(item?.unread, 0))),
      latest: item?.latest && typeof item.latest === 'object' ? item.latest : null,
      group: item?.group && typeof item.group === 'object' ? item.group : null,
    }))
    .filter((item) => item.targetUid > 0);

const trackRecoRouteEvent = (req, payload = {}) => {
  void trackEventSafe(
    createRequestEvent(req, {
      actorUid: Number(req?.auth?.user?.uid) || 0,
      source: 'reco_route',
      targetType: 'reco',
      eventType: 'impression',
      ...payload,
    })
  );
};

router.post('/decision', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req, 'reco_decision');
  if (!decisionLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  try {
    const uid = Number(req?.auth?.user?.uid || 0);
    const candidates = normalizeCandidates(req?.body?.candidates || req?.body?.items || []);
    const result = await decideConversationRanking({
      uid,
      candidates,
      context: {
        source: sanitizeText(req?.body?.source, 40) || 'api_reco_decision',
      },
    });
    trackRecoRouteEvent(req, {
      tags: ['reco_decision', result.mode],
      metadata: {
        candidates: candidates.length,
        selectedCandidateId: result.selectedCandidateId,
        provider: result.provider,
      },
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Reco decision route error:', error);
    res.json({
      success: true,
      message: 'reco decision fallback',
      data: {
        decisionId: '',
        mode: 'disabled',
        featureEnabled: false,
        eligibleOnline: false,
        appliedOnline: false,
        rolloutPercent: 0,
        epsilon: 0,
        provider: 'none',
        selectedCandidateId: '',
        ranking: [],
        appliedOrder: [],
        shadowOrder: [],
        explored: false,
        degraded: true,
        reason: 'route_exception',
      },
    });
  }
});

router.post('/feedback', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req, 'reco_feedback');
  if (!feedbackLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }
  try {
    const uid = Number(req?.auth?.user?.uid || 0);
    const payload = req?.body && typeof req.body === 'object' ? req.body : {};
    const result = await recordRecoFeedback({
      uid,
      decisionId: sanitizeText(payload.decisionId, 80),
      action: sanitizeText(payload.action, 32),
      reward: toFiniteNumber(payload.reward, Number.NaN),
      candidateId: sanitizeText(payload.candidateId, 120),
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    });
    trackRecoRouteEvent(req, {
      eventType: 'click',
      tags: ['reco_feedback', sanitizeText(payload.action, 32).toLowerCase() || 'unknown'],
      metadata: {
        decisionId: sanitizeText(payload.decisionId, 80),
        success: Boolean(result?.success),
      },
    });
    res.json({
      success: Boolean(result?.success),
      data: result,
    });
  } catch (error) {
    console.error('Reco feedback route error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.get('/admin', requireAdminAccess, async (req, res) => {
  const rateKey = makeRateKey(req, 'reco_admin');
  if (!adminLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }
  try {
    const limit = toPositiveInt(req.query?.limit, 120, 20, 600);
    const windowHours = toPositiveInt(req.query?.windowHours, 24, 1, 24 * 30);
    const data = await getRecoAdminOverview({ limit, windowHours });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Reco admin overview error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

router.post('/admin/config', requireAdminAccess, async (req, res) => {
  const rateKey = makeRateKey(req, 'reco_admin_config');
  if (!adminLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }
  try {
    const patch = req?.body && typeof req.body === 'object' ? req.body : {};
    const actor = sanitizeText(req?.admin?.username || req?.headers?.['x-admin-user'], 80) || 'admin';
    const data = await updateRecoAdminConfig(patch, { actor });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Reco admin config update error:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

export default router;

