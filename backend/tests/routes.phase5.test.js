import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app } from '../index.js';
import { resetRecoRuntimeConfigForTests, resetRecoStateForTests } from '../reco/index.js';

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
  const username = `p5_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase5';

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

const resetFeatureOverrides = async (baseUrl) => {
  const flagsResp = await jsonFetch(`${baseUrl}/api/admin/feature-flags`);
  assert.equal(flagsResp.response.status, 200);
  assert.equal(flagsResp.payload.success, true);
  const names = Array.isArray(flagsResp.payload.data?.definitions)
    ? flagsResp.payload.data.definitions.map((item) => String(item.name || '')).filter(Boolean)
    : [];
  const changes = {};
  names.forEach((name) => {
    changes[name] = null;
  });
  const updateResp = await jsonFetch(`${baseUrl}/api/admin/feature-flags/update`, {
    method: 'POST',
    body: { changes },
  });
  assert.equal(updateResp.response.status, 200);
  assert.equal(updateResp.payload.success, true);
};

test('Phase5: reco decision/feedback/admin overview and online switch are functional', async () => {
  await withEnv(
    {
      FEATURE_RECO_VW_ENABLED: 'true',
      FEATURE_RECO_VW_SHADOW_ENABLED: 'true',
      FEATURE_RECO_VW_ONLINE_ENABLED: 'false',
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await resetRecoRuntimeConfigForTests();
      await resetRecoStateForTests();
      await withServer(async (baseUrl) => {
        await resetFeatureOverrides(baseUrl);

        const userA = await registerAndLogin(baseUrl, 'a');
        const userB = await registerAndLogin(baseUrl, 'b');
        const userC = await registerAndLogin(baseUrl, 'c');
        await makeMutualFriend(baseUrl, userA, userB);
        await makeMutualFriend(baseUrl, userA, userC);

        const sendB = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userB.token,
          body: {
            senderUid: userB.uid,
            targetUid: userA.uid,
            targetType: 'private',
            type: 'text',
            content: 'phase5 message b->a',
          },
        });
        assert.equal(sendB.response.status, 200);
        assert.equal(sendB.payload.success, true);

        const sendC = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userC.token,
          body: {
            senderUid: userC.uid,
            targetUid: userA.uid,
            targetType: 'private',
            type: 'text',
            content: 'phase5 message c->a',
          },
        });
        assert.equal(sendC.response.status, 200);
        assert.equal(sendC.payload.success, true);

        const overview = await jsonFetch(`${baseUrl}/api/chat/overview`, {
          method: 'POST',
          token: userA.token,
          body: {
            includeSummary: false,
            includeReco: true,
            readAt: {},
          },
        });
        assert.equal(overview.response.status, 200);
        assert.equal(overview.payload.success, true);
        assert.equal(Array.isArray(overview.payload.data), true);
        assert.equal((overview.payload.data || []).length >= 2, true);
        assert.equal(typeof overview.payload.reco?.mode, 'string');

        const candidates = (overview.payload.data || []).map((item) => ({
          uid: Number(item.uid),
          targetUid: Number(item.uid),
          targetType: item.targetType,
          unread: Number(item.unread || 0),
          latest: item.latest || null,
        }));
        const decision = await jsonFetch(`${baseUrl}/api/reco/decision`, {
          method: 'POST',
          token: userA.token,
          body: {
            source: 'phase5_test',
            candidates,
          },
        });
        assert.equal(decision.response.status, 200);
        assert.equal(decision.payload.success, true);
        assert.equal(typeof decision.payload.data?.decisionId, 'string');
        assert.equal(Array.isArray(decision.payload.data?.ranking), true);

        const feedback = await jsonFetch(`${baseUrl}/api/reco/feedback`, {
          method: 'POST',
          token: userA.token,
          body: {
            decisionId: decision.payload.data?.decisionId,
            candidateId: decision.payload.data?.selectedCandidateId,
            action: 'click',
          },
        });
        assert.equal(feedback.response.status, 200);
        assert.equal(feedback.payload.success, true);
        assert.equal(feedback.payload.data?.success, true);

        const phase5Overview = await jsonFetch(`${baseUrl}/api/admin/phase5/overview`);
        assert.equal(phase5Overview.response.status, 200);
        assert.equal(phase5Overview.payload.success, true);
        assert.equal(typeof phase5Overview.payload.data?.reco?.online?.ctr, 'number');
        assert.equal(typeof phase5Overview.payload.data?.requestVolume?.recoDecision, 'number');

        const recoOverview = await jsonFetch(`${baseUrl}/api/admin/reco/overview`);
        assert.equal(recoOverview.response.status, 200);
        assert.equal(recoOverview.payload.success, true);
        assert.equal(Number(recoOverview.payload.data?.counts?.decisions || 0) >= 1, true);

        const recoAdminDirect = await jsonFetch(`${baseUrl}/api/reco/admin`);
        assert.equal(recoAdminDirect.response.status, 200);
        assert.equal(recoAdminDirect.payload.success, true);
        assert.equal(typeof recoAdminDirect.payload.data?.online?.ctr, 'number');

        const enableOnline = await jsonFetch(`${baseUrl}/api/admin/feature-flags/update`, {
          method: 'POST',
          body: {
            changes: {
              recoVw: true,
              recoVwShadow: true,
              recoVwOnline: true,
            },
          },
        });
        assert.equal(enableOnline.response.status, 200);
        assert.equal(enableOnline.payload.success, true);

        const configOnline = await jsonFetch(`${baseUrl}/api/admin/reco/config`, {
          method: 'POST',
          body: {
            rolloutPercent: 100,
            epsilon: 0,
            minCandidates: 1,
          },
        });
        assert.equal(configOnline.response.status, 200);
        assert.equal(configOnline.payload.success, true);

        const decisionOnline = await jsonFetch(`${baseUrl}/api/reco/decision`, {
          method: 'POST',
          token: userA.token,
          body: {
            source: 'phase5_online_test',
            candidates,
          },
        });
        assert.equal(decisionOnline.response.status, 200);
        assert.equal(decisionOnline.payload.success, true);
        assert.equal(decisionOnline.payload.data?.mode, 'online');

        const userDetail = await jsonFetch(`${baseUrl}/api/admin/users/detail?uid=${userA.uid}`);
        assert.equal(userDetail.response.status, 200);
        assert.equal(userDetail.payload.success, true);
        assert.equal(typeof userDetail.payload.data?.assistantProfile?.replyStyle, 'string');
        assert.equal(userDetail.payload.data?.recoPersona === null || typeof userDetail.payload.data?.recoPersona === 'object', true);
        assert.equal(typeof userDetail.payload.data?.depressionRating?.level, 'string');

        await resetFeatureOverrides(baseUrl);
      });
      await resetRecoRuntimeConfigForTests();
      await resetRecoStateForTests();
    },
  );
});
