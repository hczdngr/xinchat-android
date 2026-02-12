/**
 * LibreTranslate HTTP client with timeout and retry.
 */

import { logger, serializeError } from '../observability.js';

const DEFAULT_LIBRE_BASE_URL = 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT_MS = 2200;
const DEFAULT_RETRIES = 1;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ECONNREFUSED',
]);

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const buildEndpoint = () => {
  const fromEnv = String(process.env.LIBRETRANSLATE_URL || '').trim();
  if (!fromEnv) return `${DEFAULT_LIBRE_BASE_URL}/translate`;
  const normalized = fromEnv.replace(/\/+$/, '');
  if (normalized.endsWith('/translate')) return normalized;
  return `${normalized}/translate`;
};

const isRetryableNetworkError = (error) => {
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code || '').toUpperCase();
  const causeCode = String(error?.cause?.code || '').toUpperCase();
  if (RETRYABLE_NETWORK_ERROR_CODES.has(code) || RETRYABLE_NETWORK_ERROR_CODES.has(causeCode)) {
    return true;
  }
  const message = String(error.message || '').toLowerCase();
  return /timeout|fetch failed|network|socket|temporar|connection|reset|refused|unreach|enotfound|eai_again/.test(
    message
  );
};

const shouldRetry = ({ status = 0, error = null }) => {
  if (status >= 500 || status === 429) return true;
  return isRetryableNetworkError(error);
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

const createLibreTranslateClient = ({ fetchImpl } = {}) => {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new Error('global fetch is unavailable');
  }

  const endpoint = buildEndpoint();
  const timeoutMs = toPositiveInt(
    process.env.LIBRETRANSLATE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    120,
    20_000
  );
  const maxRetries = toPositiveInt(process.env.LIBRETRANSLATE_RETRY_MAX, DEFAULT_RETRIES, 0, 5);
  const apiKey = String(process.env.LIBRETRANSLATE_API_KEY || '').trim();

  const translate = async ({ text, source = 'auto', target = 'zh', format = 'text' }) => {
    const q = String(text || '').trim();
    if (!q) {
      throw new Error('text is required');
    }
    const payload = {
      q,
      source: String(source || 'auto').trim() || 'auto',
      target: String(target || 'zh').trim() || 'zh',
      format: String(format || 'text').trim() || 'text',
    };
    if (apiKey) {
      payload.api_key = apiKey;
    }

    let lastError = null;
    let attempts = 0;
    for (let index = 0; index <= maxRetries; index += 1) {
      attempts = index + 1;
      try {
        const response = await withTimeout(
          (signal) =>
            fetcher(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal,
            }),
          timeoutMs
        );

        if (!response?.ok) {
          const status = Number(response?.status) || 0;
          let detail = '';
          try {
            const body = await response.json();
            detail = String(body?.error || body?.message || '').trim();
          } catch {
            detail = '';
          }
          const error = new Error(
            detail || `libretranslate_http_${status || 'unknown'}`
          );
          error.status = status;
          if (index < maxRetries && shouldRetry({ status })) {
            lastError = error;
            continue;
          }
          throw error;
        }

        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const translatedText = String(body?.translatedText || '').trim();
        if (!translatedText) {
          const error = new Error('libretranslate_empty_response');
          if (index < maxRetries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        return {
          translatedText,
          detectedLanguage: String(body?.detectedLanguage?.language || '').trim(),
          attempts,
          endpoint,
        };
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastError = new Error(`libretranslate_timeout_${timeoutMs}ms`);
        } else {
          lastError = error;
        }
        const status = Number(lastError?.status) || 0;
        const retryable = shouldRetry({ status, error: lastError });
        if (index < maxRetries && retryable) {
          continue;
        }
        break;
      }
    }

    logger.warn('LibreTranslate request failed', {
      endpoint,
      attempts,
      error: serializeError(lastError),
    });
    throw lastError || new Error('libretranslate_failed');
  };

  return {
    translate,
    config: {
      endpoint,
      timeoutMs,
      maxRetries,
      hasApiKey: Boolean(apiKey),
    },
  };
};

export { createLibreTranslateClient };
