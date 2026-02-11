/**
 * 模块说明：会话中间件模块：统一提取 token 并校验登录态。
 */


import { findUserByToken, mutateUsers, readUsers } from './auth.js';

const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || 'xinchat_token').trim() || 'xinchat_token';
// isPlainObject：判断条件是否成立。
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// toPlainObject?处理 toPlainObject 相关逻辑。
const toPlainObject = (value) => (isPlainObject(value) ? value : {});
// toTokenString?处理 toTokenString 相关逻辑。
const toTokenString = (value) => (typeof value === 'string' ? value.trim() : '');

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

// extractTokenFromCookie：提取请求中的关键信息。
const extractTokenFromCookie = (req) => {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  return String(cookies[AUTH_COOKIE_NAME] || '').trim();
};

export const extractToken = (req) => {
  const header = String(req?.headers?.authorization || '').trim();
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookieToken = extractTokenFromCookie(req);
  if (cookieToken) return cookieToken;
  const bodyToken = toTokenString(toPlainObject(req?.body).token);
  if (bodyToken) return bodyToken;
  return toTokenString(toPlainObject(req?.query).token);
};

export const createAuthenticateMiddleware = ({ scope = 'Auth' } = {}) =>
  async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (!token) {
        res.status(401).json({ success: false, message: '缺少登录令牌。' });
        return;
      }

      let users = await readUsers();
      let found = await findUserByToken(users, token);
      if (found.touched) {
        const mutation = await mutateUsers(
          async (latestUsers) => {
            const latestFound = await findUserByToken(latestUsers, token);
            return {
              changed: latestFound.touched,
              result: { users: latestUsers, found: latestFound },
            };
          },
          { defaultChanged: false }
        );
        if (mutation.result) {
          users = mutation.result.users;
          found = mutation.result.found;
        }
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

