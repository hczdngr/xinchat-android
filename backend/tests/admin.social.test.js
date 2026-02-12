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
  const username = `adms_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!adminSocial';

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

test('Admin social overview and personal social tree endpoints work', async () => {
  await withEnv(
    {
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'root');
        const userB = await registerAndLogin(baseUrl, 'friend_b');
        const userC = await registerAndLogin(baseUrl, 'friend_c');
        const userD = await registerAndLogin(baseUrl, 'oneway_d');

        await makeMutualFriend(baseUrl, userA, userB);
        await makeMutualFriend(baseUrl, userA, userC);

        const oneWay = await jsonFetch(`${baseUrl}/api/friends/add`, {
          method: 'POST',
          token: userA.token,
          body: { friendUid: userD.uid },
        });
        assert.equal(oneWay.response.status, 200);
        assert.equal(oneWay.payload.success, true);

        const createGroup = await jsonFetch(`${baseUrl}/api/groups/create`, {
          method: 'POST',
          token: userA.token,
          body: {
            name: 'admin_social_test_group',
            memberUids: [userB.uid, userC.uid],
          },
        });
        assert.equal(createGroup.response.status, 200);
        assert.equal(createGroup.payload.success, true);
        const groupId = Number(createGroup.payload?.group?.id || 0);
        assert.equal(Number.isInteger(groupId) && groupId > 0, true);

        const overview = await jsonFetch(`${baseUrl}/api/admin/social/overview`);
        assert.equal(overview.response.status, 200);
        assert.equal(overview.payload.success, true);
        assert.equal(Number(overview.payload.data?.totals?.users) >= 4, true);
        assert.equal(Number(overview.payload.data?.totals?.mutualFriendEdges) >= 2, true);
        assert.equal(
          Number.isFinite(Number(overview.payload.data?.totals?.oneWayFriendEdges)),
          true
        );
        assert.equal(Number(overview.payload.data?.totals?.groups) >= 1, true);
        assert.equal(Array.isArray(overview.payload.data?.topUsers), true);
        assert.equal(Array.isArray(overview.payload.data?.topGroups), true);

        const treeWithGroups = await jsonFetch(
          `${baseUrl}/api/admin/social/tree?uid=${userA.uid}&depth=2&includeGroups=1`
        );
        assert.equal(treeWithGroups.response.status, 200);
        assert.equal(treeWithGroups.payload.success, true);
        assert.equal(treeWithGroups.payload.data?.rootUid, userA.uid);
        assert.equal(Array.isArray(treeWithGroups.payload.data?.nodes), true);
        assert.equal(Array.isArray(treeWithGroups.payload.data?.edges), true);
        assert.equal(
          treeWithGroups.payload.data.nodes.some((node) => node.id === `u:${userA.uid}`),
          true
        );
        assert.equal(
          treeWithGroups.payload.data.nodes.some((node) => node.id === `u:${userB.uid}`),
          true
        );
        assert.equal(
          treeWithGroups.payload.data.nodes.some(
            (node) => node.type === 'group' && Number(node.gid) === groupId
          ),
          true
        );

        const treeUserOnly = await jsonFetch(
          `${baseUrl}/api/admin/social/tree?uid=${userA.uid}&depth=2&includeGroups=0`
        );
        assert.equal(treeUserOnly.response.status, 200);
        assert.equal(treeUserOnly.payload.success, true);
        assert.equal(
          treeUserOnly.payload.data.nodes.every((node) => node.type === 'user'),
          true
        );
      });
    }
  );
});
