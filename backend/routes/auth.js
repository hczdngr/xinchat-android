import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const USERS_PATH_TMP = path.join(DATA_DIR, 'users.json.tmp');
const UID_START = 100000000;
const TOKEN_TTL_DAYS = 181;

const router = express.Router();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const loginAttempts = new Map();
const DEFAULT_SIGNATURE =
  '\u8fd9\u4e2a\u4eba\u5f88\u795e\u79d8\uff0c\u6682\u672a\u586b\u5199\u7b7e\u540d';
const MAX_NICKNAME_LEN = 36;
const MAX_SIGNATURE_LEN = 80;
const MAX_AVATAR_BYTES = 20 * 1024 * 1024;

const normalizeUsername = (value) => value.trim().toLowerCase();

const estimateBase64Bytes = (value) => {
  const commaIndex = value.indexOf(',');
  if (commaIndex === -1) return 0;
  const base64 = value.slice(commaIndex + 1).trim();
  if (!base64) return 0;
  let padding = 0;
  if (base64.endsWith('==')) {
    padding = 2;
  } else if (base64.endsWith('=')) {
    padding = 1;
  }
  return Math.floor(base64.length * 0.75) - padding;
};

const normalizeAvatar = (value, baseUrl = '') => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith('/uploads/images/')) {
      return trimmed;
    }
    if (baseUrl && trimmed.startsWith(`${baseUrl}/uploads/images/`)) {
      return trimmed;
    }
    return null;
  }
  const size = estimateBase64Bytes(trimmed);
  if (!size || size > MAX_AVATAR_BYTES) {
    return null;
  }
  return trimmed;
};

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return req.body?.token || req.query?.token || '';
};

const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ success: false, message: '缺少登录令牌。' });
      return;
    }

    const users = await readUsers();
    const found = findUserByToken(users, token);
    if (found.touched) {
      await writeUsers(users);
    }
    if (!found.user) {
      res.status(401).json({ success: false, message: '登录令牌无效。' });
      return;
    }

    req.auth = { user: found.user, userIndex: found.userIndex, users };
    next();
  } catch (error) {
    console.error('Authenticate error:', error);
    res.status(500).json({ success: false, message: '服务器错误。' });
  }
};

const clearUserSession = async (users, userIndex) => {
  users[userIndex] = {
    ...users[userIndex],
    online: false,
  };
  await writeUsers(users);
};

const USERS_CACHE_TTL_MS = 1000;
let cachedUsers = null;
let cachedUsersAt = 0;
let writeUsersQueue = Promise.resolve();

const cloneUsers = (users) => JSON.parse(JSON.stringify(users || []));

const ensureStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_PATH);
  } catch {
    await fs.writeFile(USERS_PATH, '[]', 'utf-8');
  }
};

const readUsers = async () => {
  await ensureStorage();
  const now = Date.now();
  if (cachedUsers && now - cachedUsersAt < USERS_CACHE_TTL_MS) {
    return cloneUsers(cachedUsers);
  }
  const raw = await fs.readFile(USERS_PATH, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) {
    cachedUsers = [];
    cachedUsersAt = now;
    return cloneUsers(cachedUsers);
  }
  let users;
  try {
    users = JSON.parse(trimmed);
  } catch (error) {
    const backupPath = `${USERS_PATH}.corrupt-${Date.now()}`;
    await fs.writeFile(backupPath, raw, 'utf-8');
    await fs.writeFile(USERS_PATH, '[]', 'utf-8');
    console.error(
      `Failed to parse users.json. Backup created at ${backupPath}.`,
      error
    );
    cachedUsers = [];
    cachedUsersAt = now;
    return cloneUsers(cachedUsers);
  }
  if (!Array.isArray(users)) {
    console.error('Invalid users.json format. Resetting to empty array.');
    await fs.writeFile(USERS_PATH, '[]', 'utf-8');
    cachedUsers = [];
    cachedUsersAt = now;
    return cloneUsers(cachedUsers);
  }
  await ensureUserUids(users);
  await ensureUserDefaults(users);
  cachedUsers = cloneUsers(users);
  cachedUsersAt = now;
  return cloneUsers(cachedUsers);
};

const writeUsers = async (users) => {
  await ensureStorage();
  const snapshot = cloneUsers(users);
  const run = writeUsersQueue.then(async () => {
    await fs.writeFile(USERS_PATH_TMP, JSON.stringify(snapshot, null, 2), 'utf-8');
    await fs.rename(USERS_PATH_TMP, USERS_PATH);
    cachedUsers = cloneUsers(snapshot);
    cachedUsersAt = Date.now();
  });
  writeUsersQueue = run.catch(() => {});
  await run;
};

const ensureUserUids = async (users) => {
  let maxUid = UID_START - 1;
  users.forEach((user) => {
    if (Number.isInteger(user.uid)) {
      maxUid = Math.max(maxUid, user.uid);
    }
  });

  let nextUid = Math.max(maxUid + 1, UID_START);
  let updated = false;
  users.forEach((user) => {
    if (!Number.isInteger(user.uid)) {
      user.uid = nextUid++;
      updated = true;
    }
  });

  if (updated) {
    await writeUsers(users);
  }
};

const ensureUserDefaults = async (users) => {
  let updated = false;
  users.forEach((user) => {
    if (!Array.isArray(user.friends)) {
      user.friends = [];
      updated = true;
    }
    if (typeof user.signature !== 'string') {
      user.signature = DEFAULT_SIGNATURE;
      updated = true;
    }
    if (typeof user.avatar !== 'string') {
      user.avatar = '';
      updated = true;
    }
    if (typeof user.online !== 'boolean') {
      user.online = false;
      updated = true;
    }
    if (!Array.isArray(user.tokens)) {
      user.tokens = [];
      updated = true;
    }
    if (user.token && user.tokenExpiresAt) {
      const exists = user.tokens.some((entry) => entry?.token === user.token);
      if (!exists) {
        user.tokens.push({ token: user.token, expiresAt: user.tokenExpiresAt });
        updated = true;
      }
    }
    if (Array.isArray(user.tokens)) {
      const nextTokens = user.tokens.filter(
        (entry) =>
          entry &&
          typeof entry.token === 'string' &&
          entry.token &&
          typeof entry.expiresAt === 'string' &&
          !isTokenExpired(entry.expiresAt)
      );
      if (nextTokens.length !== user.tokens.length) {
        user.tokens = nextTokens;
        updated = true;
      }
    }
    if (user.token && isTokenExpired(user.tokenExpiresAt)) {
      user.token = null;
      user.tokenExpiresAt = null;
      updated = true;
    }
    if (typeof user.nickname !== 'string') {
      user.nickname = user.username || '';
      updated = true;
    }
    if (typeof user.gender !== 'string') {
      user.gender = '';
      updated = true;
    }
    if (typeof user.birthday !== 'string') {
      user.birthday = '';
      updated = true;
    }
    if (typeof user.country !== 'string') {
      user.country = '';
      updated = true;
    }
    if (typeof user.province !== 'string') {
      user.province = '';
      updated = true;
    }
    if (typeof user.region !== 'string') {
      user.region = '';
      updated = true;
    }
    if (!user.friendRequests || typeof user.friendRequests !== 'object') {
      user.friendRequests = { incoming: [], outgoing: [] };
      updated = true;
      return;
    }
    if (!Array.isArray(user.friendRequests.incoming)) {
      user.friendRequests.incoming = [];
      updated = true;
    }
    if (!Array.isArray(user.friendRequests.outgoing)) {
      user.friendRequests.outgoing = [];
      updated = true;
    }
  });

  if (updated) {
    await writeUsers(users);
  }
};

const getNextUid = (users) => {
  let maxUid = UID_START - 1;
  users.forEach((user) => {
    if (Number.isInteger(user.uid)) {
      maxUid = Math.max(maxUid, user.uid);
    }
  });
  return Math.max(maxUid + 1, UID_START);
};

const issueToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  return { token, expiresAt };
};

const isTokenExpired = (expiresAt) => {
  const ts = expiresAt ? Date.parse(expiresAt) : 0;
  if (!ts || Number.isNaN(ts)) return true;
  return Date.now() > ts;
};

const removeTokenFromUser = (user, token) => {
  if (!user || !token) return false;
  let changed = false;
  if (Array.isArray(user.tokens)) {
    const next = user.tokens.filter((entry) => entry?.token !== token);
    if (next.length !== user.tokens.length) {
      user.tokens = next;
      changed = true;
    }
  }
  if (user.token === token) {
    user.token = null;
    user.tokenExpiresAt = null;
    changed = true;
  }
  return changed;
};

const findUserByToken = (users, token) => {
  if (!token) return { user: null, userIndex: -1, touched: false };
  let touched = false;
  for (let i = 0; i < users.length; i += 1) {
    const user = users[i];
    const tokens = Array.isArray(user.tokens) ? user.tokens : [];
    const entry = tokens.find((item) => item?.token === token);
    if (entry) {
      if (isTokenExpired(entry.expiresAt)) {
        if (removeTokenFromUser(user, token)) {
          touched = true;
        }
        return { user: null, userIndex: -1, touched };
      }
      return { user, userIndex: i, touched };
    }
    if (user.token === token) {
      if (isTokenExpired(user.tokenExpiresAt)) {
        if (removeTokenFromUser(user, token)) {
          touched = true;
        }
        return { user: null, userIndex: -1, touched };
      }
      return { user, userIndex: i, touched };
    }
  }
  return { user: null, userIndex: -1, touched };
};

const hasValidToken = (user) => {
  if (!user) return false;
  const tokens = Array.isArray(user.tokens) ? user.tokens : [];
  if (tokens.some((entry) => entry?.token && !isTokenExpired(entry.expiresAt))) {
    return true;
  }
  if (user.token && !isTokenExpired(user.tokenExpiresAt)) {
    return true;
  }
  return false;
};

const pbkdf2Async = (password, salt, iterations, keylen, digest) =>
  new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });

const hashPassword = async (password, salt = crypto.randomBytes(16)) => {
  const iterations = 120000;
  const keylen = 64;
  const digest = 'sha512';
  const hash = await pbkdf2Async(password, salt, iterations, keylen, digest);
  return {
    passwordHash: hash.toString('hex'),
    salt: salt.toString('hex'),
    iterations,
    keylen,
    digest,
  };
};

const verifyPassword = async (password, user) => {
  if (!user.passwordHash || !user.salt) {
    return false;
  }
  const hash = await pbkdf2Async(
    password,
    Buffer.from(user.salt, 'hex'),
    user.iterations || 120000,
    user.keylen || 64,
    user.digest || 'sha512'
  );
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (stored.length !== hash.length) {
    return false;
  }
  return crypto.timingSafeEqual(stored, hash);
};

const recordLoginAttempt = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now });
    return;
  }
  loginAttempts.set(key, { ...entry, count: entry.count + 1 });
};

const clearLoginAttempts = (key) => {
  loginAttempts.delete(key);
};

const isLockedOut = (key) => {
  const entry = loginAttempts.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
};

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
      res.status(400).json({
        success: false,
        message: '用户名长度需在 3-32 个字符之间。',
      });
      return;
    }

    const users = await readUsers();
    const normalized = normalizeUsername(trimmedUsername);
    if (users.some((user) => user.username === normalized)) {
      res.status(409).json({ success: false, message: '用户名已存在。' });
      return;
    }

    const hashed = await hashPassword(password);
    const uid = getNextUid(users);
    users.push({
      uid,
      username: normalized,
      ...hashed,
      createdAt: new Date().toISOString(),
      friends: [],
      signature: DEFAULT_SIGNATURE,
      avatar: '',
      nickname: trimmedUsername,
      gender: '',
      birthday: '',
      country: '',
      province: '',
      region: '',
    });
    await writeUsers(users);
    res.json({ success: true, message: '注册成功，请登录。' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: '注册失败，请稍后重试。' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      res.status(400).json({ success: false, message: '请输入用户名和密码。' });
      return;
    }

    const normalized = normalizeUsername(trimmedUsername);
    const lockKey = `${req.ip}-${normalized}`;
    if (isLockedOut(lockKey)) {
      res.status(429).json({
        success: false,
        message: '尝试次数过多，请稍后再试。',
      });
      return;
    }

    const users = await readUsers();
    const userIndex = users.findIndex((user) => user.username === normalized);
    const user = users[userIndex];
    const isLegacy = user && user.password;
    const isMatch = user
      ? isLegacy
        ? user.password === password
        : await verifyPassword(password, user)
      : false;

    if (!isMatch) {
      recordLoginAttempt(lockKey);
      res.status(401).json({ success: false, message: '用户名或密码错误。' });
      return;
    }

    clearLoginAttempts(lockKey);

    if (isLegacy) {
      const hashed = await hashPassword(password);
      users[userIndex] = {
        uid: user.uid,
        username: normalized,
        ...hashed,
        createdAt: user.createdAt || new Date().toISOString(),
        friends: Array.isArray(user.friends) ? user.friends : [],
        signature: typeof user.signature === 'string' ? user.signature : '',
        nickname: typeof user.nickname === 'string' ? user.nickname : normalized,
        gender: typeof user.gender === 'string' ? user.gender : '',
        birthday: typeof user.birthday === 'string' ? user.birthday : '',
        country: typeof user.country === 'string' ? user.country : '',
        province: typeof user.province === 'string' ? user.province : '',
        region: typeof user.region === 'string' ? user.region : '',
        migratedAt: new Date().toISOString(),
      };
      await writeUsers(users);
    }

    const { token, expiresAt } = issueToken();
    const existingTokens = Array.isArray(users[userIndex].tokens)
      ? users[userIndex].tokens.filter((entry) => entry?.token !== token)
      : [];
    existingTokens.push({ token, expiresAt });
    users[userIndex] = {
      ...users[userIndex],
      token,
      tokenExpiresAt: expiresAt,
      tokens: existingTokens,
      lastLoginAt: new Date().toISOString(),
      online: false,
    };
    await writeUsers(users);

    res.json({
      success: true,
      message: '登录成功。',
      token,
      tokenExpiresAt: expiresAt,
      uid: users[userIndex].uid,
      username: users[userIndex].username,
      avatar: users[userIndex].avatar || '',
      nickname: users[userIndex].nickname || users[userIndex].username,
      signature: users[userIndex].signature || '',
      gender: users[userIndex].gender || '',
      birthday: users[userIndex].birthday || '',
      country: users[userIndex].country || '',
      province: users[userIndex].province || '',
      region: users[userIndex].region || '',
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: '登录失败，请稍后重试。' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  const token = extractToken(req);
  const { users, userIndex } = req.auth;
  if (token) {
    const updated = removeTokenFromUser(users[userIndex], token);
    if (updated) {
      await writeUsers(users);
    }
  }
  await clearUserSession(users, userIndex);
  res.json({ success: true });
});

router.get('/profile', authenticate, async (req, res) => {
  const { user } = req.auth;
  res.json({
    success: true,
    user: {
      uid: user.uid,
      username: user.username,
      nickname: user.nickname || user.username,
      signature: user.signature || DEFAULT_SIGNATURE,
      gender: user.gender || '',
      birthday: user.birthday || '',
      country: user.country || '',
      province: user.province || '',
      region: user.region || '',
      avatar: user.avatar || '',
    },
  });
});

router.post('/profile', authenticate, async (req, res) => {
  const { users, userIndex } = req.auth;
  const payload = req.body || {};
  const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  const gender = typeof payload.gender === 'string' ? payload.gender.trim() : '';
  const birthday = typeof payload.birthday === 'string' ? payload.birthday.trim() : '';
  const country = typeof payload.country === 'string' ? payload.country.trim() : '';
  const province = typeof payload.province === 'string' ? payload.province.trim() : '';
  const region = typeof payload.region === 'string' ? payload.region.trim() : '';
  let avatar = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'avatar')) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    avatar = normalizeAvatar(payload.avatar, baseUrl);
    if (avatar === null) {
      res.status(400).json({ success: false, message: '头像格式无效。' });
      return;
    }
  }

  if (nickname.length > MAX_NICKNAME_LEN) {
    res.status(400).json({
      success: false,
      message: '\u6635\u79f0\u957f\u5ea6\u8fc7\u957f\u3002',
    });
    return;
  }
  if (signature.length > MAX_SIGNATURE_LEN) {
    res.status(400).json({
      success: false,
      message: '\u4e2a\u7b7e\u957f\u5ea6\u8fc7\u957f\u3002',
    });
    return;
  }

  const nextUser = {
    ...users[userIndex],
    nickname: nickname || users[userIndex].nickname || users[userIndex].username,
    signature: signature || DEFAULT_SIGNATURE,
    gender,
    birthday,
    country,
    province,
    region,
  };
  if (avatar !== null) {
    nextUser.avatar = avatar;
  }
  users[userIndex] = nextUser;
  await writeUsers(users);

  res.json({
    success: true,
    user: {
      uid: users[userIndex].uid,
      username: users[userIndex].username,
      nickname: users[userIndex].nickname || users[userIndex].username,
      signature: users[userIndex].signature || DEFAULT_SIGNATURE,
      gender: users[userIndex].gender || '',
      birthday: users[userIndex].birthday || '',
      country: users[userIndex].country || '',
      province: users[userIndex].province || '',
      region: users[userIndex].region || '',
      avatar: users[userIndex].avatar || '',
    },
  });
});

export { ensureStorage, readUsers, writeUsers, findUserByToken, hasValidToken };
export default router;









