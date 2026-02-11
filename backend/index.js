/**
 * 模块说明：应用入口模块：组装 HTTP/WS 服务、中间件、路由与运行时守护逻辑。
 */


import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import authRouter, {
  ensureStorage,
  findUserByToken,
  forceRefreshUsersCache,
  getUsersCacheInfo,
  mutateUsers,
  readUsersCached,
  readUsers,
} from './routes/auth.js';
import chatRouter, { ensureChatStorage, setChatNotifier } from './routes/chat.js';
import friendsRouter, { setFriendsNotifier } from './routes/friends.js';
import groupsRouter, {
  ensureGroupStorage,
  getGroupMemberUids,
  setGroupsNotifier,
} from './routes/groups.js';
import voiceRouter from './routes/voice.js';
import voiceTranscribeRouter from './routes/voiceTranscribe.js';
import insightApiRouter, { prewarmWarmTipCache } from './routes/insightApi.js';
import adminRouter from './routes/admin.js';
import { startInsightWorker } from './routes/insight.js';
import { getTokenId, onTokenRevoked } from './tokenRevocation.js';
import {
  markDisconnected,
  isUserOnline,
  setStatusChangeHandler,
  setTimeoutHandler,
  startHeartbeatMonitor,
  stopHeartbeatMonitor,
  touchHeartbeat,
} from './online.js';
import {
  createHttpMetricsMiddleware,
  createRequestContextMiddleware,
  installConsoleBridge,
  logger,
  metrics,
  serializeError,
} from './observability.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROUTE_INSPECTOR_ENABLED =
  NODE_ENV !== 'production' || process.env.ENABLE_ROUTE_INSPECTOR === 'true';
const AUTH_COOKIE_NAME =
  String(process.env.AUTH_COOKIE_NAME || 'xinchat_token').trim() || 'xinchat_token';
// parsePositiveInt：解析并校验输入值。
const parsePositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
};
// parseCookieHeader：解析并校验输入值。
const parseCookieHeader = (raw) => {
  const result = {};
  const source = String(raw || '').trim();
  if (!source) return result;
  source.split(';').forEach((item) => {
    const segment = String(item || '').trim();
    if (!segment) return;
    const splitIndex = segment.indexOf('=');
    if (splitIndex <= 0) return;
    const name = segment.slice(0, splitIndex).trim();
    const valueRaw = segment.slice(splitIndex + 1).trim();
    if (!name) return;
    try {
      result[name] = decodeURIComponent(valueRaw);
    } catch {
      result[name] = valueRaw;
    }
  });
  return result;
};
// extractTokenFromCookieHeader：提取请求中的关键信息。
const extractTokenFromCookieHeader = (cookieHeader) => {
  const cookies = parseCookieHeader(cookieHeader || '');
  return String(cookies[AUTH_COOKIE_NAME] || '').trim();
};
const REQUEST_BODY_LIMIT_MB = parsePositiveInt(process.env.REQUEST_BODY_LIMIT_MB, 24, 1);
const REQUEST_BODY_LIMIT = `${REQUEST_BODY_LIMIT_MB}mb`;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = parsePositiveInt(
  process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
  65_000,
  1_000
);
const HTTP_HEADERS_TIMEOUT_MS = parsePositiveInt(
  process.env.HTTP_HEADERS_TIMEOUT_MS,
  66_000,
  HTTP_KEEP_ALIVE_TIMEOUT_MS + 1_000
);
const HTTP_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.HTTP_REQUEST_TIMEOUT_MS, 0, 0);
const HTTP_SOCKET_KEEP_ALIVE_MS = parsePositiveInt(
  process.env.HTTP_SOCKET_KEEP_ALIVE_MS,
  30_000,
  1_000
);
const HTTP_LISTEN_BACKLOG = parsePositiveInt(process.env.HTTP_LISTEN_BACKLOG, 2048, 128);
const WS_MAX_PAYLOAD_BYTES = parsePositiveInt(
  process.env.WS_MAX_PAYLOAD_BYTES,
  512 * 1024,
  1024
);
const WS_MAX_BACKPRESSURE_BYTES = parsePositiveInt(
  process.env.WS_MAX_BACKPRESSURE_BYTES,
  2 * 1024 * 1024,
  64 * 1024
);
const WS_MAX_CONNECTIONS = parsePositiveInt(process.env.WS_MAX_CONNECTIONS, 20_000, 1);
const WS_MAX_MESSAGE_BYTES = parsePositiveInt(
  process.env.WS_MAX_MESSAGE_BYTES,
  256 * 1024,
  1024
);
const MAX_UID = parsePositiveInt(process.env.MAX_UID, 2147483647, 1);
const WS_MAX_CONNECTIONS_PER_UID = parsePositiveInt(
  process.env.WS_MAX_CONNECTIONS_PER_UID,
  3,
  1
);
const WS_CONNECTION_CLEANUP_INTERVAL_MS = parsePositiveInt(
  process.env.WS_CONNECTION_CLEANUP_INTERVAL_MS,
  30_000,
  1_000
);
const WS_CONNECTION_STALE_MS = parsePositiveInt(
  process.env.WS_CONNECTION_STALE_MS,
  90_000,
  10_000
);
const WS_MAX_SIGNAL_BYTES = parsePositiveInt(
  process.env.WS_MAX_SIGNAL_BYTES,
  128 * 1024,
  512
);
const ADMIN_METRICS_ENABLED =
  NODE_ENV !== 'production' || process.env.ENABLE_ADMIN_METRICS === 'true';
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = NODE_ENV !== 'production' && CORS_ALLOWED_ORIGINS.length === 0;
// isValidUid：判断条件是否成立。
const isValidUid = (value) => Number.isInteger(value) && value > 0 && value <= MAX_UID;
// isPlainObject：判断条件是否成立。
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// estimatePayloadBytes?处理 estimatePayloadBytes 相关逻辑。
const estimatePayloadBytes = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
};

installConsoleBridge();

export const app = express();
app.disable('x-powered-by');
app.use(createRequestContextMiddleware());
app.use(
  createHttpMetricsMiddleware({
    skipPaths: [
      '/api/admin/metrics',
      '/api/admin/bottlenecks',
      '/api/admin/users/summary',
      '/api/admin/products/summary',
    ],
  })
);

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use('/api', (req, res, next) => {
  const method = String(req.method || '').toUpperCase();
  const shouldValidateBody =
    method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!shouldValidateBody) {
    next();
    return;
  }
  if (req.is('application/json') && !isPlainObject(req.body)) {
    res.status(400).json({ success: false, message: 'Invalid JSON body.' });
    return;
  }
  next();
});
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const originAllowed =
    !origin || CORS_ALLOW_ALL || CORS_ALLOWED_ORIGINS.includes(origin);
  if (!originAllowed) {
    res.status(403).json({ success: false, message: '跨域来源不被允许。' });
    return;
  }
  if (origin) {
    if (CORS_ALLOW_ALL) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (CORS_ALLOWED_ORIGINS.length > 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else if (CORS_ALLOW_ALL) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  const requestHeaders = req.headers['access-control-request-headers'];
  if (requestHeaders) {
    res.setHeader('Access-Control-Allow-Headers', requestHeaders);
  } else {
	    res.setHeader(
	      'Access-Control-Allow-Headers',
	      'Content-Type, Authorization, X-File-Ext, X-File-Hash, X-File-Name, X-File-Type, X-Xinchat-Device-Id, X-Device-Id, X-Xinchat-Device-Created-At, X-Device-Created-At'
	    );
	  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html', 'index.html'));
});

const routeMeta = [
  {
    method: 'GET',
    path: '/',
    label: 'Root',
    note: 'Service root path that returns the admin index page.',
    templates: [{ name: 'Open root', body: null, hint: 'No body' }],
  },
  {
    method: 'GET',
    path: '/admin',
    label: 'Admin',
    note: 'Backend admin page.',
    templates: [{ name: 'Open admin', body: null, hint: 'No body' }],
  },
  {
    method: 'GET',
    path: '/resource/*',
    label: 'Static resource',
    note: 'Read a file from backend static resource folder.',
    templates: [
      {
        name: 'Example file',
        body: null,
        path: '/resource/example.png',
        hint: 'Replace with actual filename',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/register',
    label: 'Register',
    note: 'Create a new account; server allocates uid.',
    templates: [
      {
        name: 'Quick register',
        body: { username: 'demo_user', password: 'demo_pass_123' },
        hint: 'Password length 8-64',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/login',
    label: 'Login',
    note: 'Login with existing account.',
    templates: [
      {
        name: 'Standard login',
        body: { username: 'demo_user', password: 'demo_pass_123' },
        hint: 'Username is lowercased',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/chat/send',
    label: 'Send chat',
    note: 'Send chat message with token.',
    templates: [
      {
        name: 'Text message',
        body: {
          senderUid: 100000000,
          targetUid: 100000001,
          targetType: 'private',
          type: 'text',
          content: 'Hello',
        },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Image message',
        body: {
          senderUid: 100000000,
          targetUid: 100000001,
          targetType: 'private',
          type: 'image',
          url: 'https://example.com/image.png',
        },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'File message',
        body: {
          senderUid: 100000000,
          targetUid: 100000001,
          targetType: 'private',
          type: 'file',
          name: 'example.pdf',
          size: 2048,
          dataUrl: 'data:application/pdf;base64,',
        },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Voice message',
        body: {
          senderUid: 100000000,
          targetUid: 100000001,
          targetType: 'private',
          type: 'voice',
          url: 'https://example.com/audio.mp3',
          duration: 2.4,
        },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/chat/get',
    label: 'Fetch chat',
    note: 'Fetch chat messages by target.',
    templates: [
      {
        name: 'Private chat',
        body: { targetType: 'private', targetUid: 100000001 },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Private text messages',
        body: { targetType: 'private', targetUid: 100000001, type: 'text' },
        hint: 'Or use query params',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/chat/overview',
    label: 'Chat overview',
    note: 'Fetch latest message and unread count for all private chats.',
    templates: [
      {
        name: 'Overview with read map',
        body: { readAt: { 100000001: 1736458200000 } },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'DELETE',
    path: '/api/chat/del',
    label: 'Delete chat',
    note: 'Delete a message by id.',
    templates: [
      {
        name: 'Delete message',
        body: { id: 'message-id' },
        hint: 'Replace with actual id',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/friends/add',
    label: 'Add friend',
    note: 'Add friend by uid or username.',
    templates: [
      {
        name: 'Add by uid',
        body: { friendUid: 100000001 },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Add by username',
        body: { friendUsername: 'demo_user' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'DELETE',
    path: '/api/friends/remove',
    label: 'Remove friend',
    note: 'Remove friend by uid or username.',
    templates: [
      {
        name: 'Remove by uid',
        body: { friendUid: 100000001 },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Remove by username',
        body: { friendUsername: 'demo_user' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/friends/list',
    label: 'Friend list',
    note: 'Return current user friend list.',
    templates: [
      {
        name: 'List friends',
        body: null,
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/friends/search',
    label: 'Search user',
    note: 'Search user by uid.',
    templates: [
      {
        name: 'Search by uid',
        body: { uid: 100000001 },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/groups/list',
    label: 'Group list',
    note: 'Return groups that current user has joined.',
    templates: [
      {
        name: 'List groups',
        body: null,
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/groups/create',
    label: 'Create group',
    note: 'Create a new group chat from selected friend uids.',
    templates: [
      {
        name: 'Create group',
        body: { memberUids: [100000001, 100000002] },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/groups/detail',
    label: 'Group detail',
    note: 'Get details of a group by id.',
    templates: [
      {
        name: 'Get group detail',
        body: { groupId: 2000000000 },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/groups/update',
    label: 'Update group',
    note: 'Update group profile fields or your nickname in group.',
    templates: [
      {
        name: 'Update name',
        body: { groupId: 2000000000, name: 'New Group Name' },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Update announcement',
        body: { groupId: 2000000000, announcement: 'Welcome to this group' },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Update my nickname',
        body: { groupId: 2000000000, myNickname: 'My Group Nick' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/groups/leave',
    label: 'Leave group',
    note: 'Leave a joined group.',
    templates: [
      {
        name: 'Leave group',
        body: { groupId: 2000000000 },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/voice/directory',
    label: 'Voice directory',
    note: 'Get voice contact directory.',
    templates: [
      {
        name: 'Voice directory',
        body: null,
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/voice/contact',
    label: 'Voice contact',
    note: 'Get voice contact info by uid.',
    templates: [
      {
        name: 'Voice contact',
        body: { uid: 100000001 },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/voice/domain',
    label: 'Voice domain',
    note: 'Update current user domain for voice calls.',
    templates: [
      {
        name: 'Set domain',
        body: { domain: 'example.com' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/insight/warm-tip',
    label: 'Warm tip',
    note: 'Generate a dynamic warm tip from current user profile.',
    templates: [
      {
        name: 'Get warm tip',
        body: null,
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/insight/encyclopedia',
    label: 'Encyclopedia',
    note: 'Search encyclopedia summary from network by keyword.',
    templates: [
      {
        name: 'Search encyclopedia',
        body: { query: '猫' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/insight/object-detect',
    label: 'Object detect',
    note: 'Detect objects in an image through Gemini multimodal API.',
    templates: [
      {
        name: 'Detect from data URL',
        body: { image: 'data:image/jpeg;base64,...' },
        hint: 'Authorization: Bearer <token>',
      },
      {
        name: 'Detect from base64',
        body: { mimeType: 'image/jpeg', base64: '...' },
        hint: 'Authorization: Bearer <token>',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/admin/metrics',
    label: 'Admin metrics',
    note: 'Return runtime counters, gauges, histograms, and cache state.',
    templates: [{ name: 'Get metrics', body: null, hint: 'No body' }],
  },
  {
    method: 'GET',
    path: '/api/admin/bottlenecks',
    label: 'Bottlenecks',
    note: 'Return slow endpoints, error hotspots and tuning suggestions.',
    templates: [{ name: 'Get bottlenecks', body: null, hint: 'X-Admin-Token or adminToken' }],
  },
  {
    method: 'GET',
    path: '/api/admin/users/summary',
    label: 'Users summary',
    note: 'Return aggregated user status and token counters.',
    templates: [{ name: 'Users summary', body: null, hint: 'X-Admin-Token or adminToken' }],
  },
  {
    method: 'GET',
    path: '/api/admin/users',
    label: 'Users list',
    note: 'List users with pagination and keyword/status filters.',
    templates: [
      {
        name: 'Page users',
        body: null,
        path: '/api/admin/users?page=1&pageSize=20&status=all&q=',
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/admin/users/detail',
    label: 'User detail',
    note: 'Get one user detail by uid.',
    templates: [
      {
        name: 'Read user',
        body: null,
        path: '/api/admin/users/detail?uid=100000000',
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/admin/users/update',
    label: 'Update user',
    note: 'Update user profile/status fields with validation.',
    templates: [
      {
        name: 'Patch user',
        body: { uid: 100000000, nickname: 'new-name', status: 'active' },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/admin/users/revoke-all',
    label: 'Revoke sessions',
    note: 'Revoke all active user sessions and force offline.',
    templates: [
      {
        name: 'Revoke by uid',
        body: { uid: 100000000 },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/admin/users/soft-delete',
    label: 'Soft delete user',
    note: 'Soft delete or restore a user account.',
    templates: [
      {
        name: 'Soft delete',
        body: { uid: 100000000, restore: false },
        hint: 'X-Admin-Token or adminToken',
      },
      {
        name: 'Restore',
        body: { uid: 100000000, restore: true },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/admin/products/summary',
    label: 'Products summary',
    note: 'Return product status and inventory aggregates.',
    templates: [
      {
        name: 'Products summary',
        body: null,
        path: '/api/admin/products/summary?lowStockThreshold=10',
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/admin/products',
    label: 'Products list',
    note: 'List products with pagination and keyword/status filters.',
    templates: [
      {
        name: 'Page products',
        body: null,
        path: '/api/admin/products?page=1&pageSize=20&status=all&q=',
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/admin/products/create',
    label: 'Create product',
    note: 'Create one product with validation and normalization.',
    templates: [
      {
        name: 'New product',
        body: { name: 'XinChat Pro', sku: 'XCP-001', price: 99, stock: 200, status: 'active' },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/admin/products/update',
    label: 'Update product',
    note: 'Update product fields by id.',
    templates: [
      {
        name: 'Update product',
        body: { id: 1, price: 119, stock: 150 },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'DELETE',
    path: '/api/admin/products/delete',
    label: 'Delete product',
    note: 'Delete one product by id.',
    templates: [
      {
        name: 'Delete product',
        body: { id: 1 },
        hint: 'X-Admin-Token or adminToken',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/routes',
    label: 'Routes',
    note: 'List backend routes and templates.',
    templates: [{ name: 'List routes', body: null, hint: 'No body' }],
  },
];

// normalizePath：归一化外部输入。
const normalizePath = (value) => {
  if (!value) return '';
  let result = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (result !== '/' && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

// joinPath?处理 joinPath 相关逻辑。
const joinPath = (base, next) => {
  const left = normalizePath(base);
  const right = normalizePath(next);
  const combined = normalizePath(`${left}${right}`);
  return combined || '/';
};

// regexpToPath?处理 regexpToPath 相关逻辑。
const regexpToPath = (regexp) => {
  if (!regexp) return '';
  if (regexp.fast_slash) return '';
  let source = regexp.source;
  source = source
    .replace(/\\\/\?\(\?=\\\/\|\$\)/g, '')
    .replace(/\(\?:\\\/\|\$\)/g, '')
    .replace(/\(\?=\\\/\|\$\)/g, '')
    .replace(/\\\//g, '/')
    .replace(/^\^/, '')
    .replace(/\$$/, '');
  if (!source) return '';
  if (source === '\\/?') return '';
  return source.startsWith('/') ? source : `/${source}`;
};

// collectRoutes?处理 collectRoutes 相关逻辑。
const collectRoutes = (target) => {
  const routes = [];
  const walk = (stack, basePath = '') => {
    stack.forEach((layer) => {
      if (layer.route) {
        const routePath = joinPath(basePath, layer.route.path);
        const methods = Object.keys(layer.route.methods || {}).map((method) =>
          method.toUpperCase()
        );
        methods.forEach((method) => routes.push({ method, path: routePath }));
        return;
      }

      const layerPath = regexpToPath(layer.regexp);
      const nextBase = joinPath(basePath, layerPath);

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, nextBase);
        return;
      }

      if (layer.name === 'serveStatic') {
        const staticPath =
          nextBase === '/' ? '/resource/*' : `${normalizePath(nextBase)}/*`;
        routes.push({ method: 'GET', path: staticPath });
      }
    });
  };

  if (target?._router?.stack) {
    walk(target._router.stack);
  }
  return routes;
};

// buildRouteResponse：构建对外输出数据。
const buildRouteResponse = (target) => {
  const autoRoutes = collectRoutes(target);
  const used = new Set();

  const toKey = (method, routePath) => `${method} ${routePath}`;
  const matchMeta = (method, routePath) => {
    const direct = routeMeta.find(
      (meta) => meta.method === method && meta.path === routePath
    );
    if (direct) return direct;
    const wildcard = routeMeta.find(
      (meta) =>
        meta.method === method &&
        meta.path.endsWith('/*') &&
        routePath === meta.path.slice(0, -2)
    );
    return wildcard;
  };

  const enriched = autoRoutes.map((route) => {
    const meta = matchMeta(route.method, route.path);
    if (meta) {
      used.add(toKey(meta.method, meta.path));
      return { ...route, ...meta };
    }
    return {
      ...route,
      label: 'Unnamed',
      note: 'No template configured.',
      templates: [{ name: 'Empty template', body: null, hint: 'No body' }],
    };
  });

  routeMeta.forEach((meta) => {
    const key = toKey(meta.method, meta.path);
    if (!used.has(key)) {
      enriched.push(meta);
    }
  });

  const unique = new Map();
  enriched.forEach((item) => {
    const key = toKey(item.method, item.path);
    if (!unique.has(key)) {
      unique.set(key, { id: key, ...item });
    }
  });

  return Array.from(unique.values()).sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });
};

app.get('/api/routes', (req, res) => {
  if (!ROUTE_INSPECTOR_ENABLED) {
    res.status(404).json({ success: false, message: '接口不存在。' });
    return;
  }
  res.json({ success: true, data: buildRouteResponse(app) });
});

const adminRuntime = {
  startedAt: new Date().toISOString(),
  ws: {
    activeSockets: 0,
    activeUsers: 0,
    cleanupRuns: 0,
    prunedConnections: 0,
  },
};

app.get('/api/admin/metrics', async (req, res) => {
  if (!ADMIN_METRICS_ENABLED) {
    res.status(404).json({ success: false, message: '接口不存在。' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const refresh = String(req.query?.refresh || '').toLowerCase();
  if (refresh === '1' || refresh === 'true') {
    try {
      await forceRefreshUsersCache();
    } catch (error) {
      logger.warn('Users cache refresh failed', {
        requestId: req.requestId || '',
        error: serializeError(error),
      });
    }
  }
  const uptimeMs = Math.floor(process.uptime() * 1000);
  const memory = process.memoryUsage();
  res.json({
    success: true,
    data: {
      now: new Date().toISOString(),
      startedAt: adminRuntime.startedAt,
      uptimeMs,
      process: {
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
      },
      ws: { ...adminRuntime.ws },
      usersCache: getUsersCacheInfo(),
      metrics: metrics.snapshot(),
    },
  });
});
app.use('/api', (req, res, next) => {
  // Dynamic API responses should not be cached; cached 304 responses have no body.
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/resource', express.static(path.join(__dirname, 'resource')));
app.use(
  '/uploads/images',
  express.static(path.join(__dirname, 'data', 'images'), {
    maxAge: '7d',
    etag: true,
    immutable: true,
  })
);
app.use(
  '/uploads/userfile',
  express.static(path.join(__dirname, 'data', 'userfile'), {
    maxAge: '7d',
    etag: true,
    immutable: true,
  })
);
app.use('/admin', express.static(path.join(__dirname, 'index.html')));

app.use('/api', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/voice', voiceRouter);
app.use('/api/chat/voice', voiceTranscribeRouter);
app.use('/api/insight', insightApiRouter);
app.use('/api/admin', adminRouter);

app.use((err, req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ success: false, message: '请求体过大。' });
    return;
  }
  logger.error('Unhandled server error', {
    requestId: req.requestId || '',
    error: serializeError(err),
  });
  res.status(500).json({ success: false, message: '服务器错误。' });
});

// startServer：启动后台流程。
export function startServer(port = PORT) {
  metrics.incCounter('server_start_total', 1);
  const server = http.createServer(app);
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, HTTP_SOCKET_KEEP_ALIVE_MS);
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: false,
    clientTracking: false,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });
  const insightWorker = startInsightWorker({ logger });
  server.on('close', () => {
    insightWorker.stop();
  });
  const connections = new Map();
  let activeSockets = 0;
  const presencePayload = (uid, online) => ({
    type: 'presence',
    data: { uid, online },
  });
  const updateWsGauges = () => {
    metrics.setGauge('ws_active_sockets', activeSockets);
    metrics.setGauge('ws_connected_users', connections.size);
    adminRuntime.ws.activeSockets = activeSockets;
    adminRuntime.ws.activeUsers = connections.size;
  };
  const touchSocket = (socket) => {
    if (!socket) return;
    socket._lastSeenAt = Date.now();
  };

  const removeConnection = (uid, socket) => {
    if (socket?._tracked) {
      socket._tracked = false;
      activeSockets = Math.max(0, activeSockets - 1);
      metrics.incCounter('ws_connections_closed_total', 1);
    }
    const set = connections.get(uid);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        connections.delete(uid);
        markDisconnected(uid);
      }
    }
    updateWsGauges();
  };

  const cleanupUidConnections = (uid, { closeCode = 1001, reason = 'stale' } = {}) => {
    const set = connections.get(uid);
    if (!set || set.size === 0) return 0;
    const now = Date.now();
    let removed = 0;
    Array.from(set).forEach((socket) => {
      const notOpen = socket.readyState !== WebSocket.OPEN;
      const lastSeenAt = Number(socket?._lastSeenAt || socket?._connectedAt || 0);
      const isStale = Number.isFinite(lastSeenAt) && now - lastSeenAt > WS_CONNECTION_STALE_MS;
      if (!notOpen && !isStale) {
        return;
      }
      if (isStale && socket.readyState === WebSocket.OPEN) {
        try {
          socket.close(closeCode, 'Stale connection');
        } catch {}
      }
      removeConnection(uid, socket);
      removed += 1;
    });
    if (removed > 0) {
      metrics.incCounter('ws_connections_pruned_total', removed, { reason });
      adminRuntime.ws.prunedConnections += removed;
    }
    return removed;
  };

  const cleanupAllConnections = (reason = 'periodic') => {
    let removed = 0;
    connections.forEach((_, uid) => {
      removed += cleanupUidConnections(uid, { reason });
    });
    adminRuntime.ws.cleanupRuns += 1;
    metrics.incCounter('ws_cleanup_runs_total', 1, { reason });
    if (removed > 0) {
      logger.warn('Pruned websocket connections', { reason, removed });
    }
  };

  const wsCleanupTimer = setInterval(() => {
    cleanupAllConnections('interval');
  }, WS_CONNECTION_CLEANUP_INTERVAL_MS);
  wsCleanupTimer.unref?.();
  server.on('close', () => {
    clearInterval(wsCleanupTimer);
    cleanupAllConnections('server_close');
  });

  const enforcePerUidConnectionLimit = (uid) => {
    const set = connections.get(uid);
    if (!set || set.size <= WS_MAX_CONNECTIONS_PER_UID) return;
    const sockets = Array.from(set).sort(
      (left, right) =>
        Number(left?._connectedAt || 0) - Number(right?._connectedAt || 0)
    );
    const overflow = sockets.length - WS_MAX_CONNECTIONS_PER_UID;
    for (let i = 0; i < overflow; i += 1) {
      const oldSocket = sockets[i];
      try {
        oldSocket.close(1008, 'Too many connections');
      } catch {}
      removeConnection(uid, oldSocket);
    }
    if (overflow > 0) {
      metrics.incCounter('ws_connections_pruned_total', overflow, {
        reason: 'per_uid_limit',
      });
      adminRuntime.ws.prunedConnections += overflow;
    }
  };

  const addConnection = (uid, socket) => {
    if (!isValidUid(uid) || socket?._tracked) return;
    cleanupUidConnections(uid, { reason: 'before_add' });
    socket._tracked = true;
    socket._connectedAt = Date.now();
    touchSocket(socket);
    activeSockets += 1;
    metrics.incCounter('ws_connections_opened_total', 1);
    const set = connections.get(uid) || new Set();
    set.add(socket);
    connections.set(uid, set);
    enforcePerUidConnectionLimit(uid);
    updateWsGauges();
  };
  updateWsGauges();

  const sendToUid = (uid, payload) => {
    const set = connections.get(uid);
    if (!set) return;
    const message = JSON.stringify(payload);
    Array.from(set).forEach((socket) => {
      if (socket.readyState !== WebSocket.OPEN) {
        removeConnection(uid, socket);
        return;
      }
      if (socket.bufferedAmount > WS_MAX_BACKPRESSURE_BYTES) {
        try {
          socket.close(1013, 'Client too slow');
        } catch {}
        metrics.incCounter('ws_backpressure_disconnect_total', 1);
        removeConnection(uid, socket);
        return;
      }
      try {
        socket.send(message);
        metrics.incCounter('ws_messages_sent_total', 1, {
          type: String(payload?.type || 'unknown'),
        });
      } catch {
        metrics.incCounter('ws_send_errors_total', 1);
        removeConnection(uid, socket);
      }
    });
  };

  const closeRevokedTokenConnections = (tokenId) => {
    if (!tokenId) return;
    connections.forEach((set, uid) => {
      Array.from(set).forEach((socket) => {
        if (socket?._tokenId !== tokenId) return;
        try {
          socket.close(4001, 'Token revoked');
        } catch {}
        removeConnection(uid, socket);
        metrics.incCounter('ws_connections_revoked_total', 1);
      });
    });
  };

  const unsubscribeTokenRevocation = onTokenRevoked(({ tokenId }) => {
    closeRevokedTokenConnections(tokenId);
  });
  server.on('close', () => {
    unsubscribeTokenRevocation();
  });

  const verifyToken = async (token) => {
    if (!token) return null;
    let users = await readUsersCached();
    let found = await findUserByToken(users, token);
    if (found.touched) {
      const mutation = await mutateUsers(
        async (latestUsers) => {
          const latestFound = await findUserByToken(latestUsers, token);
          return { changed: latestFound.touched, result: latestFound };
        },
        { defaultChanged: false }
      );
      if (mutation.result) {
        found = mutation.result;
      }
    }
    if (!found.user) {
      return null;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(found.user);
    }
    return JSON.parse(JSON.stringify(found.user));
  };

  const updateUserOnlineState = async (uid, online) => {
    if (!isValidUid(uid)) return;
    const mutation = await mutateUsers(
      (users) => {
        const userIndex = users.findIndex((item) => item.uid === uid);
        if (userIndex === -1) {
          return { changed: false, result: [] };
        }
        const shouldWrite = users[userIndex].online !== online;
        if (shouldWrite) {
          users[userIndex] = {
            ...users[userIndex],
            online,
          };
        }
        const notifyUids = users
          .filter((item) => Array.isArray(item.friends) && item.friends.includes(uid))
          .map((item) => item.uid);
        return { changed: shouldWrite, result: notifyUids };
      },
      { defaultChanged: false }
    );
    if (mutation.changed) {
      metrics.incCounter('presence_state_changes_total', 1, {
        online: online ? 'true' : 'false',
      });
    }
    const notifyUids = Array.isArray(mutation.result) ? mutation.result : [];
    notifyUids.forEach((friendUid) =>
      sendToUid(friendUid, presencePayload(uid, online))
    );
  };

  const resetOnlineState = async () => {
    await mutateUsers(
      (users) => {
        let touched = false;
        users.forEach((user) => {
          if (user.online) {
            user.online = false;
            touched = true;
          }
        });
        return { changed: touched };
      },
      { defaultChanged: false }
    );
  };

  setStatusChangeHandler((uid, online) => {
    updateUserOnlineState(uid, online).catch(() => undefined);
  });
  setTimeoutHandler((uid) => {
    const set = connections.get(uid);
    if (set) {
      Array.from(set).forEach((socket) => {
        try {
          socket.close(4000, 'Heartbeat timeout');
        } catch {}
        removeConnection(uid, socket);
      });
    }
  });
  startHeartbeatMonitor();
  server.on('close', () => {
    stopHeartbeatMonitor();
  });

  const sendPresenceSnapshot = async (socket, user) => {
    try {
      const users = await readUsersCached();
      const friendSet = new Set(user.friends || []);
      const snapshot = users
        .filter((item) => friendSet.has(item.uid))
        .map((item) => ({ uid: item.uid, online: isUserOnline(item) }));
      socket.send(JSON.stringify({ type: 'presence_snapshot', data: snapshot }));
    } catch (error) {
      logger.error('Presence snapshot error', { error: serializeError(error) });
    }
  };

  wss.on('connection', async (socket, req) => {
    const cleanupSocket = () => {
      const uid = Number(socket?._uid);
      if (isValidUid(uid)) {
        removeConnection(uid, socket);
      }
    };
    socket.on('close', cleanupSocket);
    socket.on('error', cleanupSocket);
    try {
      if (activeSockets >= WS_MAX_CONNECTIONS) {
        metrics.incCounter('ws_connection_reject_total', 1, { reason: 'global_limit' });
        socket.close(1013, 'Server busy');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const tokenFromQuery = String(url.searchParams.get('token') || '').trim();
      const tokenFromCookie = extractTokenFromCookieHeader(req.headers.cookie);
      const candidateTokens = [];
      if (tokenFromQuery) {
        candidateTokens.push(tokenFromQuery);
      }
      if (tokenFromCookie && tokenFromCookie !== tokenFromQuery) {
        candidateTokens.push(tokenFromCookie);
      }
      let acceptedToken = '';
      let user = null;
      for (const candidate of candidateTokens) {
        const found = await verifyToken(candidate);
        if (found) {
          acceptedToken = candidate;
          user = found;
          break;
        }
      }
      if (!user) {
        metrics.incCounter('ws_connection_reject_total', 1, { reason: 'unauthorized' });
        socket.close(1008, 'Unauthorized');
        return;
      }
      if (!isValidUid(user.uid)) {
        metrics.incCounter('ws_connection_reject_total', 1, { reason: 'invalid_uid' });
        socket.close(1008, 'Invalid uid');
        return;
      }
      socket._user = user;
      socket._uid = user.uid;
      socket._tokenId = getTokenId(acceptedToken);
      addConnection(user.uid, socket);
      const statusChanged = touchHeartbeat(user.uid);
      if (!statusChanged) {
        updateUserOnlineState(user.uid, true).catch(() => undefined);
      }
      socket.send(JSON.stringify({ type: 'ready', uid: user.uid }));
      await sendPresenceSnapshot(socket, user);
      socket.on('message', (raw) => {
        const sendVoiceStatus = (targetUid, status, detail = '') => {
          if (socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.send(
              JSON.stringify({
                type: 'voice_signal_status',
                data: {
                  targetUid: isValidUid(targetUid) ? targetUid : null,
                  status,
                  detail,
                },
              })
            );
          } catch {}
          metrics.incCounter('ws_voice_signal_total', 1, { status });
        };
        try {
          touchSocket(socket);
          const rawSize = Buffer.isBuffer(raw)
            ? raw.length
            : Buffer.byteLength(String(raw || ''), 'utf8');
          if (rawSize > WS_MAX_MESSAGE_BYTES) {
            socket.close(1009, 'Message too large');
            return;
          }
          const text = raw?.toString?.() || '';
          const message = JSON.parse(text);
          if (message?.type === 'heartbeat') {
            touchHeartbeat(user.uid);
            return;
          }
          if (message?.type === 'presence_request') {
            sendPresenceSnapshot(socket, user).catch(() => undefined);
            return;
          }
          if (message?.type === 'voice_signal') {
            const targetUid = Number(message?.data?.targetUid);
            if (!isValidUid(targetUid) || targetUid === user.uid) {
              sendVoiceStatus(targetUid, 'invalid_target');
              return;
            }
            if (!Array.isArray(user.friends) || !user.friends.includes(targetUid)) {
              sendVoiceStatus(targetUid, 'not_friend');
              return;
            }
            const signal = message?.data?.signal;
            const signalType = typeof signal;
            const signalBytes = estimatePayloadBytes(signal);
            if (
              signal == null ||
              (signalType !== 'string' && signalType !== 'object') ||
              signalBytes <= 0 ||
              signalBytes > WS_MAX_SIGNAL_BYTES
            ) {
              sendVoiceStatus(targetUid, 'invalid_signal');
              return;
            }
            cleanupUidConnections(targetUid, { reason: 'before_voice_signal' });
            const targetConnections = connections.get(targetUid);
            if (!targetConnections || targetConnections.size === 0) {
              sendVoiceStatus(targetUid, 'offline');
              return;
            }
            sendToUid(targetUid, {
              type: 'voice_signal',
              data: { fromUid: user.uid, signal },
            });
            sendVoiceStatus(targetUid, 'sent');
            return;
          }
        } catch (error) {
          metrics.incCounter('ws_message_error_total', 1);
          logger.warn('WebSocket message handling error', {
            uid: user.uid,
            error: serializeError(error),
          });
        }
      });
    } catch (error) {
      metrics.incCounter('ws_connection_error_total', 1);
      logger.error('WebSocket connection handler error', {
        error: serializeError(error),
      });
      socket.close(1011, 'Server error');
    }
  });

  setChatNotifier((entry) => {
    const payload = { type: 'chat', data: entry };
    metrics.incCounter('chat_notifier_events_total', 1, {
      targetType: String(entry?.targetType || 'unknown'),
    });
    if (entry.targetType === 'private') {
      sendToUid(entry.senderUid, payload);
      sendToUid(entry.targetUid, payload);
      return;
    }
    if (entry.targetType === 'group') {
      getGroupMemberUids(entry.targetUid)
        .then((memberUids) => {
          const set = new Set(memberUids);
          if (entry.senderUid) {
            set.add(entry.senderUid);
          }
          set.forEach((uid) => sendToUid(uid, payload));
        })
        .catch((error) => {
          logger.warn('Group chat notifier failed', { error: serializeError(error) });
        });
    }
  });
  setFriendsNotifier((uids, payload) => {
    uids.forEach((uid) => sendToUid(uid, payload));
  });
  setGroupsNotifier((uids, payload) => {
    const message = { type: 'groups', data: payload || {} };
    uids.forEach((uid) => sendToUid(uid, message));
  });

  return server.listen(
    { port, host: '0.0.0.0', backlog: HTTP_LISTEN_BACKLOG },
    async () => {
      await Promise.all([ensureStorage(), ensureChatStorage(), ensureGroupStorage()]);
      await resetOnlineState();
      (async () => {
        try {
          const users = await readUsers();
          await prewarmWarmTipCache({ users, logger });
        } catch (error) {
          logger.warn('[warm-tip] prewarm failed', {
            error: error instanceof Error ? error.message : String(error || ''),
          });
        }
      })();
      logger.info('Backend listening', {
        host: '0.0.0.0',
        port,
        adminMetricsEnabled: ADMIN_METRICS_ENABLED,
      });
    }
  );
}

const entryHref = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  startServer();
}
