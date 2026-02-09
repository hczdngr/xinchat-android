import { findUserByToken, readUsers, writeUsers } from './auth.js';

const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || 'xinchat_token').trim() || 'xinchat_token';

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

const extractTokenFromCookie = (req) => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  return String(cookies[AUTH_COOKIE_NAME] || '').trim();
};

export const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookieToken = extractTokenFromCookie(req);
  if (cookieToken) return cookieToken;
  return req.body?.token || req.query?.token || '';
};

export const createAuthenticateMiddleware = ({ scope = 'Auth' } = {}) =>
  async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ success: false, message: '缺少登录令牌。' });
        return;
      }

      const users = await readUsers();
      const found = await findUserByToken(users, token);
      if (found.touched) {
        await writeUsers(users);
      }
      if (!found.user) {
        res.status(401).json({
          success: false,
          message: found.revoked ? '登录令牌已被吊销。' : '登录令牌无效。',
        });
        return;
      }

      req.auth = { user: found.user, userIndex: found.userIndex, users };
      next();
    } catch (error) {
      console.error(`${scope} authenticate error:`, error);
      res.status(500).json({ success: false, message: '服务器错误。' });
    }
  };

