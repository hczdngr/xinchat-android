import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { readUsers, writeUsers } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'chat.sqlite');

const MESSAGE_THRESHOLD = 100;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FETCH = 600;
const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_HOURS = 12;
const DEFAULT_MIN_NEW_MESSAGES = 30;
const HARDCODED_GEMINI_API_KEY = 'AIzaSyB3g-GqS6EolYbWsQRHvsJOsRLZiqSzWxI';
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

const toMessageText = (row, selfUid) => {
  const data = parseJsonSafe(row.data, {});
  const type = String(row.type || '').toLowerCase();
  const direction = Number(row.senderUid) === Number(selfUid) ? '我发送' : '我收到';

  if (type === 'text') {
    const content = clipText(data.content || data.text || '');
    if (content) return `${direction} 文本: ${content}`;
  }
  if (type === 'image') return `${direction} 图片消息`;
  if (type === 'voice') return `${direction} 语音消息`;
  if (type === 'file') return `${direction} 文件消息: ${clipText(data.name || '未命名文件', 80)}`;
  if (type) return `${direction} ${type} 消息`;
  return '';
};

const buildSamples = (rows, selfUid, totalCount) => {
  const now = Date.now();
  const all = rows
    .map((row) => ({
      createdAtMs: Number(row.createdAtMs) || 0,
      line: toMessageText(row, selfUid),
    }))
    .filter((item) => item.line);

  const allJoined = all.map((item) => item.line).join('\n');
  const needRecentOnly = totalCount > MESSAGE_THRESHOLD || allJoined.length > SAMPLE_PLANS[0].maxChars;

  const recentCutoff = now - LOOKBACK_MS;
  const recent = needRecentOnly ? all.filter((item) => item.createdAtMs >= recentCutoff) : all;
  const source = needRecentOnly ? 'recent_3_days' : 'all_messages';
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
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
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
          '该结果仅基于聊天文本推测，不构成医学诊断或心理评估结论。',
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

const buildPrompt = ({ totalCount, sampleMeta, sampleText }) => `
你是社交产品中的用户画像助手。请基于聊天消息，提炼用户画像。
要求：
1) 必须输出严格 JSON，不要 Markdown，不要解释性文字。
2) 不要给出医疗诊断。关于抑郁倾向只能给“文本风险推测”，并添加非诊断声明。
3) 结论要尽量可溯源到样本。

输出 JSON 结构（键名必须一致）：
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

输入统计：
- 用户消息总数: ${totalCount}
- 采样来源: ${sampleMeta.source}
- 自动降级层级: ${sampleMeta.downgradeLevel}
- 本次采样条数: ${sampleMeta.usedCount}
- 本次采样字符数: ${sampleMeta.usedChars}

聊天样本（按时间从近到远）：
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
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = payload?.error?.message || `Gemini request failed (${response.status})`;
        continue;
      }
      const text = extractGeminiText(payload);
      const parsed = parseModelJson(text);
      if (!parsed) {
        lastError = 'Gemini returned non-JSON content';
        continue;
      }
      return { model, analysis: normalizeAnalysis(parsed) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
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

const loadMessageStatsMap = async () => {
  const db = await getDb();
  if (!db) return new Map();
  try {
    const stats = new Map();
    const stmt = db.prepare(`
      SELECT uid, COUNT(1) AS total, MAX(createdAtMs) AS latestAt
      FROM (
        SELECT senderUid AS uid, createdAtMs FROM messages
        UNION ALL
        SELECT targetUid AS uid, createdAtMs FROM messages
      ) AS all_messages
      GROUP BY uid
    `);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const uid = Number(row.uid);
      if (!Number.isInteger(uid)) continue;
      stats.set(uid, {
        total: Number(row.total) || 0,
        latestAt: Number(row.latestAt) || 0,
      });
    }
    stmt.free();
    return stats;
  } finally {
    db.close();
  }
};

const loadMessagesForUser = async (uid) => {
  const db = await getDb();
  if (!db) return { totalCount: 0, rows: [] };
  try {
    const countStmt = db.prepare(
      `SELECT COUNT(1) AS total
       FROM messages
       WHERE senderUid = ? OR targetUid = ?`
    );
    countStmt.bind([uid, uid]);
    let totalCount = 0;
    if (countStmt.step()) {
      totalCount = Number(countStmt.getAsObject().total) || 0;
    }
    countStmt.free();

    const listStmt = db.prepare(
      `SELECT id, type, senderUid, targetUid, targetType, data, createdAt, createdAtMs
       FROM messages
       WHERE senderUid = ? OR targetUid = ?
       ORDER BY createdAtMs DESC
       LIMIT ?`
    );
    listStmt.bind([uid, uid, MAX_FETCH]);
    const rows = [];
    while (listStmt.step()) {
      rows.push(listStmt.getAsObject());
    }
    listStmt.free();
    return { totalCount, rows };
  } finally {
    db.close();
  }
};

const shouldAnalyzeByCooldown = ({ user, stat, now, cooldownMs, minNewMessages }) => {
  if (!stat || stat.total <= 0) return false;

  const meta = user?.aiProfile?.workerMeta || {};
  const lastAnalyzedAtMs = Date.parse(meta.lastAnalyzedAt || user?.aiProfile?.updatedAt || '');
  const lastMessageCount = Number.isFinite(Number(meta.lastMessageCount))
    ? Number(meta.lastMessageCount)
    : Number(user?.aiProfile?.sampling?.totalCount || 0);

  if (!Number.isFinite(lastAnalyzedAtMs) || lastAnalyzedAtMs <= 0) return true;
  if (stat.total - lastMessageCount >= minNewMessages) return true;
  if (now - lastAnalyzedAtMs >= cooldownMs) return true;
  return false;
};

const buildAiProfile = ({ previous, model, sampleMeta, totalCount, analysis, cooldownHours, minNewMessages }) => ({
  ...(previous || {}),
  model,
  updatedAt: new Date().toISOString(),
  sampling: {
    totalCount,
    source: sampleMeta.source,
    downgradeLevel: sampleMeta.downgradeLevel,
    usedCount: sampleMeta.usedCount,
    usedChars: sampleMeta.usedChars,
  },
  analysis,
  workerMeta: {
    lastAnalyzedAt: new Date().toISOString(),
    lastMessageCount: totalCount,
    cooldownHours,
    minNewMessages,
    source: sampleMeta.source,
    downgradeLevel: sampleMeta.downgradeLevel,
  },
});

export const startInsightWorker = ({
  logger = console,
  loopIntervalMs = toPositiveInt(process.env.INSIGHT_LOOP_INTERVAL_MS, DEFAULT_LOOP_INTERVAL_MS),
  cooldownHours = Math.min(toPositiveInt(process.env.INSIGHT_COOLDOWN_HOURS, DEFAULT_COOLDOWN_HOURS), 24),
  minNewMessages = toPositiveInt(process.env.INSIGHT_MIN_NEW_MESSAGES, DEFAULT_MIN_NEW_MESSAGES),
  defaultModel = String(process.env.GEMINI_DEFAULT_MODEL || GEMINI_FLASH_PREVIEW_MODEL).trim(),
} = {}) => {
  const apiKey = String(process.env.GEMINI_API_KEY || HARDCODED_GEMINI_API_KEY).trim();
  if (!apiKey) {
    logger.info('[insight] disabled: GEMINI_API_KEY not configured');
    return {
      stop: () => {},
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

    const { totalCount, rows } = await loadMessagesForUser(uid);
    if (!rows.length || totalCount <= 0) return;

    const sampleMeta = buildSamples(rows, uid, totalCount);
    if (!sampleMeta.samplesText) return;

    const prompt = buildPrompt({
      totalCount,
      sampleMeta,
      sampleText: sampleMeta.samplesText,
    });
    const result = await callGemini({
      apiKey,
      prompt,
      requestedModel: defaultModel,
    });

    const freshUsers = await readUsers();
    const freshIndex = freshUsers.findIndex((item) => item?.uid === uid);
    if (freshIndex < 0) return;

    const nextProfile = buildAiProfile({
      previous: freshUsers[freshIndex].aiProfile,
      model: result.model,
      sampleMeta,
      totalCount,
      analysis: result.analysis,
      cooldownHours,
      minNewMessages,
    });
    freshUsers[freshIndex] = {
      ...freshUsers[freshIndex],
      aiProfile: nextProfile,
    };
    await writeUsers(freshUsers);
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
          logger.warn('[insight] analyze failed', {
            uid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const scanAndEnqueue = async () => {
    const now = Date.now();
    const [users, statsMap] = await Promise.all([readUsers(), loadMessageStatsMap()]);
    for (const user of users) {
      const uid = Number(user?.uid);
      if (!Number.isInteger(uid)) continue;
      const stat = statsMap.get(uid) || { total: 0, latestAt: 0 };
      if (
        shouldAnalyzeByCooldown({
          user,
          stat,
          now,
          cooldownMs,
          minNewMessages,
        })
      ) {
        enqueue(uid);
      }
    }
  };

  const bootstrapEnqueueMissingProfiles = async () => {
    const [users, statsMap] = await Promise.all([readUsers(), loadMessageStatsMap()]);
    let queuedCount = 0;
    for (const user of users) {
      const uid = Number(user?.uid);
      if (!Number.isInteger(uid)) continue;
      if (hasHistoricalProfile(user)) continue;
      const stat = statsMap.get(uid);
      if (!stat || stat.total <= 0) continue;
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
