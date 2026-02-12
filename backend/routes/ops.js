/**
 * Relationship operations route:
 * - interaction decline ranking for friends/groups
 */

import express from 'express';
import { createAuthenticateMiddleware } from './session.js';
import { readGroups } from './groups.js';
import { getChatDatabaseForOps } from './chat.js';
import { buildRelationshipOpsSnapshot, normalizeScope, normalizeWindowDays } from '../ops/relationshipService.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';
import { createMemoryRateLimiter } from '../assistant/rateLimiter.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Ops' });
const relationshipLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.RELATIONSHIP_OPS_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.RELATIONSHIP_OPS_RATE_MAX || '90'), 10) || 90,
});
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const RELATIONSHIP_ALLOW_NOW_OVERRIDE =
  String(
    process.env.RELATIONSHIP_OPS_ALLOW_NOW_OVERRIDE ||
      (NODE_ENV === 'production' ? 'false' : 'true')
  )
    .trim()
    .toLowerCase() === 'true';

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

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const makeRateKey = (req) => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const ipRaw = String(
    req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || ''
  );
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || ip || 'unknown'}:relationship_ops`;
};

const trackOpsEvent = (req, payload = {}) => {
  void trackEventSafe(
    createRequestEvent(req, {
      actorUid: Number(req?.auth?.user?.uid) || 0,
      source: 'ops',
      ...payload,
    })
  );
};

router.get('/relationship', authenticate, async (req, res) => {
  const rateKey = makeRateKey(req);
  if (!relationshipLimiter.consume(rateKey)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  const payload = { ...(req.query || {}), ...(req.body || {}) };
  const scope = normalizeScope(payload.scope);
  const windowDays = normalizeWindowDays(payload.windowDays);
  const limit = toPositiveInt(payload.limit, 20, 1, 60);
  const includeStable = toBoolean(payload.includeStable, false);
  const nowOverrideRaw = Number(payload.nowMs || payload.nowOverrideMs || 0);
  const nowMs =
    RELATIONSHIP_ALLOW_NOW_OVERRIDE &&
    Number.isFinite(nowOverrideRaw) &&
    nowOverrideRaw > 0 &&
    Math.abs(nowOverrideRaw - Date.now()) <= 180 * 24 * 60 * 60 * 1000
      ? Math.floor(nowOverrideRaw)
      : Date.now();

  if (!isFeatureEnabled('relationshipOps')) {
    res.json({
      success: true,
      data: {
        enabled: false,
        available: true,
        generatedAt: new Date(nowMs).toISOString(),
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

  try {
    const database = await getChatDatabaseForOps();
    const groups = await readGroups();
    const snapshot = buildRelationshipOpsSnapshot({
      database,
      user: req.auth?.user,
      users: req.auth?.users || [],
      groups,
      options: {
        scope,
        windowDays,
        limit,
        includeStable,
      },
      nowMs,
    });

    trackOpsEvent(req, {
      eventType: 'impression',
      targetUid: 0,
      targetType: 'ops',
      tags: ['relationship_ops', scope, `window_${windowDays}`],
      metadata: {
        totalDeclined: Number(snapshot?.summary?.totalDeclined) || 0,
        items: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
        includeStable,
      },
    });

    res.json({
      success: true,
      data: {
        enabled: true,
        available: true,
        ...snapshot,
      },
    });
  } catch (error) {
    console.error('Relationship ops error:', error);
    trackOpsEvent(req, {
      eventType: 'report',
      targetUid: 0,
      targetType: 'ops',
      tags: ['relationship_ops', 'error'],
      reason: String(error?.message || 'relationship_ops_failed').slice(0, 140),
    });
    res.json({
      success: true,
      data: {
        enabled: true,
        available: false,
        generatedAt: new Date(nowMs).toISOString(),
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
      message: 'relationship ops fallback',
    });
  }
});

export default router;
