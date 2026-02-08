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

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'VoiceTranscribe' });

const MAX_AUDIO_BYTES = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_MAX_AUDIO_BYTES || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12 * 1024 * 1024;
})();
const MAX_QUEUE_SIZE = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_MAX_QUEUE || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();
const MAX_PARALLEL = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_MAX_PARALLEL || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
})();
const JOB_TTL_MS = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_JOB_TTL_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 10 * 60 * 1000;
})();
const HASH_CACHE_TTL_MS = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_CACHE_TTL_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 6 * 60 * 60 * 1000;
})();
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 40_000;
})();
const RETRY_MAX = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_RETRIES || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();
const RETRY_DELAY_MS = (() => {
  const parsed = Number.parseInt(String(process.env.VOICE_TRANSCRIBE_RETRY_DELAY_MS || ''), 10);
  return Number.isFinite(parsed) && parsed >= 100 ? parsed : 500;
})();
const GEMINI_MODEL = String(process.env.VOICE_TRANSCRIBE_MODEL || 'gemini-2.0-flash').trim();
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
]);

let aiClient = null;
let aiClientKey = '';
let activeWorkers = 0;
const jobQueue = [];
const jobs = new Map();
const hashInFlight = new Map();
const hashCache = new Map();
const hashInFlightKey = (uid, hash) => `${Number(uid) || 0}:${String(hash || '')}`;

const getAiClient = () => {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('未配置 GEMINI_API_KEY。');
  }
  if (!aiClient || aiClientKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClientKey = apiKey;
  }
  return aiClient;
};

const ensureTmpDir = async () => {
  await fs.mkdir(TRANSCRIBE_TMP_DIR, { recursive: true });
};

const nowIso = () => new Date().toISOString();

const sanitizeMime = (value) => String(value || '').trim().toLowerCase();

const isAllowedAudioMime = (mime) => {
  if (!mime) return true;
  if (AUDIO_MIME_ALLOW.has(mime)) return true;
  const base = mime.split(';')[0];
  return AUDIO_MIME_ALLOW.has(base);
};

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

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readStreamToFile = (req, tempPath, maxBytes) =>
  new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const hash = crypto.createHash('sha256');
    const writer = createWriteStream(tempPath, { flags: 'wx' });

    const abort = (error) => {
      if (finished) return;
      finished = true;
      req.destroy();
      writer.destroy();
      fs.unlink(tempPath).catch(() => undefined);
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        abort(new Error('文件过大。'));
        return;
      }
      hash.update(chunk);
    });

    req.on('aborted', () => abort(new Error('请求已中断。')));
    req.on('error', (error) => abort(error));
    writer.on('error', (error) => abort(error));
    writer.on('finish', () => {
      if (finished) return;
      finished = true;
      resolve({ size, hash: hash.digest('hex') });
    });
    req.pipe(writer);
  });

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

const requestTranscriptionOnce = async ({ buffer, mimeType }) => {
  const ai = getAiClient();
  const prompt =
    '请将这段语音准确转写为简体中文文本。只输出转写结果，不要添加解释、前缀或标点修饰。';
  const response = await withTimeout(
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
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
  return extractText(response);
};

const requestTranscriptionWithRetry = async ({ buffer, mimeType }) => {
  let lastError = null;
  for (let i = 0; i <= RETRY_MAX; i += 1) {
    try {
      const text = await requestTranscriptionOnce({ buffer, mimeType });
      if (!text) {
        throw new Error('转写结果为空。');
      }
      return text;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const message = String(error?.message || '');
      const retryable =
        /timeout/i.test(message) || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!retryable || i >= RETRY_MAX) break;
      await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
  throw lastError || new Error('语音转写失败。');
};

const toPublicJob = (job) => ({
  jobId: job.id,
  status: job.status,
  createdAt: job.createdAt,
  startedAt: job.startedAt || '',
  finishedAt: job.finishedAt || '',
  text: job.status === 'succeeded' ? job.text : '',
  error: job.status === 'failed' ? job.error : '',
});

const dropJobTempFile = async (job) => {
  if (!job?.tempPath) return;
  await fs.unlink(job.tempPath).catch(() => undefined);
  job.tempPath = '';
};

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
    const text = await requestTranscriptionWithRetry({
      buffer,
      mimeType: job.mimeType,
    });
    job.status = 'succeeded';
    job.text = text.trim();
    job.finishedAt = nowIso();
    hashCache.set(job.hash, {
      text: job.text,
      expiresAtMs: Date.now() + HASH_CACHE_TTL_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '语音转写失败。';
    job.status = 'failed';
    job.error = message || '语音转写失败。';
    job.finishedAt = nowIso();
  } finally {
    hashInFlight.delete(hashInFlightKey(job.userUid, job.hash));
    await dropJobTempFile(job);
  }
};

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

const queueDepth = () => jobQueue.length + activeWorkers;

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
    if (now - ts > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
};

setInterval(cleanupStores, 60 * 1000).unref?.();

router.post('/transcribe', authenticate, async (req, res) => {
  try {
    await ensureTmpDir();
    const mimeType = sanitizeMime(String(req.headers['x-file-type'] || req.headers['content-type'] || ''));
    if (!isAllowedAudioMime(mimeType)) {
      res.status(400).json({ success: false, message: '不支持的音频格式。' });
      return;
    }

    if (queueDepth() >= MAX_QUEUE_SIZE) {
      res.status(429).json({ success: false, message: '系统繁忙，请稍后重试。' });
      return;
    }

    const tempPath = path.join(
      TRANSCRIBE_TMP_DIR,
      `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.audio`
    );
    const { size, hash } = await readStreamToFile(req, tempPath, MAX_AUDIO_BYTES);
    if (!size) {
      await fs.unlink(tempPath).catch(() => undefined);
      res.status(400).json({ success: false, message: '音频内容为空。' });
      return;
    }

    const cached = hashCache.get(hash);
    if (cached && cached.expiresAtMs > Date.now()) {
      await fs.unlink(tempPath).catch(() => undefined);
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
    const message = error?.message === '文件过大。' ? '音频文件过大。' : '语音转写请求失败。';
    res.status(400).json({ success: false, message });
  }
});

router.get('/transcribe/:jobId', authenticate, async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) {
      res.status(400).json({ success: false, message: '任务ID无效。' });
      return;
    }
    const job = jobs.get(jobId);
    if (!job || Number(job.userUid) !== Number(req.auth?.user?.uid)) {
      res.status(404).json({ success: false, message: '任务不存在。' });
      return;
    }
    res.json({ success: true, data: toPublicJob(job) });
  } catch (error) {
    console.error('Voice transcribe status error:', error);
    res.status(500).json({ success: false, message: '获取转写状态失败。' });
  }
});

export default router;
