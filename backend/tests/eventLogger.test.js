import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const importFreshLogger = async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const moduleUrl = new URL('../events/eventLogger.js', import.meta.url).href;
  return import(`${moduleUrl}?case=${stamp}`);
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

test('event logger does not enqueue when feature is disabled', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinchat-event-test-'));
  const logPath = path.join(tempDir, 'events.ndjson');
  const statePath = path.join(tempDir, 'events.state.json');

  await withEnv(
    {
      FEATURE_EVENT_LOG_ENABLED: 'false',
      EVENT_LOG_PATH: logPath,
      EVENT_LOG_STATE_PATH: statePath,
    },
    async () => {
      const logger = await importFreshLogger();
      const result = await logger.trackEventSafe({
        eventType: 'click',
        actorUid: 1001,
        path: '/api/friends/add',
      });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'disabled');
      await logger.flushEventLogs({ force: true });
      const stats = await logger.getEventLoggerStats();
      assert.equal(stats.local.stats.accepted, 0);
      await logger.resetEventLoggerForTests();
    }
  );
});

test('event logger writes events to ndjson with force flush', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinchat-event-test-'));
  const logPath = path.join(tempDir, 'events.ndjson');
  const statePath = path.join(tempDir, 'events.state.json');

  await withEnv(
    {
      FEATURE_EVENT_LOG_ENABLED: 'true',
      EVENT_LOG_PATH: logPath,
      EVENT_LOG_STATE_PATH: statePath,
    },
    async () => {
      const logger = await importFreshLogger();
      const result = await logger.trackEventSafe({
        eventType: 'reply',
        actorUid: 1002,
        targetUid: 1003,
        path: '/api/chat/send',
        method: 'POST',
        metadata: { type: 'text' },
      });
      assert.equal(result.accepted, true);

      await logger.flushEventLogs({ force: true });
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.eventType, 'reply');
      assert.equal(event.actorUid, 1002);
      assert.equal(event.targetUid, 1003);
      assert.equal(event.path, '/api/chat/send');
      const stats = await logger.getEventLoggerStats();
      assert.equal(stats.local.stats.flushed >= 1, true);
      await logger.resetEventLoggerForTests();
    }
  );
});

test('event logger enforces per-window rate limiting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinchat-event-test-'));
  const logPath = path.join(tempDir, 'events.ndjson');
  const statePath = path.join(tempDir, 'events.state.json');

  await withEnv(
    {
      FEATURE_EVENT_LOG_ENABLED: 'true',
      EVENT_LOG_PATH: logPath,
      EVENT_LOG_STATE_PATH: statePath,
      EVENT_LOG_RATE_MAX: '1',
      EVENT_LOG_RATE_WINDOW_MS: '60000',
    },
    async () => {
      const logger = await importFreshLogger();
      const first = await logger.trackEventSafe({
        eventType: 'impression',
        actorUid: 2001,
        targetUid: 3001,
        path: '/api/chat/get',
      });
      const second = await logger.trackEventSafe({
        eventType: 'impression',
        actorUid: 2001,
        targetUid: 3001,
        path: '/api/chat/get',
      });
      assert.equal(first.accepted, true);
      assert.equal(second.accepted, false);
      assert.equal(second.reason, 'rate_limited');
      await logger.flushEventLogs({ force: true });
      await logger.resetEventLoggerForTests();
    }
  );
});

test('event logger restores local state after restart', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinchat-event-test-'));
  const logPath = path.join(tempDir, 'events.ndjson');
  const statePath = path.join(tempDir, 'events.state.json');

  await withEnv(
    {
      FEATURE_EVENT_LOG_ENABLED: 'true',
      EVENT_LOG_PATH: logPath,
      EVENT_LOG_STATE_PATH: statePath,
    },
    async () => {
      const loggerA = await importFreshLogger();
      await loggerA.trackEventSafe({
        eventType: 'click',
        actorUid: 901,
        path: '/api/events/track',
      });
      await loggerA.flushEventLogs({ force: true });
      const firstStats = await loggerA.getEventLoggerStats();
      assert.equal(firstStats.local.stats.accepted >= 1, true);
      const acceptedBeforeRestart = firstStats.local.stats.accepted;

      const loggerB = await importFreshLogger();
      const secondStats = await loggerB.getEventLoggerStats();
      assert.equal(secondStats.local.stats.accepted >= acceptedBeforeRestart, true);
      await loggerA.resetEventLoggerForTests();
      await loggerB.resetEventLoggerForTests();
    }
  );
});

test('redis mode keeps global consistency across module instances when REDIS_URL is set', async (t) => {
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (!redisUrl) {
    t.skip('REDIS_URL not set');
    return;
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xinchat-event-test-'));
  const logPath = path.join(tempDir, 'events.ndjson');
  const statePath = path.join(tempDir, 'events.state.json');
  const redisPrefix = `xinchat:test:event:${Date.now()}:${Math.random().toString(16).slice(2)}:`;

  await withEnv(
    {
      FEATURE_EVENT_LOG_ENABLED: 'true',
      EVENT_LOG_PATH: logPath,
      EVENT_LOG_STATE_PATH: statePath,
      EVENT_LOG_RATE_MAX: '1',
      EVENT_LOG_RATE_WINDOW_MS: '120000',
      EVENT_REDIS_PREFIX: redisPrefix,
      REDIS_URL: redisUrl,
    },
    async () => {
      const loggerA = await importFreshLogger();
      const loggerB = await importFreshLogger();

      const first = await loggerA.trackEventSafe({
        eventType: 'impression',
        actorUid: 3001,
        targetUid: 5001,
        path: '/api/chat/get',
      });
      const second = await loggerB.trackEventSafe({
        eventType: 'impression',
        actorUid: 3001,
        targetUid: 5001,
        path: '/api/chat/get',
      });

      assert.equal(first.accepted, true);
      assert.equal(second.accepted, false);
      assert.equal(second.reason, 'rate_limited');

      const statsA = await loggerA.getEventLoggerStats();
      assert.equal(statsA.redis.connected, true);
      assert.equal(Number(statsA.global?.stats?.accepted || 0) >= 1, true);
      assert.equal(Number(statsA.global?.stats?.droppedRateLimited || 0) >= 1, true);

      await loggerA.flushEventLogs({ force: true });
      await loggerB.flushEventLogs({ force: true });
      await loggerA.resetEventLoggerForTests();
      await loggerB.resetEventLoggerForTests();
    }
  );
});
