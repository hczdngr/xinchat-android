import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';
import { resetSummaryRuntimeForTests } from '../summary/service.js';

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

const jsonFetch = async (url, { method = 'GET', body, token, adminToken } = {}) => {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
};

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const username = `p4_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase4';

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
    uid: Number(loginResult.payload.uid),
    token: String(loginResult.payload.token || ''),
    username,
  };
};

const makeMutualFriend = async (baseUrl, userA, userB) => {
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

test('Phase4: summary center supports refresh/archive and admin monitoring', async () => {
  await withEnv(
    {
      FEATURE_SUMMARY_CENTER_ENABLED: 'true',
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await resetSummaryRuntimeForTests();
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'sum_a');
        const userB = await registerAndLogin(baseUrl, 'sum_b');
        await makeMutualFriend(baseUrl, userA, userB);

        const sendResult = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userB.token,
          body: {
            senderUid: userB.uid,
            targetUid: userA.uid,
            targetType: 'private',
            type: 'text',
            content: 'phase4 unread message sample',
          },
        });
        assert.equal(sendResult.response.status, 200);
        assert.equal(sendResult.payload.success, true);

        const readResult = await jsonFetch(`${baseUrl}/api/summary`, {
          method: 'GET',
          token: userA.token,
        });
        assert.equal(readResult.response.status, 200);
        assert.equal(readResult.payload.success, true);
        assert.equal(readResult.payload.data?.enabled, true);

        const refreshResult = await jsonFetch(`${baseUrl}/api/summary/refresh`, {
          method: 'POST',
          token: userA.token,
          body: {},
        });
        assert.equal(refreshResult.response.status, 200);
        assert.equal(refreshResult.payload.success, true);
        assert.equal(refreshResult.payload.data?.enabled, true);
        assert.equal(typeof refreshResult.payload.data?.latest?.summaryText, 'string');

        const archiveResult = await jsonFetch(`${baseUrl}/api/summary/archive`, {
          method: 'POST',
          token: userA.token,
          body: {},
        });
        assert.equal(archiveResult.response.status, 200);
        assert.equal(archiveResult.payload.success, true);
        assert.equal(archiveResult.payload.data?.enabled, true);
        assert.equal(Array.isArray(archiveResult.payload.data?.history), true);

        const overviewResult = await jsonFetch(`${baseUrl}/api/chat/overview`, {
          method: 'POST',
          token: userA.token,
          body: { includeSummary: true, readAt: {} },
        });
        assert.equal(overviewResult.response.status, 200);
        assert.equal(overviewResult.payload.success, true);
        assert.equal(typeof overviewResult.payload.summaryCenter?.enabled, 'boolean');
        assert.equal(typeof overviewResult.payload.summaryCenter?.summaryText, 'string');

        const adminResult = await jsonFetch(`${baseUrl}/api/admin/phase4/overview`);
        assert.equal(adminResult.response.status, 200);
        assert.equal(adminResult.payload.success, true);
        assert.equal(adminResult.payload.data?.featureEnabled?.summaryCenter, true);
        assert.equal(typeof adminResult.payload.data?.summary?.runtime?.totalRuns, 'number');
      });
      await resetSummaryRuntimeForTests();
    },
  );
});

test('Phase4: summary center can be disabled by feature flag', async () => {
  await withEnv(
    {
      FEATURE_SUMMARY_CENTER_ENABLED: 'false',
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await resetSummaryRuntimeForTests();
      await withServer(async (baseUrl) => {
        const user = await registerAndLogin(baseUrl, 'sum_off');

        const readResult = await jsonFetch(`${baseUrl}/api/summary`, {
          method: 'GET',
          token: user.token,
        });
        assert.equal(readResult.response.status, 200);
        assert.equal(readResult.payload.success, true);
        assert.equal(readResult.payload.data?.enabled, false);

        const refreshResult = await jsonFetch(`${baseUrl}/api/summary/refresh`, {
          method: 'POST',
          token: user.token,
          body: {},
        });
        assert.equal(refreshResult.response.status, 200);
        assert.equal(refreshResult.payload.success, true);
        assert.equal(refreshResult.payload.data?.enabled, false);

        const overviewResult = await jsonFetch(`${baseUrl}/api/chat/overview`, {
          method: 'POST',
          token: user.token,
          body: { includeSummary: true, readAt: {} },
        });
        assert.equal(overviewResult.response.status, 200);
        assert.equal(overviewResult.payload.success, true);
        assert.equal(overviewResult.payload.summaryCenter?.enabled, false);

        const adminResult = await jsonFetch(`${baseUrl}/api/admin/phase4/overview`);
        assert.equal(adminResult.response.status, 200);
        assert.equal(adminResult.payload.success, true);
        assert.equal(adminResult.payload.data?.featureEnabled?.summaryCenter, false);
      });
      await resetSummaryRuntimeForTests();
    },
  );
});
