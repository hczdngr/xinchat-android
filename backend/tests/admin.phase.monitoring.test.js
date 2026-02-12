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
  const username = `admphase_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!adminPhase';

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

test('Admin phase monitoring APIs return phase1 overview and phase3 relationship snapshot', async () => {
  await withEnv(
    {
      FEATURE_RELATIONSHIP_OPS_ENABLED: 'true',
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await withServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'root');
        const userB = await registerAndLogin(baseUrl, 'friend_b');
        await makeMutualFriend(baseUrl, userA, userB);

        const createGroup = await jsonFetch(`${baseUrl}/api/groups/create`, {
          method: 'POST',
          token: userA.token,
          body: {
            name: 'admin_phase_group',
            memberUids: [userB.uid],
          },
        });
        assert.equal(createGroup.response.status, 200);
        assert.equal(createGroup.payload.success, true);
        const groupId = Number(createGroup.payload?.group?.id || 0);
        assert.equal(Number.isInteger(groupId) && groupId > 0, true);

        const sendPrivate = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userA.token,
          body: {
            senderUid: userA.uid,
            targetUid: userB.uid,
            targetType: 'private',
            type: 'text',
            content: 'admin phase relationship sample',
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
            content: 'group relationship sample',
          },
        });
        assert.equal(sendGroup.response.status, 200);
        assert.equal(sendGroup.payload.success, true);

        const phase1 = await jsonFetch(`${baseUrl}/api/admin/phase1/overview`);
        assert.equal(phase1.response.status, 200);
        assert.equal(phase1.payload.success, true);
        assert.equal(typeof phase1.payload.data?.users?.total, 'number');
        assert.equal(typeof phase1.payload.data?.requestVolume?.translate, 'number');

        const relationship = await jsonFetch(
          `${baseUrl}/api/admin/ops/relationship?uid=${userA.uid}&scope=all&windowDays=7&includeStable=1&limit=20`
        );
        assert.equal(relationship.response.status, 200);
        assert.equal(relationship.payload.success, true);
        assert.equal(relationship.payload.data?.enabled, true);
        assert.equal(relationship.payload.data?.available, true);
        assert.equal(relationship.payload.data?.selectedUid, userA.uid);
        assert.equal(Array.isArray(relationship.payload.data?.items), true);
        assert.equal(Number(relationship.payload.data?.summary?.totalCandidates) >= 1, true);

        const relItem = relationship.payload.data?.items?.find(
          (item) => Number(item?.targetUid) === userB.uid && item?.targetType === 'private',
        );
        assert.equal(Boolean(relItem), true);

        const nowMs = Date.now() + 10 * DAY_MS;
        const relationshipWindow30 = await jsonFetch(
          `${baseUrl}/api/admin/ops/relationship?uid=${userA.uid}&scope=group&windowDays=30&nowMs=${nowMs}`,
        );
        assert.equal(relationshipWindow30.response.status, 200);
        assert.equal(relationshipWindow30.payload.success, true);
        assert.equal(
          (relationshipWindow30.payload.data?.items || []).every((item) => item.targetType === 'group'),
          true,
        );
      });
    },
  );
});
