import express from 'express';
import { findUserByToken, readUsers, writeUsers } from './auth.js';

const router = express.Router();
const MAX_DOMAIN_LEN = 253;

const isMutualFriend = (user, target) =>
  Boolean(
    user &&
      target &&
      Array.isArray(user.friends) &&
      Array.isArray(target.friends) &&
      user.friends.includes(target.uid) &&
      target.friends.includes(user.uid)
  );

const isValidDomain = (value) => {
  if (!value) return true;
  if (value.length > MAX_DOMAIN_LEN) return false;
  const match = value.match(/^(?<host>[a-zA-Z0-9.-]+)(?::(?<port>\d{1,5}))?$/);
  if (!match || !match.groups) return false;
  const host = match.groups.host;
  if (!host || host.startsWith('.') || host.endsWith('.')) return false;
  const labels = host.split('.');
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-zA-Z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    return false;
  }
  if (match.groups.port) {
    const port = Number(match.groups.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return false;
    }
  }
  return true;
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
    console.error('Voice authenticate error:', error);
    res.status(500).json({ success: false, message: '服务器错误。' });
  }
};

const toDirectoryEntry = (user) => ({
  uid: user.uid,
  username: user.username,
  domain: user.domain || '',
  online: user.online === true,
});

router.get('/directory', authenticate, async (req, res) => {
  try {
    const { users, user } = req.auth;
    const data = users
      .filter((item) => item.uid === user.uid || isMutualFriend(user, item))
      .map(toDirectoryEntry);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Voice directory error:', error);
    res.status(500).json({ success: false, message: '获取语音通讯录失败。' });
  }
});

router.get('/contact', authenticate, async (req, res) => {
  try {
    const uid = Number(req.query.uid || req.body?.uid);
    if (!Number.isInteger(uid)) {
      res.status(400).json({ success: false, message: '用户编号无效。' });
      return;
    }
    const { users, user } = req.auth;
    const target = users.find((item) => item.uid === uid);
    if (!target) {
      res.status(404).json({ success: false, message: '目标用户不存在。' });
      return;
    }
    if (target.uid !== user.uid && !isMutualFriend(user, target)) {
      res.status(403).json({ success: false, message: '无权访问该联系人。' });
      return;
    }
    res.json({ success: true, data: toDirectoryEntry(target) });
  } catch (error) {
    console.error('Voice contact error:', error);
    res.status(500).json({ success: false, message: '获取语音联系人失败。' });
  }
});

router.post('/domain', authenticate, async (req, res) => {
  try {
    const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
    if (!isValidDomain(domain)) {
      res.status(400).json({ success: false, message: '语音域名格式无效。' });
      return;
    }
    const { users, userIndex, user } = req.auth;
    if (userIndex == null || !users[userIndex]) {
      res.status(404).json({ success: false, message: '用户不存在。' });
      return;
    }
    users[userIndex] = {
      ...users[userIndex],
      domain,
    };
    await writeUsers(users);
    res.json({ success: true, data: { uid: user.uid, domain } });
  } catch (error) {
    console.error('Voice domain error:', error);
    res.status(500).json({ success: false, message: '更新语音域名失败。' });
  }
});

export default router;


