import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../index.js';
import { resetSummaryRuntimeForTests } from '../summary/service.js';

const toWsUrl = (baseUrl, token) =>
  `${String(baseUrl || '').replace('http://', 'ws://').replace('https://', 'wss://')}/ws?token=${encodeURIComponent(token)}`;

const jsonFetch = async (url, { method = 'GET', token, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (typeof body !== 'undefined') headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${method} ${url}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

const waitForWsOpen = async (socket, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WS open timeout'));
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

const waitForWsMessage = async (socket, predicate, timeoutMs = 7000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('WS message timeout'));
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

const registerAndLogin = async (baseUrl, label) => {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const username = `reg_${label}_${seed}`.toLowerCase();
  const password = 'Passw0rd!phase4';
  const registerPayload = await jsonFetch(`${baseUrl}/api/register`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(registerPayload.success, true);
  const loginPayload = await jsonFetch(`${baseUrl}/api/login`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(loginPayload.success, true);
  return {
    uid: Number(loginPayload.uid),
    username,
    token: String(loginPayload.token || ''),
  };
};

const run = async () => {
  process.env.FEATURE_SUMMARY_CENTER_ENABLED = process.env.FEATURE_SUMMARY_CENTER_ENABLED || 'true';
  process.env.ADMIN_ENABLE_INSECURE = process.env.ADMIN_ENABLE_INSECURE || 'true';
  if (typeof process.env.ADMIN_API_TOKEN !== 'undefined') {
    delete process.env.ADMIN_API_TOKEN;
  }

  await resetSummaryRuntimeForTests();
  const server = startServer(0);
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let socket = null;
  try {
    console.log(`[summary-regression] server started: ${baseUrl}`);
    const userA = await registerAndLogin(baseUrl, 'a');
    const userB = await registerAndLogin(baseUrl, 'b');

    await jsonFetch(`${baseUrl}/api/friends/add`, {
      method: 'POST',
      token: userA.token,
      body: { friendUid: userB.uid },
    });
    await jsonFetch(`${baseUrl}/api/friends/add`, {
      method: 'POST',
      token: userB.token,
      body: { friendUid: userA.uid },
    });

    const wsUrl = toWsUrl(baseUrl, userA.token);
    socket = new WebSocket(wsUrl);
    const readyPromise = waitForWsMessage(socket, (msg) => msg?.type === 'ready');
    await waitForWsOpen(socket);
    await readyPromise;

    await jsonFetch(`${baseUrl}/api/chat/send`, {
      method: 'POST',
      token: userB.token,
      body: {
        senderUid: userB.uid,
        targetUid: userA.uid,
        targetType: 'private',
        type: 'text',
        content: 'summary regression unread sample',
      },
    });

    const pushPromise = waitForWsMessage(socket, (msg) => msg?.type === 'summary_center');
    const refreshPayload = await jsonFetch(`${baseUrl}/api/summary/refresh`, {
      method: 'POST',
      token: userA.token,
      body: {},
    });
    assert.equal(refreshPayload.success, true);
    assert.equal(refreshPayload.data?.enabled, true);

    const pushed = await pushPromise;
    assert.equal(pushed?.type, 'summary_center');
    assert.equal(typeof pushed?.data?.latest?.summaryText, 'string');

    const overviewPayload = await jsonFetch(`${baseUrl}/api/chat/overview`, {
      method: 'POST',
      token: userA.token,
      body: { includeSummary: true, readAt: {} },
    });
    assert.equal(overviewPayload.success, true);
    assert.equal(typeof overviewPayload.summaryCenter?.summaryText, 'string');

    const archivePayload = await jsonFetch(`${baseUrl}/api/summary/archive`, {
      method: 'POST',
      token: userA.token,
      body: {},
    });
    assert.equal(typeof archivePayload.data?.badges?.unreadTotal, 'number');

    const adminPayload = await jsonFetch(`${baseUrl}/api/admin/phase4/overview`);
    assert.equal(adminPayload.success, true);
    assert.equal(typeof adminPayload.data?.summary?.runtime?.totalSlowQueries, 'number');

    console.log('[summary-regression] PASS');
  } finally {
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
    await resetSummaryRuntimeForTests();
  }
};

run().catch((error) => {
  console.error('[summary-regression] FAIL', error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
