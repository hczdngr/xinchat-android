import crypto from 'crypto';
import util from 'util';

const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const normalizeLevel = (value, fallback = 'info') => {
  const level = String(value || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
    return level;
  }
  return fallback;
};

const ACTIVE_LOG_LEVEL = normalizeLevel(
  process.env.LOG_LEVEL,
  String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'info' : 'debug'
);
const LOG_PASSTHROUGH_CONSOLE =
  String(process.env.LOG_PASSTHROUGH_CONSOLE || '').trim().toLowerCase() === 'true';
const REQUEST_ID_HEADER = 'x-request-id';

const toSafeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const serializeError = (error) => {
  if (!(error instanceof Error)) {
    return { message: String(error || '') };
  }
  const payload = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) payload.stack = error.stack;
  if (error.cause) payload.cause = sanitizeValue(error.cause, 1);
  return payload;
};

const sanitizeValue = (value, depth = 0) => {
  if (depth > 4) return '[depth_limit]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 4000 ? `${value.slice(0, 4000)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.entries(value)
      .slice(0, 60)
      .forEach(([key, entry]) => {
        out[key] = sanitizeValue(entry, depth + 1);
      });
    return out;
  }
  return String(value);
};

const toMetaObject = (meta) => {
  const safe = sanitizeValue(meta);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return { data: safe };
  }
  return safe;
};

const shouldLog = (level) => LOG_LEVELS[level] >= LOG_LEVELS[ACTIVE_LOG_LEVEL];

const emitLog = (level, message, meta = {}) => {
  if (!shouldLog(level)) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: String(message || ''),
    pid: process.pid,
    ...toMetaObject(meta),
  };
  const line = JSON.stringify(record);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

const toMessageMeta = (args) => {
  if (!Array.isArray(args) || args.length === 0) {
    return { message: '', meta: {} };
  }
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    if (rest.length === 0) return { message: first, meta: {} };
    if (rest.length === 1 && typeof rest[0] === 'object' && rest[0] !== null) {
      return { message: first, meta: { data: sanitizeValue(rest[0]) } };
    }
    return { message: first, meta: { data: sanitizeValue(rest) } };
  }
  if (first instanceof Error) {
    return {
      message: first.message || first.name || 'Error',
      meta: { error: serializeError(first), data: sanitizeValue(rest) },
    };
  }
  return {
    message: util.format(...args),
    meta: {},
  };
};

const logger = {
  level: ACTIVE_LOG_LEVEL,
  debug(message, meta) {
    emitLog('debug', message, meta);
  },
  info(message, meta) {
    emitLog('info', message, meta);
  },
  warn(message, meta) {
    emitLog('warn', message, meta);
  },
  error(message, meta) {
    emitLog('error', message, meta);
  },
};

let consoleBridgeInstalled = false;

const installConsoleBridge = () => {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  const methods = [
    ['debug', 'debug'],
    ['info', 'info'],
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];
  methods.forEach(([method, level]) => {
    const original = console[method]?.bind(console);
    if (typeof original !== 'function') return;
    console[method] = (...args) => {
      const { message, meta } = toMessageMeta(args);
      emitLog(level, message || method, { legacyConsole: true, ...meta });
      if (LOG_PASSTHROUGH_CONSOLE) {
        original(...args);
      }
    };
  });
};

const metricState = {
  counters: new Map(),
  gauges: new Map(),
  histograms: new Map(),
};

const normalizeLabels = (labels) => {
  if (!labels || typeof labels !== 'object') return {};
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [String(key), String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

const makeMetricKey = (name, labels) => `${name}|${JSON.stringify(labels)}`;

const getOrCreateMetricEntry = (store, name, labels, initFactory) => {
  const safeName = String(name || '').trim();
  if (!safeName) {
    throw new Error('Metric name is required.');
  }
  const safeLabels = normalizeLabels(labels);
  const key = makeMetricKey(safeName, safeLabels);
  if (!store.has(key)) {
    store.set(key, {
      name: safeName,
      labels: safeLabels,
      ...initFactory(),
    });
  }
  return store.get(key);
};

const metrics = {
  incCounter(name, value = 1, labels = {}) {
    const entry = getOrCreateMetricEntry(metricState.counters, name, labels, () => ({
      value: 0,
      updatedAt: new Date().toISOString(),
    }));
    entry.value += toSafeNumber(value, 0);
    entry.updatedAt = new Date().toISOString();
  },
  setGauge(name, value = 0, labels = {}) {
    const entry = getOrCreateMetricEntry(metricState.gauges, name, labels, () => ({
      value: 0,
      updatedAt: new Date().toISOString(),
    }));
    entry.value = toSafeNumber(value, 0);
    entry.updatedAt = new Date().toISOString();
  },
  observeHistogram(name, value, labels = {}) {
    const val = toSafeNumber(value, NaN);
    if (!Number.isFinite(val)) return;
    const entry = getOrCreateMetricEntry(metricState.histograms, name, labels, () => ({
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      last: 0,
      updatedAt: new Date().toISOString(),
    }));
    entry.count += 1;
    entry.sum += val;
    entry.min = Math.min(entry.min, val);
    entry.max = Math.max(entry.max, val);
    entry.last = val;
    entry.updatedAt = new Date().toISOString();
  },
  snapshot() {
    const collect = (store) =>
      Array.from(store.values()).map((entry) => ({
        ...entry,
        labels: { ...(entry.labels || {}) },
      }));
    return {
      generatedAt: new Date().toISOString(),
      counters: collect(metricState.counters),
      gauges: collect(metricState.gauges),
      histograms: collect(metricState.histograms).map((entry) => ({
        ...entry,
        avg: entry.count > 0 ? entry.sum / entry.count : 0,
      })),
    };
  },
};

const createRequestContextMiddleware = () => (req, res, next) => {
  const incoming = String(req.headers[REQUEST_ID_HEADER] || '').trim();
  const requestId = incoming || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

const normalizeMetricPath = (value) => {
  const source = String(value || '').split('?')[0].trim();
  if (!source) return '/';
  const parts = source
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ':num';
      if (/^[a-f0-9]{12,}$/i.test(segment)) return ':id';
      if (segment.length > 48) return ':var';
      return segment;
    });
  return `/${parts.join('/')}`;
};

const createHttpMetricsMiddleware = ({ skipPaths = [] } = {}) => {
  const skipSet = new Set(skipPaths.map((item) => normalizeMetricPath(item)));
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const method = String(req.method || 'GET').toUpperCase();
    const path = normalizeMetricPath(req.path || req.originalUrl || '/');
    if (!skipSet.has(path)) {
      metrics.incCounter('http_requests_total', 1, { method, path });
    }
    res.on('finish', () => {
      if (skipSet.has(path)) return;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const statusCode = Number(res.statusCode) || 0;
      const statusClass =
        statusCode >= 100 ? `${Math.floor(statusCode / 100)}xx` : 'unknown';
      metrics.incCounter('http_responses_total', 1, { method, path, statusClass });
      metrics.observeHistogram('http_request_duration_ms', durationMs, {
        method,
        path,
        statusClass,
      });
    });
    next();
  };
};

export {
  createHttpMetricsMiddleware,
  createRequestContextMiddleware,
  installConsoleBridge,
  logger,
  metrics,
  normalizeMetricPath,
  serializeError,
};

