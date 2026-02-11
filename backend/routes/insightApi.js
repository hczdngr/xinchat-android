/**
 * 模块说明：洞察 API 模块：提供暖心提示、百科检索与识图能力。
 */


import express from 'express';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { createAuthenticateMiddleware } from './session.js';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Insight' });

// readPositiveInt：读取持久化或缓存数据。
const readPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

const GEMINI_FLASH_PREVIEW_MODEL = 'gemini-2.5-flash';
const GEMINI_VISION_MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3-flash-preview',
  'gemini-3-pro-image-preview',
  'gemini-3-pro-preview',
];
const HARDCODED_GEMINI_API_KEY_B64 =
  'QUl6YVN5QV81RndRNWFwZlpseG9kdHhRakRNNk92dlNYRFAwZURv';
const DEFAULT_WARM_TIP =
  '\u4f60\u5e76\u4e0d\u5b64\u5355\u3002\u8bf7\u5148\u7167\u987e\u597d\u81ea\u5df1\uff0c\u5fc5\u8981\u65f6\u53ca\u65f6\u8054\u7cfb\u5bb6\u4eba\u670b\u53cb\u6216\u4e13\u4e1a\u5fc3\u7406\u652f\u6301\u3002';
const WARM_TIP_OUTPUT_TOKENS = 3000;
const WARM_TIP_OUTPUT_TOKENS_FALLBACK = 3000;
// WARM_TIP_MAX_RETRIES?处理 WARM_TIP_MAX_RETRIES 相关逻辑。
const WARM_TIP_MAX_RETRIES = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_MAX_RETRIES || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
})();
// WARM_TIP_RETRY_DELAY_MS?处理 WARM_TIP_RETRY_DELAY_MS 相关逻辑。
const WARM_TIP_RETRY_DELAY_MS = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_RETRY_DELAY_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 700;
})();
// WARM_TIP_REQUEST_TIMEOUT_MS?处理 WARM_TIP_REQUEST_TIMEOUT_MS 相关逻辑。
const WARM_TIP_REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.WARM_TIP_REQUEST_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 30000;
})();
const WARM_TIP_MAX_PARALLEL = 6;
const WARM_TIP_INPUT_TOKENS = 3000;
const WARM_TIP_APPROX_CHARS_PER_TOKEN = 3;
const OBJECT_DETECT_MAX_BYTES = readPositiveInt(
  process.env.OBJECT_DETECT_MAX_BYTES,
  8 * 1024 * 1024,
  64 * 1024
);
const OBJECT_DETECT_OUTPUT_TOKENS = readPositiveInt(process.env.OBJECT_DETECT_OUTPUT_TOKENS, 2700, 600);
const OBJECT_DETECT_REQUEST_TIMEOUT_MS = readPositiveInt(
  process.env.OBJECT_DETECT_REQUEST_TIMEOUT_MS,
  Math.min(WARM_TIP_REQUEST_TIMEOUT_MS, 18000),
  1000
);
const OBJECT_DETECT_MAX_PARALLEL = readPositiveInt(process.env.OBJECT_DETECT_MAX_PARALLEL, 8, 1);
const OBJECT_DETECT_CACHE_TTL_MS = readPositiveInt(
  process.env.OBJECT_DETECT_CACHE_TTL_MS,
  5 * 60 * 1000,
  1000
);
const OBJECT_DETECT_CACHE_MAX_ITEMS = readPositiveInt(
  process.env.OBJECT_DETECT_CACHE_MAX_ITEMS,
  800,
  10
);
const OBJECT_DETECT_MAX_MODEL_CANDIDATES = readPositiveInt(
  process.env.OBJECT_DETECT_MAX_MODEL_CANDIDATES,
  3,
  1
);
const OBJECT_DETECT_RETRIES = readPositiveInt(process.env.OBJECT_DETECT_RETRIES, 1, 0);
const OBJECT_DETECT_RETRY_DELAY_MS = readPositiveInt(process.env.OBJECT_DETECT_RETRY_DELAY_MS, 450, 100);
const OBJECT_DETECT_RETRYABLE_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);
const OBJECT_DETECT_NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ECONNREFUSED',
]);
const OBJECT_DETECT_PROMPT = [
  '\u4f60\u662f\u56fe\u50cf\u8bc6\u522b\u52a9\u624b\u3002',
  '\u8bf7\u8bc6\u522b\u8fd9\u5f20\u56fe\u7247\u4e2d\u7684\u4e3b\u8981\u7269\u4f53\uff0c\u8f93\u51fa\u4e25\u683c JSON\uff0c\u4e0d\u8981 markdown \u3002',
  '\u8f93\u51fa schema:',
  '{"summary":"string","scene":"string","objects":[{"name":"string","confidence":0.0,"attributes":"string","position":"string"}]}',
  '\u8981\u6c42\uff1a',
  '1) summary \u7528\u4e2d\u6587\u4e00\u53e5\u8bdd\u6982\u62ec',
  '2) objects \u53ea\u4fdd\u7559 1-8 \u4e2a\u4e3b\u8981\u7269\u4f53',
  '3) confidence \u8303\u56f4 0-1\uff0c\u4e0d\u786e\u5b9a\u65f6\u8981\u964d\u4f4e',
  '4) \u5982\u679c\u96be\u4ee5\u5224\u65ad\uff0c\u5728 summary \u4e2d\u660e\u786e\u8bf4\u660e',
].join('\n');
const ENCYCLOPEDIA_QUERY_MAX_LENGTH = 72;
const ENCYCLOPEDIA_REQUEST_TIMEOUT_MS = 15000;

const warmTipCache = new Map();
const warmTipInFlight = new Map();
let warmTipActive = 0;
const warmTipQueue = [];
const objectDetectCache = new Map();
const objectDetectInFlight = new Map();
let objectDetectActive = 0;
const objectDetectQueue = [];
let aiClient = null;
let aiClientKey = '';

// decodeHardcodedGeminiKey?处理 decodeHardcodedGeminiKey 相关逻辑。
const decodeHardcodedGeminiKey = () => {
  try {
    return Buffer.from(HARDCODED_GEMINI_API_KEY_B64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
};

// toErrorDetail?处理 toErrorDetail 相关逻辑。
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

// toShortText?处理 toShortText 相关逻辑。
const toShortText = (value, max = 90) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

// extractGeminiText：提取请求中的关键信息。
const extractGeminiText = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const merged = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (merged) return merged;
  }
  return '';
};

// parseModelJson：解析并校验输入值。
const parseModelJson = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const noFence = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const extractBalancedObject = (value) => {
    const textValue = String(value || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < textValue.length; i += 1) {
      const char = textValue[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (char === '}') {
        if (depth <= 0) continue;
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return textValue.slice(start, i + 1);
        }
      }
    }
    return '';
  };

  const direct = tryParse(noFence);
  if (direct && typeof direct === 'object') return direct;
  if (typeof direct === 'string') {
    const parsedDirectString = tryParse(direct);
    if (parsedDirectString && typeof parsedDirectString === 'object') return parsedDirectString;
  }

  const balanced = extractBalancedObject(noFence);
  if (balanced) {
    const parsedBalanced = tryParse(balanced);
    if (parsedBalanced && typeof parsedBalanced === 'object') return parsedBalanced;
  }

  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = noFence.slice(start, end + 1);
    const parsed = tryParse(sliced);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
};

// normalizeBase64String：归一化外部输入。
const normalizeBase64String = (value) => {
  const text = String(value || '');
  if (!text) return '';
  return /\s/.test(text) ? text.replace(/\s+/g, '') : text;
};

// parseImageInput：解析并校验输入值。
const parseImageInput = (body = {}) => {
  const fromDataUrl = String(body?.image || body?.imageDataUrl || '').trim();
  if (fromDataUrl.startsWith('data:')) {
    const matched = fromDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (matched) {
      return {
        mimeType: String(matched[1] || '').trim().toLowerCase(),
        base64: normalizeBase64String(matched[2]),
      };
    }
  }

  const base64 = normalizeBase64String(body?.base64 || body?.imageBase64 || '');
  const mimeType = String(body?.mimeType || body?.mime || 'image/jpeg').trim().toLowerCase();
  if (!base64) return null;
  return { mimeType, base64 };
};

// normalizeConfidenceValue：归一化外部输入。
const normalizeConfidenceValue = (raw) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  let next = parsed;
  // Model may return 0-100 even when asked for 0-1.
  if (next > 1 && next <= 100) {
    next /= 100;
  }
  if (next < 0) return 0;
  if (next > 1) return 1;
  return next;
};

// toConfidence?处理 toConfidence 相关逻辑。
const toConfidence = (value) => {
  if (typeof value === 'number') {
    return normalizeConfidenceValue(value);
  }
  const text = String(value ?? '').trim();
  if (!text) return 0;

  const normalized = text.replace(/％/g, '%').replace(/,/g, '.');
  const hasPercent = normalized.includes('%');
  const matched = normalized.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
  if (!matched) return 0;

  const parsed = Number(matched[0]);
  if (!Number.isFinite(parsed)) return 0;
  const raw = hasPercent ? parsed / 100 : parsed;
  return normalizeConfidenceValue(raw);
};

// normalizeObjectDetectResult：归一化外部输入。
const normalizeObjectDetectResult = (parsed, fallbackSummary = '') => {
  const summary = toShortText(parsed?.summary || fallbackSummary || '', 220);
  const scene = toShortText(parsed?.scene || '', 120);
  const objects = (Array.isArray(parsed?.objects) ? parsed.objects : [])
    .map((item) => ({
      name: toShortText(item?.name || item?.label || '', 60),
      confidence: toConfidence(item?.confidence),
      attributes: toShortText(item?.attributes || item?.description || '', 160),
      position: toShortText(item?.position || '', 80),
    }))
    .filter((item) => item.name)
    .slice(0, 8);

  return {
    summary: summary || '\u6682\u672a\u8bc6\u522b\u5230\u660e\u786e\u7269\u4f53',
    scene,
    objects,
  };
};

// buildVisionModelCandidates：构建对外输出数据。
const buildVisionModelCandidates = (requestedModel, maxCount = OBJECT_DETECT_MAX_MODEL_CANDIDATES) => {
  const preferred = String(requestedModel || '').trim();
  const list = [preferred, ...GEMINI_VISION_MODEL_FALLBACKS].filter(Boolean);
  const unique = Array.from(new Set(list));
  const safeMax = Number.isFinite(Number(maxCount)) ? Math.max(1, Math.floor(Number(maxCount))) : unique.length;
  return unique.slice(0, safeMax);
};

// stripHtml?处理 stripHtml 相关逻辑。
const stripHtml = (value) =>
  String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

// normalizeWikiEntry：归一化外部输入。
const normalizeWikiEntry = (entry = {}, query = '', source = '') => {
  const title = toShortText(entry?.title || query, 80) || query;
  const summary = toShortText(entry?.extract || entry?.summary || '', 1200);
  const snippet = toShortText(entry?.snippet || '', 220);
  const url = toShortText(
    entry?.url ||
      entry?.content_urls?.desktop?.page ||
      entry?.content_urls?.mobile?.page ||
      '',
    260
  );
  const thumbnail = toShortText(
    entry?.thumbnail || entry?.thumbnail?.source || entry?.originalimage?.source || '',
    260
  );
  return {
    query,
    title: title || query,
    summary: summary || snippet || `${query}暂无详细百科摘要。`,
    snippet,
    url,
    thumbnail,
    source,
  };
};

// fetchWikiSummary?处理 fetchWikiSummary 相关逻辑。
const fetchWikiSummary = async ({ host, query, sourceLabel }) => {
  const searchUrl = `https://${host}/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=1&srsearch=${encodeURIComponent(
    query
  )}`;
  const searchResponse = await withTimeout(
    fetch(searchUrl, {
      headers: { 'User-Agent': 'XinChatAndroid/1.0' },
    }),
    ENCYCLOPEDIA_REQUEST_TIMEOUT_MS,
    `encyclopedia-search-${host}`
  );
  const searchPayload = await searchResponse.json().catch(() => ({}));
  if (!searchResponse.ok) {
    throw new Error(
      String(searchPayload?.error?.info || searchPayload?.message || `wiki search ${host} failed`)
    );
  }
  const first = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search[0] : null;
  if (!first?.title) return null;

  const title = String(first.title || '').trim();
  const snippet = stripHtml(first?.snippet || '');
  const pageUrl = `https://${host}/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
  const summaryUrl = `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const summaryResponse = await withTimeout(
    fetch(summaryUrl, {
      headers: { 'User-Agent': 'XinChatAndroid/1.0' },
    }),
    ENCYCLOPEDIA_REQUEST_TIMEOUT_MS,
    `encyclopedia-summary-${host}`
  );
  const summaryPayload = await summaryResponse.json().catch(() => ({}));
  if (!summaryResponse.ok) {
    return normalizeWikiEntry(
      {
        title,
        snippet,
        url: pageUrl,
      },
      query,
      sourceLabel
    );
  }

  return normalizeWikiEntry(
    {
      title: summaryPayload?.title || title,
      extract: summaryPayload?.extract,
      summary: summaryPayload?.description,
      snippet,
      url:
        summaryPayload?.content_urls?.desktop?.page ||
        summaryPayload?.content_urls?.mobile?.page ||
        pageUrl,
      thumbnail: summaryPayload?.thumbnail?.source || summaryPayload?.originalimage?.source || '',
    },
    query,
    sourceLabel
  );
};

// clipByApproxTokens?处理 clipByApproxTokens 相关逻辑。
const clipByApproxTokens = (text, tokenLimit) => {
  const value = String(text || '');
  if (!value) return '';
  const limit = Math.max(1, Math.floor(Number(tokenLimit || 0) * WARM_TIP_APPROX_CHARS_PER_TOKEN));
  if (!Number.isFinite(limit)) return value;
  return value.length > limit ? value.slice(0, limit) : value;
};

// sleep?处理 sleep 相关逻辑。
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// withTimeout?处理 withTimeout 相关逻辑。
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

// getAiClient：获取并返回目标数据。
const getAiClient = (apiKey) => {
  if (!aiClient || aiClientKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClientKey = apiKey;
  }
  return aiClient;
};

// withWarmTipConcurrency?处理 withWarmTipConcurrency 相关逻辑。
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

// buildObjectDetectCacheKey：构建对外输出数据。
const buildObjectDetectCacheKey = ({ mimeType, base64 }) => {
  const hash = crypto.createHash('sha256');
  hash.update(String(mimeType || 'image/jpeg'));
  hash.update('|');
  hash.update(String(base64 || ''));
  return hash.digest('hex');
};

// getObjectDetectCacheEntry：获取并返回目标数据。
const getObjectDetectCacheEntry = (cacheKey) => {
  const entry = objectDetectCache.get(cacheKey);
  if (!entry) return null;
  if (!entry.expiresAtMs || entry.expiresAtMs <= Date.now()) {
    objectDetectCache.delete(cacheKey);
    return null;
  }
  objectDetectCache.delete(cacheKey);
  objectDetectCache.set(cacheKey, entry);
  return entry;
};

// setObjectDetectCacheEntry：设置运行时状态。
const setObjectDetectCacheEntry = (cacheKey, data) => {
  objectDetectCache.set(cacheKey, {
    data,
    expiresAtMs: Date.now() + OBJECT_DETECT_CACHE_TTL_MS,
  });
  while (objectDetectCache.size > OBJECT_DETECT_CACHE_MAX_ITEMS) {
    const firstKey = objectDetectCache.keys().next().value;
    if (!firstKey) break;
    objectDetectCache.delete(firstKey);
  }
};

// cleanupObjectDetectCache?处理 cleanupObjectDetectCache 相关逻辑。
const cleanupObjectDetectCache = () => {
  const now = Date.now();
  for (const [cacheKey, entry] of objectDetectCache.entries()) {
    if (!entry || entry.expiresAtMs <= now) {
      objectDetectCache.delete(cacheKey);
    }
  }
};

// withObjectDetectConcurrency?处理 withObjectDetectConcurrency 相关逻辑。
const withObjectDetectConcurrency = async (task) =>
  new Promise((resolve, reject) => {
    const run = () => {
      objectDetectActive += 1;
      Promise.resolve()
        .then(task)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          objectDetectActive = Math.max(0, objectDetectActive - 1);
          const next = objectDetectQueue.shift();
          if (next) next();
        });
    };

    if (objectDetectActive < OBJECT_DETECT_MAX_PARALLEL) {
      run();
      return;
    }
    objectDetectQueue.push(run);
  });

// isObjectDetectRetryableError：判断条件是否成立。
const isObjectDetectRetryableError = (error) => {
  const status = Number(error?.status || error?.statusCode || 0);
  if (OBJECT_DETECT_RETRYABLE_STATUSES.has(status)) return true;

  const message = String(error?.message || '').toLowerCase();
  if (
    /timeout|fetch failed|sending request|network|socket|temporar|connection/i.test(message)
  ) {
    return true;
  }

  const code = String(error?.code || '').toUpperCase();
  if (OBJECT_DETECT_NETWORK_ERROR_CODES.has(code)) return true;
  const causeCode = String(error?.cause?.code || '').toUpperCase();
  if (OBJECT_DETECT_NETWORK_ERROR_CODES.has(causeCode)) return true;
  return false;
};

// mapObjectDetectError?处理 mapObjectDetectError 相关逻辑。
const mapObjectDetectError = (error) => {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || '');
  const lower = message.toLowerCase();
  if (status === 401 || status === 403 || /permission|unauth|api key|credential/i.test(lower)) {
    return { statusCode: 502, publicMessage: '\u8bc6\u56fe\u670d\u52a1\u8ba4\u8bc1\u5931\u8d25\u3002' };
  }
  if (status === 429) {
    return { statusCode: 503, publicMessage: '\u8bc6\u56fe\u670d\u52a1\u5fd9\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002' };
  }
  if (isObjectDetectRetryableError(error)) {
    return { statusCode: 504, publicMessage: '\u8bc6\u56fe\u670d\u52a1\u7f51\u7edc\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002' };
  }
  return { statusCode: 502, publicMessage: '\u56fe\u50cf\u8bc6\u522b\u670d\u52a1\u4e0d\u53ef\u7528\u3002' };
};

// detectObjectsByModelCandidates?处理 detectObjectsByModelCandidates 相关逻辑。
const detectObjectsByModelCandidates = async ({ ai, modelCandidates, input }) => {
  let lastError = null;

  for (const model of modelCandidates) {
    let modelError = null;
    for (let attempt = 0; attempt <= OBJECT_DETECT_RETRIES; attempt += 1) {
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: [
              {
                role: 'user',
                parts: [
                  { text: OBJECT_DETECT_PROMPT },
                  {
                    inlineData: {
                      mimeType: input.mimeType,
                      data: input.base64,
                    },
                  },
                ],
              },
            ],
            config: {
              temperature: 0.2,
              maxOutputTokens: OBJECT_DETECT_OUTPUT_TOKENS,
            },
          }),
          OBJECT_DETECT_REQUEST_TIMEOUT_MS,
          `object-detect generation (${model})`
        );

        const text = String(response?.text || '').trim() || extractGeminiText(response);
        const parsed = parseModelJson(text);
        const data = normalizeObjectDetectResult(parsed || {}, text);
        return {
          ...data,
          model,
        };
      } catch (error) {
        modelError = error;
        lastError = error;
        const status = Number(error?.status || 0);
        const message = String(error?.message || '');
        const retryable = isObjectDetectRetryableError(error);
        console.warn('[object-detect] model failed', {
          model,
          attempt: attempt + 1,
          status: status || null,
          message: message || 'unknown',
          retryable,
        });
        if (!retryable || attempt >= OBJECT_DETECT_RETRIES) {
          break;
        }
        await sleep(OBJECT_DETECT_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    if (modelError && !isObjectDetectRetryableError(modelError)) {
      break;
    }
  }

  throw lastError || new Error('object detect failed');
};

setInterval(cleanupObjectDetectCache, 60 * 1000).unref?.();

// sanitizeTip：清洗不可信输入。
const sanitizeTip = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '')
    .trim();

// isCompleteTip：判断条件是否成立。
const isCompleteTip = ({ text, finishReason }) => {
  if (!sanitizeTip(text)) return false;
  if (String(finishReason || '').toUpperCase() === 'MAX_TOKENS') return false;
  return true;
};

// hasDepressionTendency：判断是否具备指定状态。
const hasDepressionTendency = (user) => {
  const analysis = user?.aiProfile?.analysis || {};
  const depression = analysis?.depressionTendency || {};
  const level = String(depression?.level || '').toLowerCase();
  return level === 'medium' || level === 'high';
};

// buildLocalWarmTip：构建对外输出数据。
const buildLocalWarmTip = (user) => {
  const name = toShortText(user?.nickname || user?.username || '\u4f60', 20) || '\u4f60';
  return `${name}\uff0c\u5148\u8ba9\u81ea\u5df1\u6162\u4e0b\u6765\uff0c\u54ea\u6015\u53ea\u662f\u77ed\u6682\u4f11\u606f\u4e5f\u5f88\u91cd\u8981\u3002\u4f60\u53ef\u4ee5\u968f\u65f6\u8054\u7cfb\u4fe1\u4efb\u7684\u5bb6\u4eba\u670b\u53cb\u6216\u4e13\u4e1a\u652f\u6301\u3002`;
};

// buildUserSummary：构建对外输出数据。
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

// buildPrompt：构建对外输出数据。
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

// requestWarmTipOnce?处理 requestWarmTipOnce 相关逻辑。
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

// requestWarmTipWithRetry?处理 requestWarmTipWithRetry 相关逻辑。
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

// createWarmTipCacheEntry：创建对象或中间件。
const createWarmTipCacheEntry = ({ versionKey, tip }) => ({
  versionKey,
  tip,
  updatedAt: new Date().toISOString(),
});

// getUserCacheMeta：获取并返回目标数据。
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

// generateWarmTip?处理 generateWarmTip 相关逻辑。
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

// refreshWarmTipInBackground?处理 refreshWarmTipInBackground 相关逻辑。
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

// 路由：GET /warm-tip。
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

// 路由：GET /encyclopedia。
router.get('/encyclopedia', authenticate, async (req, res) => {
  try {
    const rawQuery = String(req.query?.query || req.query?.q || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rawQuery) {
      res.status(400).json({ success: false, message: '缺少 query 参数。' });
      return;
    }
    const query = rawQuery.slice(0, ENCYCLOPEDIA_QUERY_MAX_LENGTH);
    const providers = [
      { host: 'zh.wikipedia.org', sourceLabel: '维基百科(中文)' },
      { host: 'en.wikipedia.org', sourceLabel: 'Wikipedia(English)' },
    ];

    let result = null;
    for (const provider of providers) {
      try {
        result = await fetchWikiSummary({
          host: provider.host,
          query,
          sourceLabel: provider.sourceLabel,
        });
        if (result) break;
      } catch (error) {
        // Try next provider.
      }
    }

    if (!result) {
      const fallbackUrl = `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
      const fallback = normalizeWikiEntry(
        {
          title: query,
          summary: `${query} 暂无稳定百科摘要，可点击来源查看搜索结果。`,
          url: fallbackUrl,
        },
        query,
        '维基搜索'
      );
      res.json({ success: true, data: fallback });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    const detail = toErrorDetail(error);
    console.warn('[encyclopedia] failed', detail);
    res.status(500).json({
      success: false,
      message: '百科检索失败，请稍后重试。',
    });
  }
});

// 路由：POST /object-detect。
router.post('/object-detect', authenticate, async (req, res) => {
  try {
    const input = parseImageInput(req.body || {});
    if (!input?.base64) {
      res.status(400).json({ success: false, message: '\u7f3a\u5c11\u56fe\u50cf\u6570\u636e\u3002' });
      return;
    }
    if (!input.mimeType.startsWith('image/')) {
      res.status(400).json({ success: false, message: '\u4ec5\u652f\u6301\u56fe\u7247\u683c\u5f0f\u3002' });
      return;
    }

    const imageBytes = Math.floor((input.base64.length * 3) / 4);
    if (!Number.isFinite(imageBytes) || imageBytes <= 0) {
      res.status(400).json({ success: false, message: '\u56fe\u50cf\u6570\u636e\u65e0\u6548\u3002' });
      return;
    }
    if (imageBytes > OBJECT_DETECT_MAX_BYTES) {
      res
        .status(413)
        .json({ success: false, message: '\u56fe\u50cf\u8fc7\u5927\uff0c\u8bf7\u63a7\u5236\u5728 8MB \u4ee5\u5185\u3002' });
      return;
    }

    const apiKey = String(process.env.GEMINI_API_KEY || decodeHardcodedGeminiKey()).trim();
    if (!apiKey) {
      res.status(503).json({ success: false, message: 'GEMINI_API_KEY \u672a\u914d\u7f6e\u3002' });
      return;
    }

    const cacheKey = buildObjectDetectCacheKey(input);
    const cachedEntry = getObjectDetectCacheEntry(cacheKey);
    if (cachedEntry?.data) {
      res.json({
        success: true,
        data: cachedEntry.data,
      });
      return;
    }

    const runDetectOnce = async () => {
      const requestedModel = String(process.env.GEMINI_VISION_MODEL || GEMINI_FLASH_PREVIEW_MODEL).trim();
      const modelCandidates = buildVisionModelCandidates(requestedModel);
      const ai = getAiClient(apiKey);
      return detectObjectsByModelCandidates({
        ai,
        modelCandidates,
        input,
      });
    };

    const inFlightTask = objectDetectInFlight.get(cacheKey);
    if (inFlightTask) {
      try {
        const dedupData = await inFlightTask;
        res.json({
          success: true,
          data: dedupData,
        });
        return;
      } catch (error) {
        const mapped = mapObjectDetectError(error);
        res.status(mapped.statusCode).json({
          success: false,
          message: mapped.publicMessage,
        });
        return;
      }
    }

    const task = withObjectDetectConcurrency(runDetectOnce)
      .then((data) => {
        setObjectDetectCacheEntry(cacheKey, data);
        return data;
      })
      .finally(() => {
        objectDetectInFlight.delete(cacheKey);
      });
    objectDetectInFlight.set(cacheKey, task);

    try {
      const data = await task;
      res.json({
        success: true,
        data,
      });
      return;
    } catch (error) {
      const mapped = mapObjectDetectError(error);
      res.status(mapped.statusCode).json({
        success: false,
        message: mapped.publicMessage,
      });
      return;
    }

  } catch (error) {
    const errorBase = toErrorDetail(error);
    const detail = error && typeof error === 'object' ? error.detail : null;
    console.warn('[object-detect] failed', {
      error: errorBase.message,
      name: errorBase.name,
      status: errorBase.status || null,
      cause: errorBase.cause || null,
      detail: detail || null,
    });
    res.status(500).json({ success: false, message: '\u7269\u4f53\u8bc6\u522b\u5931\u8d25\u3002' });
  }
});

export default router;
