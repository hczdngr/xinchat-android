import express from 'express';
import { mutateUsers } from './auth.js';
import { createAuthenticateMiddleware } from './session.js';

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

const authenticate = createAuthenticateMiddleware({ scope: 'Voice' });

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
    if (!Number.isInteger(uid) || uid <= 0) {
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

    const { user } = req.auth;
    const mutation = await mutateUsers(
      (users) => {
        const userIndex = users.findIndex((item) => item.uid === user.uid);
        if (userIndex < 0) {
          return { changed: false, result: null };
        }
        const previousDomain =
          typeof users[userIndex].domain === 'string' ? users[userIndex].domain : '';
        if (previousDomain === domain) {
          return {
            changed: false,
            result: { uid: users[userIndex].uid, domain: previousDomain },
          };
        }
        users[userIndex] = {
          ...users[userIndex],
          domain,
        };
        return { changed: true, result: { uid: users[userIndex].uid, domain } };
      },
      { defaultChanged: false }
    );

    if (!mutation.result) {
      res.status(404).json({ success: false, message: '用户不存在。' });
      return;
    }

    res.json({ success: true, data: mutation.result });
  } catch (error) {
    console.error('Voice domain error:', error);
    res.status(500).json({ success: false, message: '更新语音域名失败。' });
  }
});

export default router;