/**
 * 模块说明：语音转写路由模块：处理音频上传、排队与结果查询。
 */


import express from 'express';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createAuthenticateMiddleware } from './session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRANSCRIBE_TMP_DIR = path.join(DATA_DIR, 'transcribe_tmp');

const HARDCODED_GEMINI_API_KEY_B64 =
  'QUl6YVN5QV81RndRNWFwZlpseG9kdHhRakRNNk92dlNYRFAwZURv';

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'VoiceTranscribe' });

// readPositiveInt：读取持久化或缓存数据。
const readPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

const MAX_AUDIO_BYTES = readPositiveInt(process.env.VOICE_TRANSCRIBE_MAX_AUDIO_BYTES, 12 * 1024 * 1024);
const MAX_QUEUE_SIZE = readPositiveInt(process.env.VOICE_TRANSCRIBE_MAX_QUEUE, 500);
const MAX_PARALLEL = readPositiveInt(process.env.VOICE_TRANSCRIBE_MAX_PARALLEL, 6);
const JOB_TTL_MS = readPositiveInt(process.env.VOICE_TRANSCRIBE_JOB_TTL_MS, 10 * 60 * 1000, 60_000);
const HASH_CACHE_TTL_MS = readPositiveInt(process.env.VOICE_TRANSCRIBE_CACHE_TTL_MS, 6 * 60 * 60 * 1000, 60_000);
const REQUEST_TIMEOUT_MS = readPositiveInt(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS, 40_000, 5_000);
const RETRY_MAX = readPositiveInt(process.env.VOICE_TRANSCRIBE_RETRIES, 2, 0);
const RETRY_DELAY_MS = readPositiveInt(process.env.VOICE_TRANSCRIBE_RETRY_DELAY_MS, 500, 100);

const DEFAULT_FAST_TRANSCRIBE_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_MODEL = String(
  process.env.VOICE_TRANSCRIBE_MODEL || process.env.VOICE_TRANSCRIBE_FAST_MODEL || DEFAULT_FAST_TRANSCRIBE_MODEL
).trim();
const TRANSCRIBE_NULL_TEXT = 'null';
const TRANSCRIBE_PROMPT =
  '\u8bf7\u628a\u8fd9\u6bb5\u8bed\u97f3\u51c6\u786e\u8f6c\u5199\u6210\u7b80\u4f53\u4e2d\u6587\u6587\u672c\u3002' +
  '\u53ea\u8f93\u51fa\u8f6c\u5199\u7ed3\u679c\uff0c\u4e0d\u8981\u6dfb\u52a0\u89e3\u91ca\u3001\u524d\u7f00\u6216\u989d\u5916\u8bf4\u660e\u3002' +
  '\u5982\u679c\u6ca1\u6709\u8f6c\u5199\u5230\u4efb\u4f55\u6709\u6548\u4fe1\u606f\uff0c\u8bf7\u53ea\u8fd4\u56denull\u3002';

const AUDIO_MIME_ALLOW = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/3gpp',
  'audio/amr',
]);

let aiClient = null;
let aiClientKey = '';
let activeWorkers = 0;
const jobQueue = [];
const jobs = new Map();
const hashInFlight = new Map();
const hashCache = new Map();

// nowIso?处理 nowIso 相关逻辑。
const nowIso = () => new Date().toISOString();
// hashInFlightKey?处理 hashInFlightKey 相关逻辑。
const hashInFlightKey = (uid, hash) => `${Number(uid) || 0}:${String(hash || '')}`;
// sanitizeMime：清洗不可信输入。
const sanitizeMime = (value) => String(value || '').trim().toLowerCase();

// decodeHardcodedGeminiKey?处理 decodeHardcodedGeminiKey 相关逻辑。
const decodeHardcodedGeminiKey = () => {
  try {
    return Buffer.from(HARDCODED_GEMINI_API_KEY_B64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
};

// mapTranscribeError?处理 mapTranscribeError 相关逻辑。
const mapTranscribeError = (error) => {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');

  if (code === 'FILE_TOO_LARGE' || message === 'FILE_TOO_LARGE') {
    return { statusCode: 413, publicMessage: 'Audio file is too large.' };
  }
  if (message === 'REQUEST_ABORTED') {
    return { statusCode: 400, publicMessage: 'Request aborted.' };
  }
  if (code === 'MISSING_API_KEY') {
    return { statusCode: 500, publicMessage: 'Voice transcribe service is not configured.' };
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    /timeout/i.test(message)
  ) {
    return { statusCode: 504, publicMessage: 'Voice transcribe timed out.' };
  }
  if (status === 429) {
    return { statusCode: 429, publicMessage: 'Voice transcribe service is busy. Please retry shortly.' };
  }
  if (status === 401 || status === 403 || /permission|unauth|api key/i.test(message)) {
    return { statusCode: 502, publicMessage: 'Voice transcribe authentication failed.' };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return { statusCode: 502, publicMessage: 'Voice transcribe service is temporarily unavailable.' };
  }
  return { statusCode: 500, publicMessage: 'Voice transcribe failed.' };
};

// normalizeTranscribeText：归一化外部输入。
const normalizeTranscribeText = (value) => {
  const text = String(value || '').trim();
  if (!text) return TRANSCRIBE_NULL_TEXT;
  if (/^["'`]?null["'`]?$/i.test(text)) return TRANSCRIBE_NULL_TEXT;
  return text;
};

// isNullTranscribeText：判断条件是否成立。
const isNullTranscribeText = (value) => normalizeTranscribeText(value) === TRANSCRIBE_NULL_TEXT;

// getAiClient：获取并返回目标数据。
const getAiClient = () => {
  const apiKey = String(process.env.GEMINI_API_KEY || decodeHardcodedGeminiKey()).trim();
  if (!apiKey) {
    const error = new Error('MISSING_API_KEY');
    error.code = 'MISSING_API_KEY';
    throw error;
  }
  if (!aiClient || aiClientKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClientKey = apiKey;
  }
  return aiClient;
};

// ensureTmpDir：确保前置条件与资源可用。
const ensureTmpDir = async () => {
  await fs.mkdir(TRANSCRIBE_TMP_DIR, { recursive: true });
};

// isAllowedAudioMime：判断条件是否成立。
const isAllowedAudioMime = (mime) => {
  if (!mime) return true;
  if (AUDIO_MIME_ALLOW.has(mime)) return true;
  const base = mime.split(';')[0];
  return AUDIO_MIME_ALLOW.has(base);
};

// withTimeout?处理 withTimeout 相关逻辑。
const withTimeout = async (promise, timeoutMs, label) => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// sleep?处理 sleep 相关逻辑。
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// readStreamToFile：读取持久化或缓存数据。
const readStreamToFile = (req, tempPath, maxBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const hash = crypto.createHash('sha256');
    const writer = createWriteStream(tempPath, { flags: 'wx' });

    const abort = (error) => {
      if (finished) return;
      finished = true;
      try {
        req.destroy();
      } catch {}
      try {
        writer.destroy();
      } catch {}
      fs.unlink(tempPath).catch(() => undefined);
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('FILE_TOO_LARGE');
        error.code = 'FILE_TOO_LARGE';
        abort(error);
        return;
      }
      hash.update(chunk);
    });

    req.on('aborted', () => abort(new Error('REQUEST_ABORTED')));
    req.on('error', (error) => abort(error));
    writer.on('error', (error) => abort(error));
    writer.on('finish', () => {
      if (finished) return;
      finished = true;
      resolve({ size, hash: hash.digest('hex') });
    });

    req.pipe(writer);
  });

// extractText：提取请求中的关键信息。
const extractText = (response) => {
  const plain = typeof response?.text === 'string' ? response.text.trim() : '';
  if (plain) return plain;
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
};

// requestTranscriptionOnce?处理 requestTranscriptionOnce 相关逻辑。
const requestTranscriptionOnce = async ({ buffer, mimeType }) => {
  const ai = getAiClient();
  const response = await withTimeout(
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: TRANSCRIBE_PROMPT },
            {
              inlineData: {
                mimeType: mimeType || 'audio/webm',
                data: buffer.toString('base64'),
              },
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 700,
      },
    }),
    REQUEST_TIMEOUT_MS,
    'voice-transcribe'
  );
  return normalizeTranscribeText(extractText(response));
};

// requestTranscriptionWithRetry?处理 requestTranscriptionWithRetry 相关逻辑。
const requestTranscriptionWithRetry = async ({ buffer, mimeType }) => {
  let lastError = null;
  for (let i = 0; i <= RETRY_MAX; i += 1) {
    try {
      return await requestTranscriptionOnce({ buffer, mimeType });
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const message = String(error?.message || '');
      const retryable =
        /timeout/i.test(message) ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504;
      if (!retryable || i >= RETRY_MAX) break;
      await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
  throw lastError || new Error('VOICE_TRANSCRIBE_FAILED');
};

// toPublicJob?处理 toPublicJob 相关逻辑。
const toPublicJob = (job) => ({
  jobId: job.id,
  status: job.status,
  createdAt: job.createdAt,
  startedAt: job.startedAt || '',
  finishedAt: job.finishedAt || '',
  text: job.status === 'succeeded' && !isNullTranscribeText(job.text) ? job.text : '',
  error: job.status === 'failed' ? job.error : '',
});

// dropJobTempFile?处理 dropJobTempFile 相关逻辑。
const dropJobTempFile = async (job) => {
  if (!job?.tempPath) return;
  await fs.unlink(job.tempPath).catch(() => undefined);
  job.tempPath = '';
};

// runJob?处理 runJob 相关逻辑。
const runJob = async (job) => {
  job.status = 'processing';
  job.startedAt = nowIso();
  try {
    const cached = hashCache.get(job.hash);
    if (cached && cached.expiresAtMs > Date.now()) {
      job.status = 'succeeded';
      job.text = cached.text;
      job.finishedAt = nowIso();
      return;
    }

    const buffer = await fs.readFile(job.tempPath);
    const text = await requestTranscriptionWithRetry({ buffer, mimeType: job.mimeType });
    job.status = 'succeeded';
    job.text = String(text || '').trim();
    job.finishedAt = nowIso();
    hashCache.set(job.hash, {
      text: job.text,
      expiresAtMs: Date.now() + HASH_CACHE_TTL_MS,
    });
  } catch (error) {
    console.error('Voice transcribe run job error:', error);
    const mapped = mapTranscribeError(error);
    const message = mapped.publicMessage || 'Voice transcribe failed.';
    job.status = 'failed';
    job.error = message;
    job.finishedAt = nowIso();
  } finally {
    hashInFlight.delete(hashInFlightKey(job.userUid, job.hash));
    await dropJobTempFile(job);
  }
};

// pumpQueue?处理 pumpQueue 相关逻辑。
const pumpQueue = () => {
  while (activeWorkers < MAX_PARALLEL && jobQueue.length > 0) {
    const jobId = jobQueue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    activeWorkers += 1;
    runJob(job)
      .catch((error) => {
        console.error('Voice transcribe worker error:', error);
      })
      .finally(() => {
        activeWorkers = Math.max(0, activeWorkers - 1);
        pumpQueue();
      });
  }
};

// queueDepth：将任务按顺序排队处理。
const queueDepth = () => jobQueue.length + activeWorkers;

// cleanupStores?处理 cleanupStores 相关逻辑。
const cleanupStores = () => {
  const now = Date.now();
  for (const [hash, item] of hashCache.entries()) {
    if (!item || item.expiresAtMs <= now) {
      hashCache.delete(hash);
    }
  }
  for (const [jobId, job] of jobs.entries()) {
    const ts = Date.parse(job?.finishedAt || job?.createdAt || '');
    if (!Number.isFinite(ts)) continue;
    if (now - ts > JOB_TTL_MS) jobs.delete(jobId);
  }
};

setInterval(cleanupStores, 60 * 1000).unref?.();

// 路由：POST /transcribe。
router.post('/transcribe', authenticate, async (req, res) => {
  try {
    await ensureTmpDir();
    const mimeType = sanitizeMime(String(req.headers['x-file-type'] || req.headers['content-type'] || ''));
    if (!isAllowedAudioMime(mimeType)) {
      res.status(400).json({ success: false, message: 'Unsupported audio mime type.' });
      return;
    }

    if (queueDepth() >= MAX_QUEUE_SIZE) {
      res.status(429).json({ success: false, message: 'Transcribe queue is busy.' });
      return;
    }

    const tempPath = path.join(
      TRANSCRIBE_TMP_DIR,
      `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.audio`
    );
    const { size, hash } = await readStreamToFile(req, tempPath, MAX_AUDIO_BYTES);
    if (!size) {
      await fs.unlink(tempPath).catch(() => undefined);
      res.status(400).json({ success: false, message: 'Audio content is empty.' });
      return;
    }

    const cached = hashCache.get(hash);
    if (cached && cached.expiresAtMs > Date.now()) {
      await fs.unlink(tempPath).catch(() => undefined);
      if (isNullTranscribeText(cached.text)) {
        res.json({ success: true, data: null });
        return;
      }
      res.json({
        success: true,
        data: {
          status: 'succeeded',
          text: cached.text,
          cached: true,
        },
      });
      return;
    }

    const userUid = Number(req.auth?.user?.uid) || 0;
    const inFlightKey = hashInFlightKey(userUid, hash);
    const existingJobId = hashInFlight.get(inFlightKey);
    if (existingJobId && jobs.has(existingJobId)) {
      await fs.unlink(tempPath).catch(() => undefined);
      const existingJob = jobs.get(existingJobId);
      if (existingJob?.status === 'succeeded' && isNullTranscribeText(existingJob?.text)) {
        res.json({ success: true, data: null });
        return;
      }
      res.json({
        success: true,
        data: {
          ...toPublicJob(existingJob),
          deduplicated: true,
          pollAfterMs: 700,
        },
      });
      return;
    }

    const jobId = crypto.randomBytes(12).toString('hex');
    const job = {
      id: jobId,
      userUid,
      hash,
      mimeType: mimeType || 'audio/webm',
      size,
      status: 'queued',
      text: '',
      error: '',
      tempPath,
      createdAt: nowIso(),
      startedAt: '',
      finishedAt: '',
    };
    jobs.set(jobId, job);
    hashInFlight.set(inFlightKey, jobId);
    jobQueue.push(jobId);
    pumpQueue();

    res.json({
      success: true,
      data: {
        jobId,
        status: 'queued',
        pollAfterMs: 700,
      },
    });
  } catch (error) {
    console.error('Voice transcribe create job error:', error);
    const mapped = mapTranscribeError(error);
    res.status(mapped.statusCode).json({ success: false, message: mapped.publicMessage });
  }
});

// 路由：GET /transcribe/:jobId。
router.get('/transcribe/:jobId', authenticate, async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) {
      res.status(400).json({ success: false, message: 'Invalid job id.' });
      return;
    }
    const job = jobs.get(jobId);
    if (!job || Number(job.userUid) !== Number(req.auth?.user?.uid)) {
      res.status(404).json({ success: false, message: 'Transcribe job not found.' });
      return;
    }
    if (job.status === 'succeeded' && isNullTranscribeText(job.text)) {
      res.json({ success: true, data: null });
      return;
    }
    res.json({ success: true, data: toPublicJob(job) });
  } catch (error) {
    console.error('Voice transcribe status error:', error);
    res.status(500).json({ success: false, message: 'Failed to query transcribe job.' });
  }
});

export default router;
