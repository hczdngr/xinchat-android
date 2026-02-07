import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { createAuthenticateMiddleware } from './session.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Insight' });

const GEMINI_FLASH_PREVIEW_MODEL = 'gemini-3-flash-preview';
const HARDCODED_GEMINI_API_KEY_B64 =
  'QUl6YVN5QV81RndRNWFwZlpseG9kdHhRakRNNk92dlNYRFAwZURv';
const DEFAULT_WARM_TIP =
  '\u4f60\u5e76\u4e0d\u5b64\u5355\u3002\u8bf7\u5148\u7167\u987e\u597d\u81ea\u5df1\uff0c\u5fc5\u8981\u65f6\u53ca\u65f6\u8054\u7cfb\u5bb6\u4eba\u670b\u53cb\u6216\u4e13\u4e1a\u5fc3\u7406\u652f\u6301\u3002';
const WARM_TIP_OUTPUT_TOKENS = 3000;
const WARM_TIP_OUTPUT_TOKENS_FALLBACK = 3000;
const WARM_TIP_MAX_RETRIES = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_MAX_RETRIES || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
})();
const WARM_TIP_RETRY_DELAY_MS = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_RETRY_DELAY_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 700;
})();
const WARM_TIP_REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_REQUEST_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 30000;
})();
const WARM_TIP_MAX_PARALLEL = 6;
const WARM_TIP_INPUT_TOKENS = 3000;
const WARM_TIP_APPROX_CHARS_PER_TOKEN = 3;

const warmTipCache = new Map();
const warmTipInFlight = new Map();
let warmTipActive = 0;
const warmTipQueue = [];
let aiClient = null;
let aiClientKey = '';

const decodeHardcodedGeminiKey = () => {
  try {
    return Buffer.from(HARDCODED_GEMINI_API_KEY_B64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
};

const toErrorDetail = (error) => {
  const detail = {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : typeof error,
  };
  const cause = error && typeof error === 'object' ? error.cause : null;
  if (cause && typeof cause === 'object') {
    detail.cause = {
      message: String(cause.message || ''),
      code: String(cause.code || ''),
      errno: String(cause.errno || ''),
      syscall: String(cause.syscall || ''),
      host: String(cause.host || cause.hostname || ''),
      address: String(cause.address || ''),
      port: String(cause.port || ''),
    };
  }
  const status = error && typeof error === 'object' ? error.status : null;
  if (status != null) {
    detail.status = status;
  }
  return detail;
};

const toShortText = (value, max = 90) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const clipByApproxTokens = (text, tokenLimit) => {
  const value = String(text || '');
  if (!value) return '';
  const limit = Math.max(1, Math.floor(Number(tokenLimit || 0) * WARM_TIP_APPROX_CHARS_PER_TOKEN));
  if (!Number.isFinite(limit)) return value;
  return value.length > limit ? value.slice(0, limit) : value;
};

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const withTimeout = async (promise, timeoutMs, label) => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const getAiClient = (apiKey) => {
  if (!aiClient || aiClientKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClientKey = apiKey;
  }
  return aiClient;
};

const withWarmTipConcurrency = async (task) =>
  new Promise((resolve, reject) => {
    const run = () => {
      warmTipActive += 1;
      Promise.resolve()
        .then(task)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          warmTipActive -= 1;
          const next = warmTipQueue.shift();
          if (next) next();
        });
    };

    if (warmTipActive < WARM_TIP_MAX_PARALLEL) {
      run();
      return;
    }
    warmTipQueue.push(run);
  });

const sanitizeTip = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '')
    .trim();

const isCompleteTip = ({ text, finishReason }) => {
  if (!sanitizeTip(text)) return false;
  if (String(finishReason || '').toUpperCase() === 'MAX_TOKENS') return false;
  return true;
};

const hasDepressionTendency = (user) => {
  const analysis = user?.aiProfile?.analysis || {};
  const depression = analysis?.depressionTendency || {};
  const level = String(depression?.level || '').toLowerCase();
  return level === 'medium' || level === 'high';
};

const buildLocalWarmTip = (user) => {
  const name = toShortText(user?.nickname || user?.username || '\u4f60', 20) || '\u4f60';
  return `${name}\uff0c\u5148\u8ba9\u81ea\u5df1\u6162\u4e0b\u6765\uff0c\u54ea\u6015\u53ea\u662f\u77ed\u6682\u4f11\u606f\u4e5f\u5f88\u91cd\u8981\u3002\u4f60\u53ef\u4ee5\u968f\u65f6\u8054\u7cfb\u4fe1\u4efb\u7684\u5bb6\u4eba\u670b\u53cb\u6216\u4e13\u4e1a\u652f\u6301\u3002`;
};

const buildUserSummary = (user) => {
  const analysis = user?.aiProfile?.analysis || {};
  const depression = analysis?.depressionTendency || {};
  const riskSignals = Array.isArray(analysis?.riskSignals) ? analysis.riskSignals : [];
  const preferences = Array.isArray(analysis?.preferences) ? analysis.preferences : [];
  const traits = Array.isArray(analysis?.personalityTraits) ? analysis.personalityTraits : [];
  const fields = [
    `nickname: ${toShortText(user?.nickname || user?.username || 'user', 48)}`,
    `signature: ${toShortText(user?.signature || '', 240) || 'none'}`,
    `region: ${toShortText(
      [user?.country, user?.province, user?.region].filter(Boolean).join(' ') || 'unknown',
      120
    )}`,
    `risk_level: ${String(depression?.level || 'unknown')}`,
    `risk_reason: ${toShortText(depression?.reason || '', 600) || 'none'}`,
    `risk_signals: ${riskSignals.map((item) => toShortText(item, 180)).filter(Boolean).join('; ') || 'none'}`,
    `profile_summary: ${toShortText(analysis?.profileSummary, 1200) || 'none'}`,
    `preferences: ${preferences
      .map((item) => `${toShortText(item?.name || item, 80)}(${Number(item?.confidence || 0).toFixed(2)})`)
      .join('; ') || 'none'}`,
    `traits: ${traits
      .map((item) => `${toShortText(item?.name || item, 80)}(${Number(item?.confidence || 0).toFixed(2)})`)
      .join('; ') || 'none'}`,
  ].join('\n');
  return clipByApproxTokens(fields, WARM_TIP_INPUT_TOKENS);
};

const buildPrompt = (user) => {
  const summary = buildUserSummary(user);
  return `
Write a warm and supportive popup message for this user.
Requirements:
1) Keep the message empathetic and calm.
2) It should be complete (not truncated).
3) Mention that seeking help from family, friends, or professionals is okay.
4) Keep it concise and natural, no more than 120 Chinese characters.
5) Output must be in Simplified Chinese.

User context:
${summary}
`.trim();
};

const requestWarmTipOnce = async ({ ai, model, prompt, maxOutputTokens }) => {
  const response = await withTimeout(
    ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.2,
        maxOutputTokens,
      },
    }),
    WARM_TIP_REQUEST_TIMEOUT_MS,
    'warm-tip generation'
  );
  const text = typeof response?.text === 'string' ? response.text : '';
  const finishReason = String(response?.candidates?.[0]?.finishReason || '');
  return { text, finishReason };
};

const requestWarmTipWithRetry = async ({ ai, model, prompt, maxOutputTokens }) => {
  let lastError = null;
  for (let attempt = 0; attempt < WARM_TIP_MAX_RETRIES; attempt += 1) {
    try {
      return await requestWarmTipOnce({
        ai,
        model,
        prompt,
        maxOutputTokens,
      });
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const message = String(error?.message || '');
      const isTimeoutError = /timeout/i.test(message);
      const isRetryable =
        isTimeoutError || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!isRetryable || attempt >= WARM_TIP_MAX_RETRIES - 1) {
        throw error;
      }
      await sleep(WARM_TIP_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError || new Error('warm-tip request failed');
};

const createWarmTipCacheEntry = ({ versionKey, tip }) => ({
  versionKey,
  tip,
  updatedAt: new Date().toISOString(),
});

const getUserCacheMeta = (user) => {
  const uid = Number(user?.uid);
  const cacheKey = Number.isInteger(uid) ? String(uid) : `anon:${String(user?.username || '')}`;
  const versionKey = [
    cacheKey,
    String(user?.aiProfile?.updatedAt || ''),
    String(user?.nickname || ''),
    String(user?.signature || ''),
    String(user?.gender || ''),
    String(user?.birthday || ''),
    String(user?.country || ''),
    String(user?.province || ''),
    String(user?.region || ''),
  ].join('|');
  return { cacheKey, versionKey };
};

const generateWarmTip = async ({ user, cacheKey, versionKey }) => {
  const apiKey = String(process.env.GEMINI_API_KEY || decodeHardcodedGeminiKey()).trim();
  if (!apiKey) return buildLocalWarmTip(user);

  const model = String(process.env.GEMINI_DEFAULT_MODEL || GEMINI_FLASH_PREVIEW_MODEL).trim();
  const prompt = buildPrompt(user);
  const ai = getAiClient(apiKey);
  try {
    const first = await requestWarmTipWithRetry({
      ai,
      model,
      prompt,
      maxOutputTokens: WARM_TIP_OUTPUT_TOKENS,
    });
    if (isCompleteTip(first)) {
      const tip = sanitizeTip(first.text);
      warmTipCache.set(cacheKey, createWarmTipCacheEntry({ versionKey, tip }));
      return tip;
    }

    if (
      String(first.finishReason || '').toUpperCase() === 'MAX_TOKENS' &&
      WARM_TIP_OUTPUT_TOKENS_FALLBACK > WARM_TIP_OUTPUT_TOKENS
    ) {
      const fallback = await requestWarmTipWithRetry({
        ai,
        model,
        prompt,
        maxOutputTokens: WARM_TIP_OUTPUT_TOKENS_FALLBACK,
      });
      if (isCompleteTip(fallback)) {
        const tip = sanitizeTip(fallback.text);
        warmTipCache.set(cacheKey, createWarmTipCacheEntry({ versionKey, tip }));
        return tip;
      }
    }

    console.warn('[warm-tip] using fallback tip', {
      finishReason: first.finishReason || '',
      preview: sanitizeTip(first.text).slice(0, 48),
    });
    const tip = buildLocalWarmTip(user);
    warmTipCache.set(cacheKey, createWarmTipCacheEntry({ versionKey, tip }));
    return tip;
  } catch (error) {
    const err = new Error(error instanceof Error ? error.message : String(error));
    err.detail = {
      stage: 'sdk',
      model,
      ...toErrorDetail(error),
    };
    throw err;
  }
};

const refreshWarmTipInBackground = ({ user, cacheKey, versionKey }) => {
  if (warmTipInFlight.has(cacheKey)) return warmTipInFlight.get(cacheKey);
  const run = withWarmTipConcurrency(() => generateWarmTip({ user, cacheKey, versionKey }))
    .catch((error) => {
      const errorBase = toErrorDetail(error);
      const detail = error && typeof error === 'object' ? error.detail : null;
      console.warn('[warm-tip] async refresh failed', {
        cacheKey,
        error: errorBase.message,
        status: errorBase.status || null,
        detail: detail || null,
      });
      return null;
    })
    .finally(() => {
      warmTipInFlight.delete(cacheKey);
    });
  warmTipInFlight.set(cacheKey, run);
  return run;
};

export const prewarmWarmTipCache = async ({ users, logger = console } = {}) => {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) {
    logger.info('[warm-tip] prewarm skipped: no users');
    return { queued: 0, skipped: 0 };
  }

  let queued = 0;
  let skipped = 0;
  const tasks = [];

  for (const user of list) {
    if (!hasDepressionTendency(user)) {
      skipped += 1;
      continue;
    }
    const { cacheKey, versionKey } = getUserCacheMeta(user);
    const cached = warmTipCache.get(cacheKey);
    if (cached && cached.versionKey === versionKey) {
      skipped += 1;
      continue;
    }
    queued += 1;
    tasks.push(refreshWarmTipInBackground({ user, cacheKey, versionKey }));
  }

  logger.info('[warm-tip] prewarm scheduled', { queued, skipped });
  await Promise.allSettled(tasks);
  logger.info('[warm-tip] prewarm completed', {
    queued,
    skipped,
    cacheSize: warmTipCache.size,
  });
  return { queued, skipped };
};

router.get('/warm-tip', authenticate, async (req, res) => {
  try {
    const { user } = req.auth || {};
    if (!hasDepressionTendency(user)) {
      res.json({ success: true, shouldShow: false, tip: '' });
      return;
    }
    const { cacheKey, versionKey } = getUserCacheMeta(user);
    const cached = warmTipCache.get(cacheKey);

    if (cached && cached.versionKey === versionKey) {
      res.json({ success: true, shouldShow: true, tip: cached.tip, source: 'cache' });
      return;
    }

    if (cached && cached.versionKey !== versionKey) {
      refreshWarmTipInBackground({ user, cacheKey, versionKey });
      res.json({ success: true, shouldShow: true, tip: cached.tip, source: 'cache_profile_changed' });
      return;
    }

    refreshWarmTipInBackground({ user, cacheKey, versionKey });
    res.json({
      success: true,
      shouldShow: true,
      tip: buildLocalWarmTip(user),
      source: 'local_fallback',
    });
  } catch (error) {
    const errorBase = toErrorDetail(error);
    const detail = error && typeof error === 'object' ? error.detail : null;
    console.warn('[warm-tip] generate failed', {
      error: errorBase.message,
      name: errorBase.name,
      status: errorBase.status || null,
      cause: errorBase.cause || null,
      detail: detail || null,
    });
    const { user } = req.auth || {};
    const shouldShow = hasDepressionTendency(user);
    res.json({ success: true, shouldShow, tip: shouldShow ? DEFAULT_WARM_TIP : '' });
  }
});

export default router;
