import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import authRouter, {
  ensureStorage,
  findUserByToken,
  readUsers,
  writeUsers,
} from './routes/auth.js';
import chatRouter, { ensureChatStorage, setChatNotifier } from './routes/chat.js';
import friendsRouter, { setFriendsNotifier } from './routes/friends.js';
import groupsRouter, { ensureGroupStorage, getGroupMemberUids } from './routes/groups.js';
import voiceRouter from './routes/voice.js';
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
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = NODE_ENV !== 'production' && CORS_ALLOWED_ORIGINS.length === 0;

export const app = express();

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
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
  const wss = new WebSocketServer({ server, path: '/ws' });
  const insightWorker = startInsightWorker({ logger: console });
  server.on('close', () => {
    insightWorker.stop();
  });
  const connections = new Map();
  const presencePayload = (uid, online) => ({
    type: 'presence',
    data: { uid, online },
  });

  const addConnection = (uid, socket) => {
    const set = connections.get(uid) || new Set();
    set.add(socket);
    connections.set(uid, set);
  };

  const removeConnection = (uid, socket) => {
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
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    });
  };

  const verifyToken = async (token) => {
    if (!token) return null;
    const users = await readUsers();
    const found = findUserByToken(users, token);
    if (found.touched) {
      await writeUsers(users);
    }
    return found.user || null;
  };

  const updateUserOnlineState = async (uid, online) => {
    const users = await readUsers();
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
      const users = await readUsers();
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
    try {
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
      socket.on('close', () => removeConnection(user.uid, socket));
      socket.on('error', () => removeConnection(user.uid, socket));
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

  return server.listen(port, '0.0.0.0', async () => {
    await Promise.all([ensureStorage(), ensureChatStorage(), ensureGroupStorage()]);
    await resetOnlineState();
    console.log(`Backend listening on http://0.0.0.0:${port}`);
  });
}

const entryHref = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  startServer();
}
