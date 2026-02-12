import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../index.js';
import { resetSummaryRuntimeForTests } from '../summary/service.js';

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

const withStartedServer = async (runner) => {
  const server = startServer(0);
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await runner(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const jsonFetch = async (url, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
};

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  const username = `ws_${String(label || 'u').slice(0, 8)}_${seed}`.toLowerCase();
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

const waitForWsOpen = async (socket, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket open timeout.'));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || 'WS error')));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    socket.on('open', onOpen);
    socket.on('error', onError);
  });

const waitForWsMessage = async (socket, predicate, timeoutMs = 6000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket message timeout.'));
    }, timeoutMs);
    const onMessage = (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw?.toString?.() || '{}');
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || 'WS error')));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });

test('Phase4 WS: summary center refresh pushes summary card to client', async () => {
  await withEnv(
    {
      FEATURE_SUMMARY_CENTER_ENABLED: 'true',
      ADMIN_ENABLE_INSECURE: 'true',
      ADMIN_API_TOKEN: undefined,
    },
    async () => {
      await resetSummaryRuntimeForTests();
      await withStartedServer(async (baseUrl) => {
        const userA = await registerAndLogin(baseUrl, 'ws_a');
        const userB = await registerAndLogin(baseUrl, 'ws_b');
        await makeMutualFriend(baseUrl, userA, userB);

        const sendResult = await jsonFetch(`${baseUrl}/api/chat/send`, {
          method: 'POST',
          token: userB.token,
          body: {
            senderUid: userB.uid,
            targetUid: userA.uid,
            targetType: 'private',
            type: 'text',
            content: 'phase4 ws summary push sample',
          },
        });
        assert.equal(sendResult.response.status, 200);
        assert.equal(sendResult.payload.success, true);

        const wsUrl = `${baseUrl.replace('http://', 'ws://')}/ws?token=${encodeURIComponent(userA.token)}`;
        const socket = new WebSocket(wsUrl);
        try {
          const readyPromise = waitForWsMessage(socket, (msg) => msg?.type === 'ready', 5000);
          await waitForWsOpen(socket);
          await readyPromise;

          const pushPromise = waitForWsMessage(socket, (msg) => msg?.type === 'summary_center', 7000);

          const refreshResult = await jsonFetch(`${baseUrl}/api/summary/refresh`, {
            method: 'POST',
            token: userA.token,
            body: {},
          });
          assert.equal(refreshResult.response.status, 200);
          assert.equal(refreshResult.payload.success, true);

          const pushed = await pushPromise;
          const latest = pushed?.data?.latest || null;
          assert.equal(typeof latest?.id, 'string');
          assert.equal(latest?.userUid, userA.uid);
          assert.equal(typeof latest?.summaryText, 'string');
          assert.equal(Array.isArray(latest?.highlights), true);
        } finally {
          socket.close();
        }
      });
      await resetSummaryRuntimeForTests();
    },
  );
});
