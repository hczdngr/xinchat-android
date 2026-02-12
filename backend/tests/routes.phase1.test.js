import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';

const withServer = async (runner) => {
  const server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await runner(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const withEnv = async (nextEnv, runner) => {
  const keys = Object.keys(nextEnv || {});
  const backup = {};
  keys.forEach((key) => {
    backup[key] = process.env[key];
    if (typeof nextEnv[key] === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = String(nextEnv[key]);
    }
  });
  try {
    return await runner();
  } finally {
    keys.forEach((key) => {
      if (typeof backup[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    });
  }
};

const jsonFetch = async (url, { method = 'GET', body, token } = {}) => {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
};

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const username = `p1_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase1';

  const registerResult = await jsonFetch(`${baseUrl}/api/register`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(registerResult.response.status, 200);
  assert.equal(registerResult.payload.success, true);

  const loginResult = await jsonFetch(`${baseUrl}/api/login`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(loginResult.response.status, 200);
  assert.equal(loginResult.payload.success, true);
  return {
    username,
    token: String(loginResult.payload.token || ''),
    uid: Number(loginResult.payload.uid),
  };
};

const buildFriendship = async (baseUrl, userA, userB) => {
  const first = await jsonFetch(`${baseUrl}/api/friends/add`, {
    method: 'POST',
    token: userA.token,
    body: { friendUid: userB.uid },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.success, true);

  const second = await jsonFetch(`${baseUrl}/api/friends/add`, {
    method: 'POST',
    token: userB.token,
    body: { friendUid: userA.uid },
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.payload.success, true);
};

test('POST /api/translate supports profile override and graceful fallback', async () => {
  await withEnv(
    {
      FEATURE_TRANSLATE_PERSONALIZATION_ENABLED: 'true',
      LIBRETRANSLATE_URL: 'http://127.0.0.1:1',
      LIBRETRANSLATE_TIMEOUT_MS: '120',
      LIBRETRANSLATE_RETRY_MAX: '0',
    },
    async () => {
      await withServer(async (baseUrl) => {
        const user = await registerAndLogin(baseUrl, 'translate');
        const translateResult = await jsonFetch(`${baseUrl}/api/translate`, {
          method: 'POST',
          token: user.token,
          body: {
            text: 'hello world',
            targetLang: 'zh',
            style: 'formal',
            explanationLevel: 'short',
            useProfile: true,
            persistProfile: true,
          },
        });
        assert.equal(translateResult.response.status, 200);
        assert.equal(translateResult.payload.success, true);
        assert.equal(typeof translateResult.payload.translated, 'string');
        assert.equal(typeof translateResult.payload.explanation, 'string');
        assert.equal(
          translateResult.payload.data?.degraded === true ||
            translateResult.payload.data?.provider === 'libretranslate',
          true
        );

        const profileResult = await jsonFetch(`${baseUrl}/api/translate/profile`, {
          method: 'GET',
          token: user.token,
        });
        assert.equal(profileResult.response.status, 200);
        assert.equal(profileResult.payload.success, true);
        assert.equal(profileResult.payload.data?.profile?.translateStyle, 'formal');
        assert.equal(profileResult.payload.data?.profile?.explanationLevel, 'short');
      });
    }
  );
});

test('POST /api/chat/reply-suggest returns 3 suggestions with style and confidence', async () => {
  await withEnv(
    {
      FEATURE_REPLY_ASSISTANT_ENABLED: 'true',
    },
    async () => {
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'suggest_a');
        const userB = await registerAndLogin(baseUrl, 'suggest_b');
        await buildFriendship(baseUrl, userA, userB);

        const suggestResult = await jsonFetch(`${baseUrl}/api/chat/reply-suggest`, {
          method: 'POST',
          token: userA.token,
          body: {
            targetType: 'private',
            targetUid: userB.uid,
            text: 'Are you free tonight?',
            style: 'formal',
          },
        });
        assert.equal(suggestResult.response.status, 200);
        assert.equal(suggestResult.payload.success, true);
        assert.equal(suggestResult.payload.data?.enabled, true);
        assert.equal(Array.isArray(suggestResult.payload.data?.suggestions), true);
        assert.equal(suggestResult.payload.data?.suggestions?.length, 3);
        suggestResult.payload.data.suggestions.forEach((entry) => {
          assert.equal(entry.style, 'formal');
          assert.equal(typeof entry.confidence, 'number');
          assert.equal(typeof entry.reason, 'string');
        });
      });
    }
  );
});

test('POST /api/chat/send is decoupled from reply assistant payload', async () => {
  await withEnv(
    {
      FEATURE_REPLY_ASSISTANT_ENABLED: 'true',
    },
    async () => {
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'send_a');
        const userB = await registerAndLogin(baseUrl, 'send_b');
        await buildFriendship(baseUrl, userA, userB);

        const sendResult = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: 'I will send the file tonight.',
            replySuggest: true,
            replyStyle: 'polite',
          },
        });
        assert.equal(sendResult.response.status, 200);
        assert.equal(sendResult.payload.success, true);
        assert.equal(typeof sendResult.payload.data?.id, 'string');
        assert.equal(Object.prototype.hasOwnProperty.call(sendResult.payload, 'assistant'), false);

        const suggestResult = await jsonFetch(`${baseUrl}/api/chat/reply-assistant`, {
          method: 'POST',
          token: userA.token,
          body: {
            targetType: 'private',
            targetUid: userB.uid,
            text: 'Are you free tonight?',
            style: 'polite',
            count: 3,
          },
        });
        assert.equal(suggestResult.response.status, 200);
        assert.equal(suggestResult.payload.success, true);
        assert.equal(Array.isArray(suggestResult.payload.data?.suggestions), true);
        assert.equal(suggestResult.payload.data?.suggestions?.length, 3);
      });
    }
  );
});

