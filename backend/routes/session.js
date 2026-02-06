import { findUserByToken, readUsers, writeUsers } from './auth.js';

export const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
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
      console.error(`${scope} authenticate error:`, error);
      res.status(500).json({ success: false, message: '服务器错误。' });
    }
  };
