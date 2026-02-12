/**
 * Translation route with local LibreTranslate backend and profile personalization.
 */

import express from 'express';
import { isFeatureEnabled } from '../featureFlags.js';
import { createRequestEvent, trackEventSafe } from '../events/eventLogger.js';
import { createMemoryRateLimiter } from '../assistant/rateLimiter.js';
import {
  DEFAULT_ASSISTANT_PROFILE,
  mergeAssistantProfile,
  normalizeExplanationLevel,
  normalizeReplyStyle,
  normalizeTranslateStyle,
  resolveAssistantProfileFromUser,
} from '../assistant/preferences.js';
import { translateWithPersonalization } from '../assistant/translateService.js';
import { createAuthenticateMiddleware, extractToken } from './session.js';
import { findUserByToken, mutateUsers, readUsers } from './auth.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Translate' });
const translateLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.TRANSLATE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.TRANSLATE_RATE_MAX || '90'), 10) || 90,
});
const profileLimiter = createMemoryRateLimiter({
  windowMs: Number.parseInt(String(process.env.TRANSLATE_PROFILE_RATE_WINDOW_MS || '60000'), 10) || 60_000,
  max: Number.parseInt(String(process.env.TRANSLATE_PROFILE_RATE_MAX || '40'), 10) || 40,
});

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const makeRateKey = (req, suffix = '') => {
  const uid = Number(req?.auth?.user?.uid) || 0;
  const ipRaw = String(
    req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || req?.ip || ''
  );
  const ip = ipRaw.split(',')[0]?.trim() || '';
  return `${uid || ip || 'unknown'}:${suffix}`;
};

const resolveOptionalAuthUser = async (req) => {
  const token = extractToken(req);
  if (!token) return null;
  try {
    let users = await readUsers();
    let found = await findUserByToken(users, token);
    if (found.touched) {
      const mutation = await mutateUsers(
        async (latestUsers) => {
          const latestFound = await findUserByToken(latestUsers, token);
          return {
            changed: latestFound.touched,
            result: { users: latestUsers, found: latestFound },
          };
        },
        { defaultChanged: false }
      );
      if (mutation.result) {
        users = mutation.result.users;
        found = mutation.result.found;
      }
    }
    return found.user || null;
  } catch {
    return null;
  }
};

const persistAssistantProfile = async (uid, profilePatch = {}) => {
  const targetUid = Number(uid);
  if (!Number.isInteger(targetUid) || targetUid <= 0) return null;
  const mutation = await mutateUsers(
    (users) => {
      const index = users.findIndex((item) => Number(item?.uid) === targetUid);
      if (index < 0) {
        return { changed: false, result: null };
      }
      const current = resolveAssistantProfileFromUser(users[index]);
      const next = mergeAssistantProfile(current, profilePatch);
      const changed = JSON.stringify(current) !== JSON.stringify(next);
      if (changed) {
        users[index] = {
          ...users[index],
          assistantProfile: next,
        };
      }
      return { changed, result: next };
    },
    { defaultChanged: false }
  );
  return mutation.result || null;
};

const trackTranslateEvent = (req, payload = {}) => {
  void trackEventSafe(
    createRequestEvent(req, {
      eventType: 'impression',
      actorUid: Number(req?.auth?.user?.uid) || 0,
      targetUid: 0,
      targetType: 'translate',
      tags: ['translate'],
      ...payload,
    })
  );
};

router.post('/', async (req, res) => {
  const key = makeRateKey(req, 'translate');
  if (!translateLimiter.consume(key)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }
  const payload = isPlainObject(req.body) ? req.body : {};
  const text = String(payload.text || '').trim();
  if (!text) {
    res.status(400).json({ success: false, message: 'text is required.' });
    return;
  }

  const authUser = await resolveOptionalAuthUser(req);
  if (authUser) {
    req.auth = { ...(req.auth || {}), user: authUser };
  }

  const personalizationEnabled = isFeatureEnabled('translatePersonalization');
  const useProfile = toBoolean(payload.useProfile, true);
  const userProfile =
    personalizationEnabled && useProfile && authUser
      ? resolveAssistantProfileFromUser(authUser)
      : DEFAULT_ASSISTANT_PROFILE;

  const style = normalizeTranslateStyle(payload.style, userProfile.translateStyle);
  const explanationLevel = normalizeExplanationLevel(
    payload.explanationLevel,
    userProfile.explanationLevel
  );
  const replyStyle = normalizeReplyStyle(payload.replyStyle, userProfile.replyStyle);

  const result = await translateWithPersonalization({
    text,
    sourceLang: payload.sourceLang || payload.source || 'auto',
    targetLang: payload.targetLang || payload.target || 'zh',
    style,
    explanationLevel,
  });

  const persistProfile = toBoolean(payload.persistProfile, false);
  let storedProfile = userProfile;
  if (personalizationEnabled && persistProfile && authUser) {
    const persisted = await persistAssistantProfile(authUser.uid, {
      translateStyle: style,
      explanationLevel,
      replyStyle,
    });
    if (persisted) {
      storedProfile = persisted;
    }
  }

  trackTranslateEvent(req, {
    tags: ['translate', result.degraded ? 'degraded' : 'ok'],
    metadata: {
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
      style,
      explanationLevel,
      degraded: result.degraded,
      provider: result.provider,
    },
  });

  res.json({
    success: true,
    translated: result.translated,
    explanation: result.explanation,
    data: {
      translated: result.translated,
      explanation: result.explanation,
      degraded: result.degraded,
      reason: result.reason,
      provider: result.provider,
      attempts: result.attempts,
      detectedLanguage: result.detectedLanguage,
      style,
      explanationLevel,
      useProfile: personalizationEnabled ? useProfile : false,
      profile: storedProfile,
      featureEnabled: personalizationEnabled,
    },
  });
});

router.get('/profile', authenticate, async (req, res) => {
  const key = makeRateKey(req, 'profile_get');
  if (!profileLimiter.consume(key)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }
  const profile = resolveAssistantProfileFromUser(req.auth.user);
  res.json({
    success: true,
    data: {
      profile,
      featureEnabled: isFeatureEnabled('translatePersonalization'),
    },
  });
});

router.post('/profile', authenticate, async (req, res) => {
  const key = makeRateKey(req, 'profile_post');
  if (!profileLimiter.consume(key)) {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  if (!isFeatureEnabled('translatePersonalization')) {
    res.status(403).json({
      success: false,
      message: 'translate personalization feature is disabled.',
    });
    return;
  }

  const payload = isPlainObject(req.body) ? req.body : {};
  const patch = {
    translateStyle: normalizeTranslateStyle(payload.translateStyle || payload.style, ''),
    explanationLevel: normalizeExplanationLevel(payload.explanationLevel, ''),
    replyStyle: normalizeReplyStyle(payload.replyStyle, ''),
  };
  const hasPatch = Boolean(patch.translateStyle || patch.explanationLevel || patch.replyStyle);
  if (!hasPatch) {
    res.status(400).json({
      success: false,
      message: 'No valid profile fields provided.',
    });
    return;
  }

  const nextProfile = await persistAssistantProfile(req.auth.user.uid, patch);
  if (!nextProfile) {
    res.status(404).json({ success: false, message: 'User not found.' });
    return;
  }

  trackTranslateEvent(req, {
    tags: ['translate_profile_update'],
    metadata: {
      uid: req.auth.user.uid,
      profile: nextProfile,
    },
  });

  res.json({
    success: true,
    data: {
      profile: nextProfile,
      featureEnabled: true,
    },
  });
});

export default router;
