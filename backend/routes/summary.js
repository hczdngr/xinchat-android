/**
 * Summary center routes.
 */

import express from 'express';
import { createAuthenticateMiddleware } from './session.js';
import { createMemoryRateLimiter } from '../assistant/rateLimiter.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';
import {
  archiveSummaryForUser,
  generateSummaryForUser,
  getSummaryCenterForUser,
} from '../summary/service.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Summary' });

const queryLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.SUMMARY_QUERY_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.SUMMARY_QUERY_RATE_MAX || '120'), 10) || 120,
});
const refreshLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.SUMMARY_REFRESH_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.SUMMARY_REFRESH_RATE_MAX || '40'), 10) || 40,
});
const archiveLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.SUMMARY_ARCHIVE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.SUMMARY_ARCHIVE_RATE_MAX || '60'), 10) || 60,
});

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const makeRateKey = (req, suffix) => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const ipRaw = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || '');
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || ip || 'unknown'}:${suffix}`;
};

const trackSummaryEvent = (req, payload = {}) => {
  void trackEventSafe(
    createRequestEvent(req, {
      actorUid: Number(req?.auth?.user?.uid) || 0,
      source: 'summary_center',
      targetType: 'summary',
      eventType: 'impression',
      ...payload,
    })
  );
};

const disabledResponse = () => ({
  enabled: false,
  available: true,
  generatedAt: new Date().toISOString(),
  latest: null,
  history: [],
  badges: {
    hasLatest: false,
    unreadHistory: 0,
    unreadTotal: 0,
  },
  stats: {
    generatedTotal: 0,
    manualRefreshTotal: 0,
    archivedTotal: 0,
    lastError: '',
  },
});

router.get('/', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req, 'summary_get');
  if (!queryLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  if (!isFeatureEnabled('summaryCenter')) {
    res.json({ success: true, data: disabledResponse() });
    return;
  }

  try {
    const limit = toPositiveInt(req.query?.limit, 20, 1, 100);
    const ensureLatest = toBoolean(req.query?.ensureLatest, true);
    const uid = Number(req?.auth?.user?.uid || 0);
    const state = await getSummaryCenterForUser({ uid, limit, ensureLatest });
    trackSummaryEvent(req, {
      tags: ['summary_center', 'read'],
      metadata: {
        hasLatest: Boolean(state?.latest),
        historySize: Array.isArray(state?.history) ? state.history.length : 0,
      },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    console.error('Summary center read failed:', error);
    res.json({ success: true, data: { ...disabledResponse(), enabled: true, available: false } });
  }
});

router.post('/refresh', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req, 'summary_refresh');
  if (!refreshLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  if (!isFeatureEnabled('summaryCenter')) {
    res.json({ success: true, data: disabledResponse(), message: 'summary center is disabled.' });
    return;
  }

  try {
    const uid = Number(req?.auth?.user?.uid || 0);
    const state = await generateSummaryForUser({
      uid,
      manual: true,
      reason: 'manual_refresh',
      push: true,
    });

    trackSummaryEvent(req, {
      tags: ['summary_center', 'manual_refresh'],
      metadata: {
        unreadTotal: Number(state?.latest?.unreadTotal) || 0,
        todoCount: Array.isArray(state?.latest?.todos) ? state.latest.todos.length : 0,
      },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    console.error('Summary center refresh failed:', error);
    res.json({ success: true, data: { ...disabledResponse(), enabled: true, available: false } });
  }
});

router.post('/archive', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req, 'summary_archive');
  if (!archiveLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  if (!isFeatureEnabled('summaryCenter')) {
    res.json({ success: true, data: disabledResponse(), message: 'summary center is disabled.' });
    return;
  }

  try {
    const uid = Number(req?.auth?.user?.uid || 0);
    const summaryId = String(req?.body?.summaryId || '').trim();
    const result = await archiveSummaryForUser({ uid, summaryId });

    trackSummaryEvent(req, {
      tags: ['summary_center', result.success ? 'archive_ok' : 'archive_miss'],
      metadata: {
        summaryId,
        success: result.success,
      },
    });

    res.json({
      success: result.success,
      message: result.message,
      data: result.state,
      archived: result.archived || null,
    });
  } catch (error) {
    console.error('Summary center archive failed:', error);
    res.status(500).json({ success: false, message: 'Request failed.' });
  }
});

export default router;
