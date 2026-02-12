/**
 * Runtime config store for Phase5 recommendation/VW controls.
 * Config is persisted and can be modified online from admin endpoints.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { threadId } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const IS_NODE_TEST = process.argv.includes('--test');
const DEFAULT_CONFIG_PATH = path.join(
  DATA_DIR,
  IS_NODE_TEST
    ? `reco-runtime-config.${process.pid}.${threadId}.json`
    : 'reco-runtime-config.json'
);
const RECO_CONFIG_PATH =
  String(process.env.RECO_RUNTIME_CONFIG_PATH || '').trim() || DEFAULT_CONFIG_PATH;

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampNumber = (value, min, max, fallback) => {
  const parsed = toFiniteNumber(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const DEFAULT_RECO_RUNTIME_CONFIG = Object.freeze({
  version: 1,
  updatedAt: '',
  updatedBy: '',
  rolloutPercent: clampNumber(process.env.RECO_VW_ROLLOUT_PERCENT, 0, 100, 10),
  epsilon: clampNumber(process.env.RECO_VW_EPSILON, 0, 0.8, 0.1),
  learningRate: clampNumber(process.env.RECO_VW_LEARNING_RATE, 0.001, 0.5, 0.08),
  onlineUpdate: toBoolean(process.env.RECO_VW_ONLINE_UPDATE, true),
  minCandidates: clampNumber(process.env.RECO_VW_MIN_CANDIDATES, 1, 100, 2),
  maxCandidates: clampNumber(process.env.RECO_VW_MAX_CANDIDATES, 1, 300, 60),
  enablePushIntensity: toBoolean(process.env.RECO_VW_PUSH_INTENSITY_ENABLED, true),
  pushIntensityBase: clampNumber(process.env.RECO_VW_PUSH_INTENSITY_BASE, 0, 1, 0.35),
  vwBinaryPath: String(process.env.VW_BINARY_PATH || '').trim(),
  vwModelPath: String(process.env.VW_MODEL_PATH || '').trim(),
  vwTimeoutMs: clampNumber(process.env.VW_TIMEOUT_MS, 200, 20_000, 1500),
});

const cloneValue = (value) => JSON.parse(JSON.stringify(value));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const normalizeConfig = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: 1,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy : '',
    rolloutPercent: clampNumber(
      source.rolloutPercent,
      0,
      100,
      DEFAULT_RECO_RUNTIME_CONFIG.rolloutPercent
    ),
    epsilon: clampNumber(source.epsilon, 0, 0.8, DEFAULT_RECO_RUNTIME_CONFIG.epsilon),
    learningRate: clampNumber(
      source.learningRate,
      0.001,
      0.5,
      DEFAULT_RECO_RUNTIME_CONFIG.learningRate
    ),
    onlineUpdate: toBoolean(source.onlineUpdate, DEFAULT_RECO_RUNTIME_CONFIG.onlineUpdate),
    minCandidates: Math.floor(
      clampNumber(source.minCandidates, 1, 100, DEFAULT_RECO_RUNTIME_CONFIG.minCandidates)
    ),
    maxCandidates: Math.floor(
      clampNumber(source.maxCandidates, 1, 300, DEFAULT_RECO_RUNTIME_CONFIG.maxCandidates)
    ),
    enablePushIntensity: toBoolean(
      source.enablePushIntensity,
      DEFAULT_RECO_RUNTIME_CONFIG.enablePushIntensity
    ),
    pushIntensityBase: clampNumber(
      source.pushIntensityBase,
      0,
      1,
      DEFAULT_RECO_RUNTIME_CONFIG.pushIntensityBase
    ),
    vwBinaryPath:
      typeof source.vwBinaryPath === 'string'
        ? source.vwBinaryPath.trim()
        : DEFAULT_RECO_RUNTIME_CONFIG.vwBinaryPath,
    vwModelPath:
      typeof source.vwModelPath === 'string'
        ? source.vwModelPath.trim()
        : DEFAULT_RECO_RUNTIME_CONFIG.vwModelPath,
    vwTimeoutMs: Math.floor(
      clampNumber(source.vwTimeoutMs, 200, 20_000, DEFAULT_RECO_RUNTIME_CONFIG.vwTimeoutMs)
    ),
  };
};

let runtimeConfigCache = null;
let runtimeConfigLoadPromise = null;
let runtimeConfigWriteChain = Promise.resolve();

const ensureConfigDir = async () => {
  await fs.mkdir(path.dirname(RECO_CONFIG_PATH), { recursive: true });
};

const readConfigFromDisk = async () => {
  try {
    const raw = await fs.readFile(RECO_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig(DEFAULT_RECO_RUNTIME_CONFIG);
  }
};

const writeConfigWithRetry = async (config, retries = 2) => {
  await ensureConfigDir();
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let tempPath = '';
    try {
      tempPath = `${RECO_CONFIG_PATH}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(config, null, 2), 'utf-8');
      await fs.rename(tempPath, RECO_CONFIG_PATH);
      return;
    } catch (error) {
      lastError = error;
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  throw lastError || new Error('reco_runtime_config_write_failed');
};

const ensureConfigLoaded = async () => {
  if (runtimeConfigCache) return runtimeConfigCache;
  if (runtimeConfigLoadPromise) return runtimeConfigLoadPromise;
  runtimeConfigLoadPromise = readConfigFromDisk()
    .then((config) => {
      runtimeConfigCache = config;
      return runtimeConfigCache;
    })
    .finally(() => {
      runtimeConfigLoadPromise = null;
    });
  return runtimeConfigLoadPromise;
};

const persistConfig = async () => {
  if (!runtimeConfigCache) return;
  const next = normalizeConfig(runtimeConfigCache);
  runtimeConfigCache = next;
  await writeConfigWithRetry(next, 3);
};

const mutateConfig = async (mutator, { defaultResult = null } = {}) => {
  await ensureConfigLoaded();
  const working = cloneValue(runtimeConfigCache || DEFAULT_RECO_RUNTIME_CONFIG);
  let mutationResult = defaultResult;
  try {
    mutationResult = (await mutator(working)) ?? defaultResult;
  } catch {
    return defaultResult;
  }
  runtimeConfigCache = normalizeConfig(working);
  runtimeConfigWriteChain = runtimeConfigWriteChain.catch(() => undefined).then(() => persistConfig());
  await runtimeConfigWriteChain;
  return mutationResult;
};

const getRecoRuntimeConfig = async () => {
  const config = await ensureConfigLoaded();
  return normalizeConfig(config);
};

const updateRecoRuntimeConfig = async (patch = {}, { actor = 'system' } = {}) => {
  const source = patch && typeof patch === 'object' ? patch : {};
  const next = await mutateConfig((working) => {
    Object.keys(source).forEach((key) => {
      if (!hasOwn(working, key) || key === 'version' || key === 'updatedAt' || key === 'updatedBy') {
        return;
      }
      working[key] = source[key];
    });
    working.updatedAt = new Date().toISOString();
    working.updatedBy = String(actor || 'system').slice(0, 80);
    return normalizeConfig(working);
  });
  return next || (await getRecoRuntimeConfig());
};

const resetRecoRuntimeConfigForTests = async () => {
  runtimeConfigCache = normalizeConfig(DEFAULT_RECO_RUNTIME_CONFIG);
  runtimeConfigWriteChain = runtimeConfigWriteChain
    .catch(() => undefined)
    .then(() => writeConfigWithRetry(runtimeConfigCache, 3));
  await runtimeConfigWriteChain;
  return normalizeConfig(runtimeConfigCache);
};

const getRecoConfigStoreInfo = async () => {
  const config = await getRecoRuntimeConfig();
  return {
    path: RECO_CONFIG_PATH,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
};

export {
  DEFAULT_RECO_RUNTIME_CONFIG,
  RECO_CONFIG_PATH,
  getRecoConfigStoreInfo,
  getRecoRuntimeConfig,
  resetRecoRuntimeConfigForTests,
  updateRecoRuntimeConfig,
};
