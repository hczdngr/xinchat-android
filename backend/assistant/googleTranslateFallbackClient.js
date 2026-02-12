/**
 * Google Translate web endpoint fallback client.
 * Used only when local LibreTranslate is unavailable.
 */

const DEFAULT_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const DEFAULT_TIMEOUT_MS = 2600;
const DEFAULT_RETRIES = 1;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const withTimeout = async (promiseFactory, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const readTranslatedText = (payload) => {
  const segments = Array.isArray(payload?.[0]) ? payload[0] : [];
  const text = segments
    .map((entry) => (Array.isArray(entry) ? String(entry?.[0] || '') : ''))
    .join('')
    .trim();
  return text;
};

const createGoogleTranslateFallbackClient = ({ fetchImpl } = {}) => {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('global fetch is unavailable');
  }

  const endpoint = String(process.env.TRANSLATE_WEB_FALLBACK_URL || DEFAULT_ENDPOINT).trim();
  const timeoutMs = toPositiveInt(
    process.env.TRANSLATE_WEB_FALLBACK_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    120,
    20_000
  );
  const maxRetries = toPositiveInt(
    process.env.TRANSLATE_WEB_FALLBACK_RETRY_MAX,
    DEFAULT_RETRIES,
    0,
    5
  );

  const translate = async ({ text, source = 'auto', target = 'zh' }) => {
    const q = String(text || '').trim();
    if (!q) {
      throw new Error('text is required');
    }
    const safeSource = String(source || 'auto').trim() || 'auto';
    const safeTarget = String(target || 'zh').trim() || 'zh';

    let lastError = null;
    let attempts = 0;
    for (let index = 0; index <= maxRetries; index += 1) {
      attempts = index + 1;
      try {
        const url = new URL(endpoint);
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', safeSource);
        url.searchParams.set('tl', safeTarget);
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', q);

        const response = await withTimeout(
          (signal) =>
            fetcher(url.toString(), {
              method: 'GET',
              signal,
            }),
          timeoutMs
        );

        if (!response?.ok) {
          const status = Number(response?.status) || 0;
          throw new Error(`google_translate_http_${status || 'unknown'}`);
        }

        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const translatedText = readTranslatedText(payload);
        if (!translatedText) {
          throw new Error('google_translate_empty_response');
        }

        const detectedLanguage = String(payload?.[2] || '').trim();
        return {
          translatedText,
          detectedLanguage,
          attempts,
          endpoint,
        };
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastError = new Error(`google_translate_timeout_${timeoutMs}ms`);
        } else {
          lastError = error;
        }
        if (index < maxRetries) {
          continue;
        }
      }
    }

    throw lastError || new Error('google_translate_failed');
  };

  return {
    translate,
    config: {
      endpoint,
      timeoutMs,
      maxRetries,
    },
  };
};

export { createGoogleTranslateFallbackClient };
