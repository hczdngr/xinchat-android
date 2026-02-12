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

test('GET /api/admin/feature-flags returns snapshot data', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/feature-flags`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.data?.flags?.eventLogging, 'boolean');
  });
});

test('POST /api/events/track requires authentication', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/events/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'click' }),
    });
    assert.equal(response.status, 401);
  });
});

test('GET /api/admin/events/summary returns logger object', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/events/summary`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.data?.logger?.instanceId, 'string');
    assert.equal(typeof body.data?.logger?.local?.stats?.accepted, 'number');
  });
});
