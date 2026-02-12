import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const username = `p3_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase3';

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

test('Phase3: /api/ops/relationship returns friend/group decline cards with recommendations', async () => {
  await withEnv(
    {
      FEATURE_RELATIONSHIP_OPS_ENABLED: 'true',
      RELATIONSHIP_OPS_ALLOW_NOW_OVERRIDE: 'true',
    },
    async () => {
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'ops_a');
        const userB = await registerAndLogin(baseUrl, 'ops_b');
        const userC = await registerAndLogin(baseUrl, 'ops_c');
        await buildFriendship(baseUrl, userA, userB);
        await buildFriendship(baseUrl, userA, userC);

        const groupCreateResult = await jsonFetch(`${baseUrl}/api/groups/create`, {
          method: 'POST',
          token: userA.token,
          body: {
            name: 'phase3_test_group',
            memberUids: [userB.uid],
          },
        });
        assert.equal(groupCreateResult.response.status, 200);
        assert.equal(groupCreateResult.payload.success, true);
        const groupId = Number(groupCreateResult.payload?.group?.id || 0);
        assert.equal(Number.isInteger(groupId) && groupId > 0, true);

        const sendPrivate = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: 'phase3 private interaction',
          },
        });
        assert.equal(sendPrivate.response.status, 200);
        assert.equal(sendPrivate.payload.success, true);

        const sendGroup = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: groupId,
            targetType: 'group',
            type: 'text',
            content: 'phase3 group interaction',
          },
        });
        assert.equal(sendGroup.response.status, 200);
        assert.equal(sendGroup.payload.success, true);

        const nowMs = Date.now() + 10 * DAY_MS;
        const opsResult = await jsonFetch(
          `${baseUrl}/api/ops/relationship?scope=all&windowDays=7&includeStable=1&limit=20&nowMs=${nowMs}`,
          {
            method: 'GET',
            token: userA.token,
          }
        );
        assert.equal(opsResult.response.status, 200);
        assert.equal(opsResult.payload.success, true);
        assert.equal(opsResult.payload.data?.enabled, true);
        assert.equal(opsResult.payload.data?.available, true);
        assert.equal(Array.isArray(opsResult.payload.data?.items), true);
        assert.equal((opsResult.payload.data?.items || []).length >= 2, true);
        assert.equal(
          Number(opsResult.payload.data?.summary?.totalCandidates) >= 3,
          true
        );

        const privateCard = (opsResult.payload.data?.items || []).find(
          (item) => item?.targetType === 'private' && Number(item?.targetUid) === userB.uid
        );
        assert.equal(Boolean(privateCard), true);
        assert.equal(Number(privateCard?.metrics?.prev7d) >= 1, true);
        assert.equal(typeof privateCard?.recommendation?.label, 'string');

        const groupCard = (opsResult.payload.data?.items || []).find(
          (item) => item?.targetType === 'group' && Number(item?.targetUid) === groupId
        );
        assert.equal(Boolean(groupCard), true);
        assert.equal(Number(groupCard?.metrics?.prev7d) >= 1, true);
        assert.equal(typeof groupCard?.recommendation?.reason, 'string');

        const groupScopeResult = await jsonFetch(
          `${baseUrl}/api/ops/relationship?scope=group&windowDays=30&nowMs=${nowMs}`,
          {
            method: 'GET',
            token: userA.token,
          }
        );
        assert.equal(groupScopeResult.response.status, 200);
        assert.equal(groupScopeResult.payload.success, true);
        const groupItems = Array.isArray(groupScopeResult.payload?.data?.items)
          ? groupScopeResult.payload.data.items
          : [];
        assert.equal(groupItems.every((item) => item?.targetType === 'group'), true);
      });
    }
  );
});

test('Phase3: relationship ops can be disabled by feature flag', async () => {
  await withEnv(
    {
      FEATURE_RELATIONSHIP_OPS_ENABLED: 'false',
    },
    async () => {
      await withServer(async (baseUrl) => {
        const user = await registerAndLogin(baseUrl, 'ops_off');
        const result = await jsonFetch(`${baseUrl}/api/ops/relationship`, {
          method: 'GET',
          token: user.token,
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.payload.success, true);
        assert.equal(result.payload.data?.enabled, false);
        assert.equal(Array.isArray(result.payload.data?.items), true);
        assert.equal((result.payload.data?.items || []).length, 0);
      });
    }
  );
});
