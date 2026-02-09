import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import authRouter, {
  ensureStorage,
  findUserByToken,
  readUsersCached,
  readUsers,
  writeUsers,
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
import { startInsightWorker } from './routes/insight.js';
import {
  markDisconnected,
  isUserOnline,
  setStatusChangeHandler,
  setTimeoutHandler,
  startHeartbeatMonitor,
  touchHeartbeat,
} from './online.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROUTE_INSPECTOR_ENABLED =
  NODE_ENV !== 'production' || process.env.ENABLE_ROUTE_INSPECTOR === 'true';
const parsePositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
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
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = NODE_ENV !== 'production' && CORS_ALLOWED_ORIGINS.length === 0;

export const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
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
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (CORS_ALLOWED_ORIGINS.length > 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else if (CORS_ALLOW_ALL) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  const requestHeaders = req.headers['access-control-request-headers'];
  if (requestHeaders) {
    res.setHeader('Access-Control-Allow-Headers', requestHeaders);
  } else {
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-File-Ext, X-File-Hash, X-File-Name, X-File-Type'
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
    path: '/api/routes',
    label: 'Routes',
    note: 'List backend routes and templates.',
    templates: [{ name: 'List routes', body: null, hint: 'No body' }],
  },
];

const normalizePath = (value) => {
  if (!value) return '';
  let result = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (result !== '/' && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

const joinPath = (base, next) => {
  const left = normalizePath(base);
  const right = normalizePath(next);
  const combined = normalizePath(`${left}${right}`);
  return combined || '/';
};

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

app.use((err, req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ success: false, message: '请求体过大。' });
    return;
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, message: '服务器错误。' });
});

export function startServer(port = PORT) {
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
  const insightWorker = startInsightWorker({ logger: console });
  server.on('close', () => {
    insightWorker.stop();
  });
  const connections = new Map();
  let activeSockets = 0;
  const presencePayload = (uid, online) => ({
    type: 'presence',
    data: { uid, online },
  });

  const addConnection = (uid, socket) => {
    if (socket._tracked) return;
    socket._tracked = true;
    activeSockets += 1;
    const set = connections.get(uid) || new Set();
    set.add(socket);
    connections.set(uid, set);
  };

  const removeConnection = (uid, socket) => {
    if (socket?._tracked) {
      socket._tracked = false;
      activeSockets = Math.max(0, activeSockets - 1);
    }
    const set = connections.get(uid);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      connections.delete(uid);
      markDisconnected(uid);
    }
  };

  const sendToUid = (uid, payload) => {
    const set = connections.get(uid);
    if (!set) return;
    const message = JSON.stringify(payload);
    set.forEach((socket) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (socket.bufferedAmount > WS_MAX_BACKPRESSURE_BYTES) {
        try {
          socket.close(1013, 'Client too slow');
        } catch {}
        removeConnection(uid, socket);
        return;
      }
      try {
        socket.send(message);
      } catch {
        removeConnection(uid, socket);
      }
    });
  };

  const verifyToken = async (token) => {
    if (!token) return null;
    const users = await readUsersCached();
    const found = findUserByToken(users, token);
    if (found.touched) {
      await writeUsers(users);
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
    const users = await readUsersCached();
    const userIndex = users.findIndex((item) => item.uid === uid);
    if (userIndex === -1) return;
    const shouldWrite = users[userIndex].online !== online;
    if (shouldWrite) {
      users[userIndex] = {
        ...users[userIndex],
        online,
      };
      await writeUsers(users);
    }
    const notifyUids = users
      .filter((item) => Array.isArray(item.friends) && item.friends.includes(uid))
      .map((item) => item.uid);
    notifyUids.forEach((friendUid) =>
      sendToUid(friendUid, presencePayload(uid, online))
    );
  };

  const resetOnlineState = async () => {
    const users = await readUsers();
    let touched = false;
    users.forEach((user) => {
      if (user.online) {
        user.online = false;
        touched = true;
      }
    });
    if (touched) {
      await writeUsers(users);
    }
  };

  setStatusChangeHandler((uid, online) => {
    updateUserOnlineState(uid, online).catch(() => undefined);
  });
  setTimeoutHandler((uid) => {
    const set = connections.get(uid);
    if (set) {
      set.forEach((socket) => {
        try {
          socket.close(4000, 'Heartbeat timeout');
        } catch {}
      });
      connections.delete(uid);
    }
  });
  startHeartbeatMonitor();

  const sendPresenceSnapshot = async (socket, user) => {
    try {
      const users = await readUsersCached();
      const friendSet = new Set(user.friends || []);
      const snapshot = users
        .filter((item) => friendSet.has(item.uid))
        .map((item) => ({ uid: item.uid, online: isUserOnline(item) }));
      socket.send(JSON.stringify({ type: 'presence_snapshot', data: snapshot }));
    } catch (error) {
      console.error('Presence snapshot error:', error);
    }
  };

  wss.on('connection', async (socket, req) => {
    const cleanupSocket = () => {
      const uid = Number(socket?._uid);
      if (Number.isInteger(uid) && uid > 0) {
        removeConnection(uid, socket);
      }
    };
    socket.on('close', cleanupSocket);
    socket.on('error', cleanupSocket);
    try {
      if (activeSockets >= WS_MAX_CONNECTIONS) {
        socket.close(1013, 'Server busy');
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token') || '';
      const user = await verifyToken(token);
      if (!user) {
        socket.close(1008, 'Unauthorized');
        return;
      }
      socket._user = user;
      socket._uid = user.uid;
      addConnection(user.uid, socket);
      const statusChanged = touchHeartbeat(user.uid);
      if (!statusChanged) {
        updateUserOnlineState(user.uid, true).catch(() => undefined);
      }
      socket.send(JSON.stringify({ type: 'ready', uid: user.uid }));
      await sendPresenceSnapshot(socket, user);
      socket.on('message', (raw) => {
        try {
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
            if (!Number.isInteger(targetUid)) return;
            if (!Array.isArray(user.friends) || !user.friends.includes(targetUid)) {
              socket.send(
                JSON.stringify({
                  type: 'voice_signal_status',
                  data: { targetUid, status: 'not_friend' },
                })
              );
              return;
            }
            const signal = message?.data?.signal || null;
            if (!signal) return;
            const targetConnections = connections.get(targetUid);
            if (!targetConnections || targetConnections.size === 0) {
              socket.send(
                JSON.stringify({
                  type: 'voice_signal_status',
                  data: { targetUid, status: 'offline' },
                })
              );
              return;
            }
            sendToUid(targetUid, {
              type: 'voice_signal',
              data: { fromUid: user.uid, signal },
            });
            socket.send(
              JSON.stringify({
                type: 'voice_signal_status',
                data: { targetUid, status: 'sent' },
              })
            );
            return;
          }
        } catch {}
      });
    } catch {
      socket.close(1011, 'Server error');
    }
  });

  setChatNotifier((entry) => {
    const payload = { type: 'chat', data: entry };
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
        .catch(() => undefined);
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
          await prewarmWarmTipCache({ users, logger: console });
        } catch (error) {
          console.warn(
            '[warm-tip] prewarm failed',
            error instanceof Error ? error.message : error
          );
        }
      })();
      console.log(`Backend listening on http://0.0.0.0:${port}`);
    }
  );
}

const entryHref = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  startServer();
}
