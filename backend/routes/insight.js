/**
 * Insight worker:
 * - periodic user profile analysis
 * - Gemini-based personality/risk inference
 */


import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { mutateUsers, readUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'chat.sqlite');

const MESSAGE_THRESHOLD = 100;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FETCH = 600;
const HOURLY_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_HOURS = 12;
const DEFAULT_MIN_NEW_MESSAGES = 30;
const DEFAULT_HOURLY_SENT_THRESHOLD = 80;
const HARDCODED_GEMINI_API_KEY_B64 =
  'QUl6YVN5QV81RndRNWFwZlpseG9kdHhRakRNNk92dlNYRFAwZURv';
const SAMPLE_PLANS = [
  { label: 'full', maxRows: 200, maxChars: 12000 },
  { label: 'downgrade_1', maxRows: 140, maxChars: 9000 },
  { label: 'downgrade_2', maxRows: 90, maxChars: 6000 },
  { label: 'downgrade_3', maxRows: 50, maxChars: 3500 },
  { label: 'downgrade_4', maxRows: 30, maxChars: 2200 },
];
const GEMINI_FLASH_PREVIEW_MODEL = 'gemini-3-flash-preview';
const GEMINI_PRO_PREVIEW_MODEL = 'gemini-3-pro-preview';

let sqlModulePromise = null;

const decodeHardcodedGeminiKey = () => {
  try {
    return Buffer.from(HARDCODED_GEMINI_API_KEY_B64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
};

const toErrorDetail = (error) => {
  const detail = {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : typeof error,
  };
  const cause = error && typeof error === 'object' ? error.cause : null;
  if (cause && typeof cause === 'object') {
    detail.cause = {
      message: String(cause.message || ''),
      code: String(cause.code || ''),
      errno: String(cause.errno || ''),
      syscall: String(cause.syscall || ''),
      host: String(cause.host || cause.hostname || ''),
      address: String(cause.address || ''),
      port: String(cause.port || ''),
    };
  }
  return detail;
};

const getSqlModule = async () => {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({
      locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
  }
  return sqlModulePromise;
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const hasHistoricalProfile = (user) =>
  Boolean(
    user &&
      user.aiProfile &&
      user.aiProfile.analysis &&
      typeof user.aiProfile.analysis === 'object'
  );

const parseJsonSafe = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const clipText = (value, max = 180) => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

const toMessageText = (row) => {
  const data = parseJsonSafe(row.data, {});
  const type = String(row.type || '').toLowerCase();
  if (type === 'text') {
    const content = clipText(data.content || data.text || '');
    if (content) return `text: ${content}`;
  }
  if (type === 'image') return 'image message';
  if (type === 'voice') return 'voice message';
  if (type === 'file') return `file message: ${clipText(data.name || 'unnamed file', 80)}`;
  if (type) return `${type} message`;
  return '';
};

const buildSamples = (rows, totalSentCount) => {
  const now = Date.now();
  const all = rows
    .map((row) => ({
      createdAtMs: Number(row.createdAtMs) || 0,
      line: toMessageText(row),
    }))
    .filter((item) => item.line);

  const allJoined = all.map((item) => item.line).join('\n');
  const needRecentOnly =
    totalSentCount > MESSAGE_THRESHOLD || allJoined.length > SAMPLE_PLANS[0].maxChars;

  const recentCutoff = now - LOOKBACK_MS;
  const recent = needRecentOnly ? all.filter((item) => item.createdAtMs >= recentCutoff) : all;
  const source = needRecentOnly ? 'recent_3_days_sent' : 'all_sent_messages';
  const base = recent.length > 0 ? recent : all;

  for (const plan of SAMPLE_PLANS) {
    const selected = base.slice(0, plan.maxRows);
    const picked = [];
    let usedChars = 0;
    for (const item of selected) {
      const nextLen = item.line.length + (picked.length ? 1 : 0);
      if (usedChars + nextLen > plan.maxChars) break;
      picked.push(item.line);
      usedChars += nextLen;
    }
    if (picked.length > 0) {
      return {
        source,
        downgradeLevel: plan.label,
        usedCount: picked.length,
        usedChars,
        samplesText: picked.join('\n'),
      };
    }
  }

  return {
    source,
    downgradeLevel: 'empty',
    usedCount: 0,
    usedChars: 0,
    samplesText: '',
  };
};

const extractGeminiText = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const merged = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (merged) return merged;
  }
  return '';
};

const parseModelJson = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const noFence = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(noFence);
  if (direct && typeof direct === 'object') return direct;

  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = noFence.slice(start, end + 1);
    const parsed = tryParse(sliced);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
};

const toNumberConfidence = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
};

const normalizeAnalysis = (value) => {
  const input = value && typeof value === 'object' ? value : {};
  const preferences = Array.isArray(input.preferences) ? input.preferences : [];
  const personalityTraits = Array.isArray(input.personalityTraits) ? input.personalityTraits : [];

  const mapItem = (item) => {
    if (typeof item === 'string') {
      return { name: clipText(item, 80), confidence: 0.5, evidence: '' };
    }
    return {
      name: clipText(item?.name || item?.trait || item?.topic || '', 80),
      confidence: toNumberConfidence(item?.confidence),
      evidence: clipText(item?.evidence || item?.reason || '', 160),
    };
  };

  const depression = input.depressionTendency && typeof input.depressionTendency === 'object'
    ? input.depressionTendency
    : {};

  return {
    profileSummary: clipText(input.profileSummary || input.summary || '', 1200),
    preferences: preferences.map(mapItem).filter((item) => item.name),
    personalityTraits: personalityTraits.map(mapItem).filter((item) => item.name),
    depressionTendency: {
      level: ['low', 'medium', 'high', 'unknown'].includes(String(depression.level || 'unknown'))
        ? String(depression.level || 'unknown')
        : 'unknown',
      confidence: toNumberConfidence(depression.confidence),
      reason: clipText(depression.reason || '', 240),
      disclaimer: clipText(
        depression.disclaimer ||
          'This analysis is based on chat text only and is not a medical diagnosis or psychological assessment.',
        220
      ),
    },
    riskSignals: (Array.isArray(input.riskSignals) ? input.riskSignals : [])
      .map((item) => clipText(item, 120))
      .filter(Boolean)
      .slice(0, 10),
    suggestedCommunicationStyle: clipText(
      input.suggestedCommunicationStyle || input.communicationStyle || '',
      240
    ),
  };
};

const buildPrompt = ({ totalSentCount, sampleMeta, sampleText }) => `
You are a user profiling assistant for a social app.
Analyze only the user's sent chat messages and return a strict JSON object.

Requirements:
1) Output strict JSON only (no markdown, no explanation text).
2) Do not provide a medical diagnosis.
3) Depression tendency must be phrased as text-based risk inference.
4) Keep conclusions grounded in the provided sample text.

JSON schema (keys must match exactly):
{
  "profileSummary": "string",
  "preferences": [{"name":"string","confidence":0.0,"evidence":"string"}],
  "personalityTraits": [{"name":"string","confidence":0.0,"evidence":"string"}],
  "depressionTendency": {
    "level":"low|medium|high|unknown",
    "confidence":0.0,
    "reason":"string",
    "disclaimer":"string"
  },
  "riskSignals": ["string"],
  "suggestedCommunicationStyle":"string"
}

Input stats:
- Total sent messages by user: ${totalSentCount}
- Sample source: ${sampleMeta.source}
- Auto downgrade level: ${sampleMeta.downgradeLevel}
- Sample rows used: ${sampleMeta.usedCount}
- Sample chars used: ${sampleMeta.usedChars}

Chat samples (ordered from newest to oldest):
${sampleText}
`.trim();

const callGemini = async ({ apiKey, prompt, requestedModel }) => {
  const allowedModels = new Set([GEMINI_FLASH_PREVIEW_MODEL, GEMINI_PRO_PREVIEW_MODEL]);
  const envModels = String(process.env.GEMINI_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => allowedModels.has(item));
  const normalizedRequestedModel = allowedModels.has(requestedModel) ? requestedModel : '';
  const candidates = Array.from(
    new Set([
      GEMINI_FLASH_PREVIEW_MODEL,
      normalizedRequestedModel,
      ...envModels,
      GEMINI_PRO_PREVIEW_MODEL,
    ].filter(Boolean))
  );

  let lastError = 'AI service unavailable';
  let lastErrorDetail = null;
  for (const model of candidates) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(20000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = payload?.error?.message || `Gemini request failed (${response.status})`;
        lastErrorDetail = {
          stage: 'http',
          model,
          endpoint,
          status: response.status,
          apiError: payload?.error?.message || '',
        };
        continue;
      }
      const text = extractGeminiText(payload);
      const parsed = parseModelJson(text);
      if (!parsed) {
        lastError = 'Gemini returned non-JSON content';
        lastErrorDetail = {
          stage: 'parse',
          model,
          endpoint,
          status: response.status,
          hint: 'response is not strict JSON',
        };
        continue;
      }
      return { model, analysis: normalizeAnalysis(parsed) };
    } catch (error) {
      const detail = toErrorDetail(error);
      lastError = detail.message || 'Gemini request failed';
      lastErrorDetail = {
        stage: 'network',
        model,
        endpoint,
        ...detail,
      };
    }
  }
  const finalError = new Error(lastError);
  finalError.detail = lastErrorDetail;
  throw finalError;
};

const getDb = async () => {
  let file;
  try {
    file = await fs.readFile(DB_PATH);
  } catch {
    return null;
  }
  const SQL = await getSqlModule();
  return new SQL.Database(new Uint8Array(file));
};

const loadMessageStatsMap = async ({ now = Date.now() } = {}) => {
  const db = await getDb();
  if (!db) return new Map();
  try {
    const stats = new Map();
    const stmt = db.prepare(`
      SELECT senderUid AS uid,
             COUNT(1) AS totalSent,
             MAX(createdAtMs) AS latestSentAt
      FROM messages
      GROUP BY senderUid
    `);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const uid = Number(row.uid);
      if (!Number.isInteger(uid)) continue;
      const totalSent = Number(row.totalSent) || 0;
      stats.set(uid, {
        total: totalSent,
        latestAt: Number(row.latestSentAt) || 0,
        totalSent,
        sentLastHour: 0,
      });
    }
    stmt.free();

    const oneHourAgo = now - HOURLY_WINDOW_MS;
    const sentStmt = db.prepare(`
      SELECT senderUid AS uid,
             COUNT(1) AS totalSent,
             SUM(CASE WHEN createdAtMs >= ? THEN 1 ELSE 0 END) AS sentLastHour
      FROM messages
      GROUP BY senderUid
    `);
    sentStmt.bind([oneHourAgo]);
    while (sentStmt.step()) {
      const row = sentStmt.getAsObject();
      const uid = Number(row.uid);
      if (!Number.isInteger(uid)) continue;
      const base = stats.get(uid) || { total: 0, latestAt: 0, totalSent: 0, sentLastHour: 0 };
      const totalSent = Number(row.totalSent) || base.totalSent || 0;
      stats.set(uid, {
        ...base,
        total: totalSent,
        totalSent,
        sentLastHour: Number(row.sentLastHour) || 0,
      });
    }
    sentStmt.free();
    return stats;
  } finally {
    db.close();
  }
};

const loadMessagesForUser = async (uid) => {
  const db = await getDb();
  if (!db) return { totalSentCount: 0, rows: [] };
  try {
    const sentCountStmt = db.prepare(
      `SELECT COUNT(1) AS total
       FROM messages
       WHERE senderUid = ?`
    );
    sentCountStmt.bind([uid]);
    let totalSentCount = 0;
    if (sentCountStmt.step()) {
      totalSentCount = Number(sentCountStmt.getAsObject().total) || 0;
    }
    sentCountStmt.free();

    const listStmt = db.prepare(
      `SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
       FROM messages
       WHERE senderUid = ?
       ORDER BY createdAtMs DESC
       LIMIT ?`
    );
    listStmt.bind([uid, MAX_FETCH]);
    const rows = [];
    while (listStmt.step()) {
      rows.push(listStmt.getAsObject());
    }
    listStmt.free();
    return { totalSentCount, rows };
  } finally {
    db.close();
  }
};

const shouldAnalyzeByCooldown = ({
  user,
  stat,
  now,
  cooldownMs,
  minNewMessages,
  hourlySentThreshold,
}) => {
  if (!stat || Number(stat.totalSent) <= 0) return false;

  const meta = user?.aiProfile?.workerMeta || {};
  const lastAnalyzedAtMs = Date.parse(meta.lastAnalyzedAt || user?.aiProfile?.updatedAt || '');
  const lastSentMessageCount = Number.isFinite(Number(meta.lastSentMessageCount))
    ? Number(meta.lastSentMessageCount)
    : Number.isFinite(Number(meta.lastMessageCount))
      ? Number(meta.lastMessageCount)
      : Number(user?.aiProfile?.sampling?.totalCount || 0);
  const totalSent = Number(stat.totalSent) || 0;
  const sentLastHour = Number(stat.sentLastHour) || 0;

  if (!Number.isFinite(lastAnalyzedAtMs) || lastAnalyzedAtMs <= 0) return true;
  if (sentLastHour > hourlySentThreshold && totalSent - lastSentMessageCount > 0) return true;
  if (totalSent - lastSentMessageCount >= minNewMessages) return true;
  if (now - lastAnalyzedAtMs >= cooldownMs) return true;
  return false;
};

const buildAiProfile = ({
  previous,
  model,
  sampleMeta,
  totalSentCount,
  analysis,
  cooldownHours,
  minNewMessages,
  hourlySentThreshold,
}) => ({
  ...(previous || {}),
  model,
  updatedAt: new Date().toISOString(),
  sampling: {
    totalCount: totalSentCount,
    source: sampleMeta.source,
    downgradeLevel: sampleMeta.downgradeLevel,
    usedCount: sampleMeta.usedCount,
    usedChars: sampleMeta.usedChars,
  },
  analysis,
  workerMeta: {
    lastAnalyzedAt: new Date().toISOString(),
    lastMessageCount: totalSentCount,
    lastSentMessageCount: totalSentCount,
    cooldownHours,
    minNewMessages,
    hourlySentThreshold,
    source: sampleMeta.source,
    downgradeLevel: sampleMeta.downgradeLevel,
  },
});

export const startInsightWorker = ({
  logger = console,
  onTick = null,
  loopIntervalMs = toPositiveInt(process.env.INSIGHT_LOOP_INTERVAL_MS, DEFAULT_LOOP_INTERVAL_MS),
  cooldownHours = Math.min(toPositiveInt(process.env.INSIGHT_COOLDOWN_HOURS, DEFAULT_COOLDOWN_HOURS), 24),
  minNewMessages = toPositiveInt(process.env.INSIGHT_MIN_NEW_MESSAGES, DEFAULT_MIN_NEW_MESSAGES),
  hourlySentThreshold = toPositiveInt(
    process.env.INSIGHT_HOURLY_SENT_THRESHOLD,
    DEFAULT_HOURLY_SENT_THRESHOLD
  ),
  defaultModel = String(process.env.GEMINI_DEFAULT_MODEL || GEMINI_FLASH_PREVIEW_MODEL).trim(),
} = {}) => {
  const apiKey = String(process.env.GEMINI_API_KEY || decodeHardcodedGeminiKey()).trim();
  if (!apiKey) {
    logger.info('[insight] AI analysis disabled: GEMINI_API_KEY not configured');
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (typeof onTick === 'function') {
        try {
          await onTick({
            reason: 'insight_worker_tick_no_ai',
            nowMs: Date.now(),
            queueSize: 0,
          });
        } catch (error) {
          logger.warn('[insight] onTick failed (no_ai mode)', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    timer = setInterval(() => {
      tick().catch(() => undefined);
    }, loopIntervalMs);
    timer.unref?.();
    tick().catch(() => undefined);
    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      enqueue: () => {},
    };
  }

  const queue = [];
  const queued = new Set();
  let timer = null;
  let running = false;
  let stopped = false;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  const enqueue = (uid, { priority = false } = {}) => {
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (queued.has(uid)) return;
    queued.add(uid);
    if (priority) {
      queue.unshift(uid);
      return;
    }
    queue.push(uid);
  };

  const analyzeSingleUser = async (uid) => {
    const users = await readUsers();
    const index = users.findIndex((item) => item?.uid === uid);
    if (index < 0) return;

    const { totalSentCount, rows } = await loadMessagesForUser(uid);
    if (!rows.length || totalSentCount <= 0) return;

    const sampleMeta = buildSamples(rows, totalSentCount);
    if (!sampleMeta.samplesText) return;

    const prompt = buildPrompt({
      totalSentCount,
      sampleMeta,
      sampleText: sampleMeta.samplesText,
    });
    const result = await callGemini({
      apiKey,
      prompt,
      requestedModel: defaultModel,
    });

    await mutateUsers(
      (users) => {
        const freshIndex = users.findIndex((item) => item?.uid === uid);
        if (freshIndex < 0) {
          return { changed: false };
        }
        const nextProfile = buildAiProfile({
          previous: users[freshIndex].aiProfile,
          model: result.model,
          sampleMeta,
          totalSentCount,
          analysis: result.analysis,
          cooldownHours,
          minNewMessages,
          hourlySentThreshold,
        });
        users[freshIndex] = {
          ...users[freshIndex],
          aiProfile: nextProfile,
        };
        return { changed: true };
      },
      { defaultChanged: false }
    );
  };

  const processQueue = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length > 0) {
        const uid = queue.shift();
        queued.delete(uid);
        try {
          await analyzeSingleUser(uid);
        } catch (error) {
          const detail = error && typeof error === 'object' ? error.detail : null;
          const errorBase = toErrorDetail(error);
          logger.warn('[insight] analyze failed', {
            uid,
            error: errorBase.message,
            name: errorBase.name,
            cause: errorBase.cause || null,
            detail: detail || null,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const scanAndEnqueue = async () => {
    const now = Date.now();
    const [users, statsMap] = await Promise.all([readUsers(), loadMessageStatsMap({ now })]);
    for (const user of users) {
      const uid = Number(user?.uid);
      if (!Number.isInteger(uid)) continue;
      const stat = statsMap.get(uid) || { total: 0, latestAt: 0, totalSent: 0, sentLastHour: 0 };
      if (
        shouldAnalyzeByCooldown({
          user,
          stat,
          now,
          cooldownMs,
          minNewMessages,
          hourlySentThreshold,
        })
      ) {
        enqueue(uid);
      }
    }
  };

  const bootstrapEnqueueMissingProfiles = async () => {
    const [users, statsMap] = await Promise.all([readUsers(), loadMessageStatsMap({ now: Date.now() })]);
    let queuedCount = 0;
    for (const user of users) {
      const uid = Number(user?.uid);
      if (!Number.isInteger(uid)) continue;
      if (hasHistoricalProfile(user)) continue;
      const stat = statsMap.get(uid);
      if (!stat || Number(stat.totalSent) <= 0) continue;
      enqueue(uid, { priority: true });
      queuedCount += 1;
    }
    if (queuedCount > 0) {
      logger.info('[insight] bootstrap queued users without historical profile', {
        queuedCount,
      });
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      await scanAndEnqueue();
      await processQueue();
      if (typeof onTick === 'function') {
        await onTick({
          reason: 'insight_worker_tick',
          nowMs: Date.now(),
          queueSize: queue.length,
        });
      }
    } catch (error) {
      logger.warn('[insight] tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  timer = setInterval(() => {
    tick().catch(() => undefined);
  }, loopIntervalMs);
  (async () => {
    await bootstrapEnqueueMissingProfiles();
    await processQueue();
    await tick();
  })().catch((error) => {
    logger.warn('[insight] bootstrap failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('[insight] worker started', {
    loopIntervalMs,
    cooldownHours,
    minNewMessages,
    hourlySentThreshold,
    hourlyWindowMs: HOURLY_WINDOW_MS,
    concurrency: 1,
  });

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { stop, enqueue };
};



