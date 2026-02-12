import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTranslateFallbackClient } from '../assistant/googleTranslateFallbackClient.js';

test('googleTranslateFallbackClient parses translated text and detected language', async () => {
  const client = createGoogleTranslateFallbackClient({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [[['你好世界', 'hello world', null, null, 10]], null, 'en'],
    }),
  });

  const result = await client.translate({
    text: 'hello world',
    source: 'en',
    target: 'zh',
  });
  assert.equal(result.translatedText, '你好世界');
  assert.equal(result.detectedLanguage, 'en');
  assert.equal(result.attempts, 1);
});

test('googleTranslateFallbackClient retries after transient error', async () => {
  let calls = 0;
  const client = createGoogleTranslateFallbackClient({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('fetch failed');
      }
      return {
        ok: true,
        json: async () => [[['你好', 'hello']], null, 'en'],
      };
    },
  });

  const result = await client.translate({
    text: 'hello',
    source: 'en',
    target: 'zh',
  });
  assert.equal(result.translatedText, '你好');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});
