import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';
import { resetRiskStateForTests } from '../risk/stateStore.js';
import { resetRiskProfileRuntimeForTests } from '../risk/scorer.js';

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
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, { timeoutMs = 2500, intervalMs = 80 } = {}) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error('wait_for_timeout');
};

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const username = `p2_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase2';

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
    uid: Number(loginResult.payload.uid),
    token: String(loginResult.payload.token || ''),
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

test('Phase2: risk evaluation is decoupled from chat/send and available via dedicated API', async () => {
  await withEnv(
    {
      FEATURE_RISK_GUARD_ENABLED: 'true',
    },
    async () => {
      await resetRiskStateForTests();
      resetRiskProfileRuntimeForTests();
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'risk_a');
        const userB = await registerAndLogin(baseUrl, 'risk_b');
        await buildFriendship(baseUrl, userA, userB);

        const sendResult = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: 'limited offer: click http://bit.ly/wallet-verify now',
          },
        });
        assert.equal(sendResult.response.status, 200);
        assert.equal(sendResult.payload.success, true);
        assert.equal(typeof sendResult.payload.data?.id, 'string');
        assert.equal(Object.prototype.hasOwnProperty.call(sendResult.payload, 'risk'), false);

        const realtimeRiskOverview = await waitFor(async () => {
          const overview = await jsonFetch(`${baseUrl}/api/admin/risk/overview`);
          if (overview.response.status !== 200 || overview.payload?.success !== true) return null;
          const byChannel = overview.payload?.data?.counts?.byChannel || {};
          const byTag = overview.payload?.data?.counts?.byTag || {};
          if (Number(byChannel.chat_send_realtime || 0) < 1) return null;
          if (Number(byTag.malicious_link || 0) < 1) return null;
          return overview;
        });
        assert.equal(realtimeRiskOverview.response.status, 200);
        assert.equal(realtimeRiskOverview.payload.success, true);
        assert.equal(
          Number(realtimeRiskOverview.payload?.data?.counts?.byChannel?.chat_send_realtime || 0) >= 1,
          true
        );
        assert.equal(
          Number(realtimeRiskOverview.payload?.data?.counts?.byTag?.malicious_link || 0) >= 1,
          true
        );

        const evaluateResult = await jsonFetch(`${baseUrl}/api/chat/risk/evaluate`, {
          method: 'POST',
          token: userA.token,
          body: {
            targetType: 'private',
            targetUid: userB.uid,
            text: 'limited offer: click http://bit.ly/wallet-verify now',
          },
        });
        assert.equal(evaluateResult.response.status, 200);
        assert.equal(evaluateResult.payload.success, true);
        assert.equal(typeof evaluateResult.payload.data?.score, 'number');
        assert.equal(['low', 'medium', 'high'].includes(evaluateResult.payload.data?.level), true);
        assert.equal(
          Array.isArray(evaluateResult.payload.data?.tags) &&
            evaluateResult.payload.data.tags.some(
              (tag) => tag === 'malicious_link' || tag === 'ads_spam' || tag === 'flooding'
            ),
          true
        );

        const riskProfile = await jsonFetch(
          `${baseUrl}/api/chat/risk?targetType=private&targetUid=${userA.uid}`,
          {
            method: 'GET',
            token: userB.token,
          }
        );
        assert.equal(riskProfile.response.status, 200);
        assert.equal(riskProfile.payload.success, true);
        assert.equal(riskProfile.payload.data?.enabled, true);
        assert.equal(['low', 'medium', 'high'].includes(riskProfile.payload.data?.level), true);
        assert.equal(typeof riskProfile.payload.data?.summary, 'string');

        const riskProfileAgain = await jsonFetch(
          `${baseUrl}/api/chat/risk?targetType=private&targetUid=${userA.uid}`,
          {
            method: 'GET',
            token: userB.token,
          }
        );
        assert.equal(riskProfileAgain.response.status, 200);
        assert.equal(riskProfileAgain.payload.success, true);
        assert.equal(
          ['hit_fresh', 'hit_stale', 'miss_wait', 'miss_refresh_wait'].includes(
            String(riskProfileAgain.payload?.data?.cache?.mode || '')
          ),
          true
        );
      });
    }
  );
});

test('Phase2: chat risk supports ignore and appeal and is visible in admin overview', async () => {
  await withEnv(
    {
      FEATURE_RISK_GUARD_ENABLED: 'true',
    },
    async () => {
      await resetRiskStateForTests();
      resetRiskProfileRuntimeForTests();
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'ignore_a');
        const userB = await registerAndLogin(baseUrl, 'ignore_b');
        await buildFriendship(baseUrl, userA, userB);

        await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: '加我 telegram 领返利：http://bit.ly/bonus-wallet',
          },
        });

        const ignoreResult = await jsonFetch(`${baseUrl}/api/chat/risk/ignore`, {
          method: 'POST',
          token: userB.token,
          body: {
            targetUid: userA.uid,
            targetType: 'private',
            reason: 'manual_ignore_for_test',
            ttlHours: 24,
          },
        });
        assert.equal(ignoreResult.response.status, 200);
        assert.equal(ignoreResult.payload.success, true);
        assert.equal(ignoreResult.payload.data?.ignored, true);

        const profileAfterIgnore = await jsonFetch(
          `${baseUrl}/api/chat/risk?targetType=private&targetUid=${userA.uid}`,
          {
            method: 'GET',
            token: userB.token,
          }
        );
        assert.equal(profileAfterIgnore.response.status, 200);
        assert.equal(profileAfterIgnore.payload.success, true);
        assert.equal(profileAfterIgnore.payload.data?.ignored, true);

        const appealResult = await jsonFetch(`${baseUrl}/api/chat/risk/appeal`, {
          method: 'POST',
          token: userB.token,
          body: {
            targetUid: userA.uid,
            targetType: 'private',
            reason: 'possible_false_positive',
          },
        });
        assert.equal(appealResult.response.status, 200);
        assert.equal(appealResult.payload.success, true);
        assert.equal(appealResult.payload.data?.accepted, true);

        const adminOverview = await jsonFetch(`${baseUrl}/api/admin/risk/overview`);
        assert.equal(adminOverview.response.status, 200);
        assert.equal(adminOverview.payload.success, true);
        assert.equal(Array.isArray(adminOverview.payload.data?.recentAppeals), true);
        assert.equal(adminOverview.payload.data?.recentAppeals?.length >= 1, true);
      });
    }
  );
});

test('Phase2: friends/add detects abnormal add behavior', async () => {
  await withEnv(
    {
      FEATURE_RISK_GUARD_ENABLED: 'true',
    },
    async () => {
      await resetRiskStateForTests();
      resetRiskProfileRuntimeForTests();
      await withServer(async (baseUrl) => {
        const actor = await registerAndLogin(baseUrl, 'add_actor');
        const targets = [];
        for (let index = 0; index < 8; index += 1) {
          const user = await registerAndLogin(baseUrl, `add_t${index}`);
          targets.push(user);
        }

        const riskLevels = [];
        for (const target of targets) {
          const result = await jsonFetch(`${baseUrl}/api/friends/add`, {
            method: 'POST',
            token: actor.token,
            body: { friendUid: target.uid },
          });
          assert.equal(result.response.status, 200);
          assert.equal(result.payload.success, true);
          riskLevels.push(String(result.payload?.risk?.level || 'low'));
        }

        assert.equal(riskLevels.some((level) => level === 'medium' || level === 'high'), true);
      });
    }
  );
});

test('Phase2: risk guard can be disabled and response falls back to old behavior', async () => {
  await withEnv(
    {
      FEATURE_RISK_GUARD_ENABLED: 'false',
    },
    async () => {
      await resetRiskStateForTests();
      resetRiskProfileRuntimeForTests();
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'off_a');
        const userB = await registerAndLogin(baseUrl, 'off_b');
        await buildFriendship(baseUrl, userA, userB);

        const sendResult = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: 'http://bit.ly/fake-wallet',
          },
        });
        assert.equal(sendResult.response.status, 200);
        assert.equal(sendResult.payload.success, true);
        assert.equal(Object.prototype.hasOwnProperty.call(sendResult.payload, 'risk'), false);

        const riskProfile = await jsonFetch(
          `${baseUrl}/api/chat/risk?targetType=private&targetUid=${userA.uid}`,
          {
            method: 'GET',
            token: userB.token,
          }
        );
        assert.equal(riskProfile.response.status, 200);
        assert.equal(riskProfile.payload.success, true);
        assert.equal(riskProfile.payload.data?.enabled, false);
      });
    }
  );
});

