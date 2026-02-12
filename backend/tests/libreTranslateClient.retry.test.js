import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibreTranslateClient } from '../assistant/libreTranslateClient.js';

const withEnv = async (patch, task) => {
  const backup = {};
  Object.keys(patch).forEach((key) => {
    backup[key] = process.env[key];
    const next = patch[key];
    if (typeof next === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = String(next);
    }
  });
  try {
    return await task();
  } finally {
    Object.keys(patch).forEach((key) => {
      if (typeof backup[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    });
  }
};

test('libreTranslateClient should not retry for 4xx responses', async () => {
  await withEnv(
    {
      LIBRETRANSLATE_URL: 'http://127.0.0.1:5000',
      LIBRETRANSLATE_RETRY_MAX: '3',
    },
    async () => {
      let calls = 0;
      const client = createLibreTranslateClient({
        fetchImpl: async () => {
          calls += 1;
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_target_language' }),
          };
        },
      });

      await assert.rejects(
        async () => client.translate({ text: 'hello', source: 'en', target: 'x-invalid' }),
        /invalid_target_language/
      );
      assert.equal(calls, 1);
    }
  );
});

test('libreTranslateClient retries transient network errors', async () => {
  await withEnv(
    {
      LIBRETRANSLATE_URL: 'http://127.0.0.1:5000',
      LIBRETRANSLATE_RETRY_MAX: '2',
    },
    async () => {
      let calls = 0;
      const client = createLibreTranslateClient({
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('socket timeout');
            error.code = 'ETIMEDOUT';
            throw error;
          }
          return {
            ok: true,
            json: async () => ({ translatedText: '你好' }),
          };
        },
      });

      const result = await client.translate({ text: 'hello', source: 'en', target: 'zh' });
      assert.equal(result.translatedText, '你好');
      assert.equal(result.attempts, 2);
      assert.equal(calls, 2);
    }
  );
});
