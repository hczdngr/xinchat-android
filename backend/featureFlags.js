/**
 * Feature flags and phase-level runtime switches.
 * All new features default to disabled to preserve legacy behavior.
 * Runtime overrides are persisted to disk and can be changed online from admin endpoints.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { threadId } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const IS_NODE_TEST = process.argv.includes('--test');
const DEFAULT_RUNTIME_FILENAME = IS_NODE_TEST
  ? `feature-flags.runtime.${process.pid}.${threadId}.json`
  : 'feature-flags.runtime.json';
const FEATURE_FLAGS_RUNTIME_PATH =
  String(process.env.FEATURE_FLAGS_RUNTIME_PATH || '').trim() ||
  path.join(DATA_DIR, DEFAULT_RUNTIME_FILENAME);

const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_SET = new Set(['0', 'false', 'no', 'off', 'disabled']);

const FEATURE_DEFINITIONS = Object.freeze({
  eventLogging: {
    env: 'FEATURE_EVENT_LOG_ENABLED',
    defaultValue: false,
  },
  replyAssistant: {
    env: 'FEATURE_REPLY_ASSISTANT_ENABLED',
    defaultValue: false,
  },
  translatePersonalization: {
    env: 'FEATURE_TRANSLATE_PERSONALIZATION_ENABLED',
    defaultValue: false,
  },
  riskGuard: {
    env: 'FEATURE_RISK_GUARD_ENABLED',
    defaultValue: false,
  },
  relationshipOps: {
    env: 'FEATURE_RELATIONSHIP_OPS_ENABLED',
    defaultValue: false,
  },
  summaryCenter: {
    env: 'FEATURE_SUMMARY_CENTER_ENABLED',
    defaultValue: false,
  },
  recoVw: {
    env: 'FEATURE_RECO_VW_ENABLED',
    defaultValue: false,
  },
  recoVwShadow: {
    env: 'FEATURE_RECO_VW_SHADOW_ENABLED',
    defaultValue: false,
  },
  recoVwOnline: {
    env: 'FEATURE_RECO_VW_ONLINE_ENABLED',
    defaultValue: false,
  },
});

const DEFAULT_RUNTIME_STATE = Object.freeze({
  version: 1,
  updatedAt: '',
  updatedBy: '',
  overrides: {},
});

const cloneValue = (value) => JSON.parse(JSON.stringify(value));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const parseBooleanEnv = (value, defaultValue = false) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return Boolean(defaultValue);
  if (TRUE_SET.has(normalized)) return true;
  if (FALSE_SET.has(normalized)) return false;
  return Boolean(defaultValue);
};

const normalizeRuntimeOverrides = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const output = {};
  Object.keys(FEATURE_DEFINITIONS).forEach((name) => {
    if (!hasOwn(source, name)) return;
    const raw = source[name];
    if (typeof raw === 'boolean') {
      output[name] = raw;
      return;
    }
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) return;
      if (TRUE_SET.has(normalized)) {
        output[name] = true;
      } else if (FALSE_SET.has(normalized)) {
        output[name] = false;
      }
      return;
    }
    if (typeof raw === 'number') {
      output[name] = raw > 0;
    }
  });
  return output;
};

const normalizeRuntimeState = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: Number(source.version) > 0 ? Number(source.version) : 1,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy : '',
    overrides: normalizeRuntimeOverrides(source.overrides),
  };
};

const ensureRuntimeStateDir = async () => {
  await fsPromises.mkdir(path.dirname(FEATURE_FLAGS_RUNTIME_PATH), { recursive: true });
};

const readRuntimeStateFromDiskSync = () => {
  try {
    if (!fs.existsSync(FEATURE_FLAGS_RUNTIME_PATH)) {
      return normalizeRuntimeState(DEFAULT_RUNTIME_STATE);
    }
    const raw = fs.readFileSync(FEATURE_FLAGS_RUNTIME_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeRuntimeState(parsed);
  } catch {
    return normalizeRuntimeState(DEFAULT_RUNTIME_STATE);
  }
};

let runtimeState = readRuntimeStateFromDiskSync();
let runtimeWriteChain = Promise.resolve();

const writeRuntimeStateToDisk = async (state) => {
  await ensureRuntimeStateDir();
  const normalized = normalizeRuntimeState(state);
  const tempPath = `${FEATURE_FLAGS_RUNTIME_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf-8');
  try {
    await fsPromises.rename(tempPath, FEATURE_FLAGS_RUNTIME_PATH);
  } catch {
    await fsPromises.writeFile(FEATURE_FLAGS_RUNTIME_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
    await fsPromises.unlink(tempPath).catch(() => undefined);
  }
};

const getOverrideValue = (name) => {
  if (!hasOwn(runtimeState.overrides, name)) return null;
  return runtimeState.overrides[name] === true;
};

const resolveFeatureEnabled = (name) => {
  if (!hasOwn(FEATURE_DEFINITIONS, name)) return false;
  const override = getOverrideValue(name);
  if (override === true || override === false) return override;
  const definition = FEATURE_DEFINITIONS[name];
  return parseBooleanEnv(process.env[definition.env], definition.defaultValue);
};

const getFeatureFlagsSnapshot = () => {
  const snapshot = {};
  Object.keys(FEATURE_DEFINITIONS).forEach((name) => {
    snapshot[name] = resolveFeatureEnabled(name);
  });
  return snapshot;
};

const getFeatureFlagDetails = () =>
  Object.entries(FEATURE_DEFINITIONS).map(([name, definition]) => {
    const envEnabled = parseBooleanEnv(process.env[definition.env], definition.defaultValue);
    const override = getOverrideValue(name);
    const enabled = override === true || override === false ? override : envEnabled;
    return {
      name,
      env: definition.env,
      defaultValue: Boolean(definition.defaultValue),
      envEnabled,
      override,
      enabled,
      source: override === true || override === false ? 'runtime_override' : 'env',
    };
  });

const persistRuntimeMutation = async (mutator) => {
  const working = normalizeRuntimeState(cloneValue(runtimeState));
  const result = await Promise.resolve(mutator(working));
  runtimeState = normalizeRuntimeState(working);
  runtimeWriteChain = runtimeWriteChain
    .catch(() => undefined)
    .then(() => writeRuntimeStateToDisk(runtimeState));
  await runtimeWriteChain;
  return result;
};

const setFeatureFlagOverride = async (name, enabled, { actor = 'system' } = {}) => {
  const key = String(name || '').trim();
  if (!hasOwn(FEATURE_DEFINITIONS, key)) {
    throw new Error('invalid_feature_flag');
  }
  await persistRuntimeMutation((working) => {
    if (!working.overrides || typeof working.overrides !== 'object') {
      working.overrides = {};
    }
    if (enabled === null || typeof enabled === 'undefined') {
      delete working.overrides[key];
    } else {
      working.overrides[key] = Boolean(enabled);
    }
    working.updatedAt = new Date().toISOString();
    working.updatedBy = String(actor || 'system').slice(0, 80);
  });
  return {
    name: key,
    override: getOverrideValue(key),
    enabled: resolveFeatureEnabled(key),
  };
};

const bulkUpdateFeatureFlagOverrides = async (changes = {}, { actor = 'system' } = {}) => {
  const input = changes && typeof changes === 'object' ? changes : {};
  const touched = [];
  await persistRuntimeMutation((working) => {
    if (!working.overrides || typeof working.overrides !== 'object') {
      working.overrides = {};
    }
    Object.entries(input).forEach(([name, value]) => {
      if (!hasOwn(FEATURE_DEFINITIONS, name)) return;
      if (value === null || typeof value === 'undefined') {
        delete working.overrides[name];
        touched.push(name);
        return;
      }
      working.overrides[name] = Boolean(value);
      touched.push(name);
    });
    if (touched.length > 0) {
      working.updatedAt = new Date().toISOString();
      working.updatedBy = String(actor || 'system').slice(0, 80);
    }
  });
  return touched.map((name) => ({
    name,
    override: getOverrideValue(name),
    enabled: resolveFeatureEnabled(name),
  }));
};

const clearFeatureFlagOverrides = async ({ actor = 'system' } = {}) => {
  await persistRuntimeMutation((working) => {
    working.overrides = {};
    working.updatedAt = new Date().toISOString();
    working.updatedBy = String(actor || 'system').slice(0, 80);
  });
};

const getFeatureFlagRuntimeState = () => ({
  path: FEATURE_FLAGS_RUNTIME_PATH,
  updatedAt: runtimeState.updatedAt,
  updatedBy: runtimeState.updatedBy,
  overrides: { ...(runtimeState.overrides || {}) },
});

const isFeatureEnabled = (name) => resolveFeatureEnabled(name);

export {
  FEATURE_DEFINITIONS,
  bulkUpdateFeatureFlagOverrides,
  clearFeatureFlagOverrides,
  getFeatureFlagDetails,
  getFeatureFlagRuntimeState,
  getFeatureFlagsSnapshot,
  isFeatureEnabled,
  parseBooleanEnv,
  setFeatureFlagOverride,
};
