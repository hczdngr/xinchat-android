/**
 * 模块说明：好友路由模块：处理好友关系与好友请求流程。
 */


import express from 'express';
import { hasValidToken, mutateUsers } from './auth.js';
import { isUserOnline as isOnline } from '../online.js';
import { createAuthenticateMiddleware } from './session.js';

const router = express.Router();

// normalizeUsername：归一化外部输入。
const normalizeUsername = (value) => value.trim().toLowerCase();
const REQUEST_STATUS_PENDING = 'pending';
const REQUEST_STATUS_REJECTED = 'rejected';
const MAX_UID = Number.parseInt(String(process.env.MAX_UID || '2147483647'), 10);
const SAFE_MAX_UID = Number.isInteger(MAX_UID) && MAX_UID > 0 ? MAX_UID : 2147483647;
// isValidUid：判断条件是否成立。
const isValidUid = (value) => Number.isInteger(value) && value > 0 && value <= SAFE_MAX_UID;
// isPlainObject：判断条件是否成立。
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// toPlainObject?处理 toPlainObject 相关逻辑。
const toPlainObject = (value) => (isPlainObject(value) ? value : {});

let friendsNotifier = null;

const authenticate = createAuthenticateMiddleware({ scope: 'Friends' });
// asyncRoute?处理 asyncRoute 相关逻辑。
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// resolveFriendIndex：解析并确定最终值。
const resolveFriendIndex = (users, payload = {}) => {
  const uidValue = Number(payload.friendUid);
  if (isValidUid(uidValue)) {
    return users.findIndex((item) => item.uid === uidValue);
  }
  if (typeof payload.friendUsername === 'string') {
    const normalized = normalizeUsername(payload.friendUsername);
    return users.findIndex((item) => item.username === normalized);
  }
  return -1;
};

// isUserOnline：判断条件是否成立。
const isUserOnline = (user) => {
  if (!isOnline(user)) return false;
  return hasValidToken(user);
};

// ensureFriendRequests：确保前置条件与资源可用。
const ensureFriendRequests = (user) => {
  if (!user.friendRequests || typeof user.friendRequests !== 'object') {
    user.friendRequests = { incoming: [], outgoing: [] };
  }
  if (!Array.isArray(user.friendRequests.incoming)) {
    user.friendRequests.incoming = [];
  }
  if (!Array.isArray(user.friendRequests.outgoing)) {
    user.friendRequests.outgoing = [];
  }
};

// nowIso?处理 nowIso 相关逻辑。
const nowIso = () => new Date().toISOString();

// findRequest：查找目标记录。
const findRequest = (list, uid) =>
  list.find((item) => item && Number.isInteger(item.uid) && item.uid === uid);

// removeRequest：清理无效或过期数据。
const removeRequest = (list, uid) =>
  list.filter((item) => !(item && Number.isInteger(item.uid) && item.uid === uid));

// normalizeOutgoingEntry：归一化外部输入。
const normalizeOutgoingEntry = (entry) => ({
  uid: entry.uid,
  status: entry.status || REQUEST_STATUS_PENDING,
  createdAt: entry.createdAt || nowIso(),
  resolvedAt: entry.resolvedAt || null,
});

// setFriendsNotifier：设置运行时状态。
const setFriendsNotifier = (notifier) => {
  friendsNotifier = typeof notifier === 'function' ? notifier : null;
};

// notifyUsers?处理 notifyUsers 相关逻辑。
const notifyUsers = (uids, payload) => {
  if (!friendsNotifier) return;
  const list = Array.from(new Set(uids.filter(isValidUid)));
  if (!list.length) return;
  friendsNotifier(list, payload);
};

// 路由：POST /add。
router.post('/add', authenticate, asyncRoute(async (req, res) => {
  const actorUid = Number(req.auth?.user?.uid);
  const payload = toPlainObject(req.body);

  const mutation = await mutateUsers(
    (users) => {
      const userIndex = users.findIndex((item) => item.uid === actorUid);
      if (userIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '用户不存在。' } },
        };
      }

      const friendIndex = resolveFriendIndex(users, payload);
      if (friendIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '好友不存在。' } },
        };
      }

      const updatedUser = users[userIndex];
      const friendUser = users[friendIndex];
      if (!friendUser) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '好友不存在。' } },
        };
      }

      if (friendUser.uid === updatedUser.uid) {
        return {
          changed: false,
          result: {
            httpStatus: 400,
            body: { success: false, message: '不能添加自己为好友。' },
          },
        };
      }

      if (!Array.isArray(updatedUser.friends)) updatedUser.friends = [];
      if (!Array.isArray(friendUser.friends)) friendUser.friends = [];
      ensureFriendRequests(updatedUser);
      ensureFriendRequests(friendUser);

      if (
        updatedUser.friends.includes(friendUser.uid) &&
        friendUser.friends.includes(updatedUser.uid)
      ) {
        return {
          changed: false,
          result: { httpStatus: 200, body: { success: true, status: 'already_friends' } },
        };
      }

      const incomingEntry = findRequest(updatedUser.friendRequests.incoming, friendUser.uid);
      if (incomingEntry) {
        updatedUser.friendRequests.incoming = removeRequest(
          updatedUser.friendRequests.incoming,
          friendUser.uid
        );
        friendUser.friendRequests.outgoing = removeRequest(
          friendUser.friendRequests.outgoing,
          updatedUser.uid
        );

        if (!updatedUser.friends.includes(friendUser.uid)) {
          updatedUser.friends.push(friendUser.uid);
        }
        if (!friendUser.friends.includes(updatedUser.uid)) {
          friendUser.friends.push(updatedUser.uid);
        }

        return {
          changed: true,
          result: {
            httpStatus: 200,
            body: { success: true, status: 'accepted' },
            notifications: [
              { uids: [updatedUser.uid, friendUser.uid], payload: { type: 'friends' } },
              { uids: [updatedUser.uid, friendUser.uid], payload: { type: 'requests' } },
            ],
          },
        };
      }

      const outgoingEntry = findRequest(updatedUser.friendRequests.outgoing, friendUser.uid);
      if (outgoingEntry && outgoingEntry.status === REQUEST_STATUS_PENDING) {
        return {
          changed: false,
          result: { httpStatus: 200, body: { success: true, status: 'pending' } },
        };
      }

      const nextOutgoing =
        outgoingEntry && outgoingEntry.status === REQUEST_STATUS_REJECTED
          ? {
              ...outgoingEntry,
              status: REQUEST_STATUS_PENDING,
              createdAt: nowIso(),
              resolvedAt: null,
            }
          : {
              uid: friendUser.uid,
              status: REQUEST_STATUS_PENDING,
              createdAt: nowIso(),
              resolvedAt: null,
            };

      updatedUser.friendRequests.outgoing = removeRequest(
        updatedUser.friendRequests.outgoing,
        friendUser.uid
      );
      updatedUser.friendRequests.outgoing.push(normalizeOutgoingEntry(nextOutgoing));

      friendUser.friendRequests.incoming = removeRequest(
        friendUser.friendRequests.incoming,
        updatedUser.uid
      );
      friendUser.friendRequests.incoming.push({
        uid: updatedUser.uid,
        status: REQUEST_STATUS_PENDING,
        createdAt: nowIso(),
      });

      return {
        changed: true,
        result: {
          httpStatus: 200,
          body: { success: true, status: 'pending' },
          notifications: [
            { uids: [updatedUser.uid, friendUser.uid], payload: { type: 'requests' } },
          ],
        },
      };
    },
    { defaultChanged: false }
  );

  const result = mutation.result;
  if (!result) {
    res.status(500).json({ success: false, message: '服务器错误。' });
    return;
  }

  (result.notifications || []).forEach((item) => {
    notifyUsers(item.uids || [], item.payload || {});
  });
  res.status(result.httpStatus || 200).json(result.body || { success: false });
}));

// 路由：DELETE /remove。
router.delete('/remove', authenticate, asyncRoute(async (req, res) => {
  const actorUid = Number(req.auth?.user?.uid);
  const payload = toPlainObject(req.body);

  const mutation = await mutateUsers(
    (users) => {
      const userIndex = users.findIndex((item) => item.uid === actorUid);
      if (userIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '用户不存在。' } },
        };
      }
      const friendIndex = resolveFriendIndex(users, payload);
      if (friendIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '好友不存在。' } },
        };
      }

      const updatedUser = users[userIndex];
      const friendUser = users[friendIndex];
      if (!Array.isArray(updatedUser.friends)) updatedUser.friends = [];
      updatedUser.friends = updatedUser.friends.filter((uid) => uid !== friendUser.uid);

      if (friendUser) {
        if (!Array.isArray(friendUser.friends)) friendUser.friends = [];
        friendUser.friends = friendUser.friends.filter((uid) => uid !== updatedUser.uid);
        ensureFriendRequests(friendUser);
        friendUser.friendRequests.incoming = removeRequest(
          friendUser.friendRequests.incoming,
          updatedUser.uid
        );
        friendUser.friendRequests.outgoing = removeRequest(
          friendUser.friendRequests.outgoing,
          updatedUser.uid
        );
      }

      ensureFriendRequests(updatedUser);
      updatedUser.friendRequests.incoming = removeRequest(
        updatedUser.friendRequests.incoming,
        friendUser.uid
      );
      updatedUser.friendRequests.outgoing = removeRequest(
        updatedUser.friendRequests.outgoing,
        friendUser.uid
      );

      return {
        changed: true,
        result: {
          httpStatus: 200,
          body: { success: true, friends: updatedUser.friends },
          notifications: [
            { uids: [updatedUser.uid, friendUser.uid], payload: { type: 'friends' } },
            { uids: [updatedUser.uid, friendUser.uid], payload: { type: 'requests' } },
          ],
        },
      };
    },
    { defaultChanged: false }
  );

  const result = mutation.result;
  if (!result) {
    res.status(500).json({ success: false, message: '服务器错误。' });
    return;
  }

  (result.notifications || []).forEach((item) => {
    notifyUsers(item.uids || [], item.payload || {});
  });
  res.status(result.httpStatus || 200).json(result.body || { success: false });
}));

// 路由：GET /list。
router.get('/list', authenticate, asyncRoute(async (req, res) => {
  const { users, user } = req.auth;
  const friendSet = new Set(user.friends || []);
  const friends = users
    .filter((item) => friendSet.has(item.uid))
    .map((item) => ({
      uid: item.uid,
      username: item.username,
      nickname: item.nickname || '',
      signature: item.signature || '',
      avatar: item.avatar || '',
      online: isUserOnline(item),
    }));
  res.json({ success: true, friends });
}));

// 路由：GET /requests。
router.get('/requests', authenticate, asyncRoute(async (req, res) => {
  const actorUid = Number(req.auth?.user?.uid);
  const mutation = await mutateUsers(
    (users) => {
      const userIndex = users.findIndex((item) => item.uid === actorUid);
      if (userIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '用户不存在。' } },
        };
      }
      const updatedUser = users[userIndex];
      ensureFriendRequests(updatedUser);

      let touched = false;
      const mapUser = (uid) => users.find((item) => item.uid === uid) || null;

      const incoming = updatedUser.friendRequests.incoming
        .map((entry) => {
          const target = mapUser(entry.uid);
          if (!target) {
            touched = true;
            return null;
          }
          return {
            uid: target.uid,
            username: target.username,
            avatar: target.avatar || '',
            status: entry.status || REQUEST_STATUS_PENDING,
            createdAt: entry.createdAt || null,
          };
        })
        .filter(Boolean);

      const outgoing = updatedUser.friendRequests.outgoing
        .map((entry) => {
          const target = mapUser(entry.uid);
          if (!target) {
            touched = true;
            return null;
          }
          return {
            uid: target.uid,
            username: target.username,
            avatar: target.avatar || '',
            status: entry.status || REQUEST_STATUS_PENDING,
            createdAt: entry.createdAt || null,
            resolvedAt: entry.resolvedAt || null,
          };
        })
        .filter(Boolean);

      if (touched) {
        updatedUser.friendRequests.incoming = updatedUser.friendRequests.incoming.filter((entry) =>
          mapUser(entry.uid)
        );
        updatedUser.friendRequests.outgoing = updatedUser.friendRequests.outgoing.filter((entry) =>
          mapUser(entry.uid)
        );
      }

      return {
        changed: touched,
        result: { httpStatus: 200, body: { success: true, incoming, outgoing } },
      };
    },
    { defaultChanged: false }
  );

  const result = mutation.result;
  if (!result) {
    res.status(500).json({ success: false, message: '服务器错误。' });
    return;
  }
  res.status(result.httpStatus || 200).json(result.body || { success: false });
}));

// 路由：POST /respond。
router.post('/respond', authenticate, asyncRoute(async (req, res) => {
  const actorUid = Number(req.auth?.user?.uid);
  const { requesterUid, action } = toPlainObject(req.body);
  const requesterId = Number(requesterUid);
  if (!isValidUid(requesterId)) {
    res.status(400).json({ success: false, message: '请求用户编号无效。' });
    return;
  }
  if (action !== 'accept' && action !== 'reject') {
    res.status(400).json({ success: false, message: '无效的操作。' });
    return;
  }

  const mutation = await mutateUsers(
    (users) => {
      const userIndex = users.findIndex((item) => item.uid === actorUid);
      if (userIndex < 0) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '用户不存在。' } },
        };
      }

      const updatedUser = users[userIndex];
      ensureFriendRequests(updatedUser);
      const incomingEntry = findRequest(updatedUser.friendRequests.incoming, requesterId);
      if (!incomingEntry) {
        return {
          changed: false,
          result: { httpStatus: 404, body: { success: false, message: '请求不存在。' } },
        };
      }

      const requesterIndex = users.findIndex((item) => item.uid === requesterId);
      const requester = requesterIndex >= 0 ? users[requesterIndex] : null;
      if (requester) {
        ensureFriendRequests(requester);
      }

      updatedUser.friendRequests.incoming = removeRequest(
        updatedUser.friendRequests.incoming,
        requesterId
      );

      if (action === 'accept') {
        if (!Array.isArray(updatedUser.friends)) updatedUser.friends = [];
        if (!updatedUser.friends.includes(requesterId)) {
          updatedUser.friends.push(requesterId);
        }
        if (requester) {
          if (!Array.isArray(requester.friends)) requester.friends = [];
          if (!requester.friends.includes(updatedUser.uid)) {
            requester.friends.push(updatedUser.uid);
          }
          requester.friendRequests.outgoing = removeRequest(
            requester.friendRequests.outgoing,
            updatedUser.uid
          );
        }

        return {
          changed: true,
          result: {
            httpStatus: 200,
            body: { success: true, status: 'accepted' },
            notifications: [
              { uids: [updatedUser.uid, requesterId], payload: { type: 'friends' } },
              { uids: [updatedUser.uid, requesterId], payload: { type: 'requests' } },
            ],
          },
        };
      }

      if (requester) {
        const outgoingEntry = findRequest(requester.friendRequests.outgoing, updatedUser.uid);
        if (outgoingEntry) {
          requester.friendRequests.outgoing = removeRequest(
            requester.friendRequests.outgoing,
            updatedUser.uid
          );
          requester.friendRequests.outgoing.push(
            normalizeOutgoingEntry({
              ...outgoingEntry,
              status: REQUEST_STATUS_REJECTED,
              resolvedAt: nowIso(),
            })
          );
        }
      }

      return {
        changed: true,
        result: {
          httpStatus: 200,
          body: { success: true, status: 'rejected' },
          notifications: [
            { uids: [updatedUser.uid, requesterId], payload: { type: 'requests' } },
          ],
        },
      };
    },
    { defaultChanged: false }
  );

  const result = mutation.result;
  if (!result) {
    res.status(500).json({ success: false, message: '服务器错误。' });
    return;
  }

  (result.notifications || []).forEach((item) => {
    notifyUsers(item.uids || [], item.payload || {});
  });
  res.status(result.httpStatus || 200).json(result.body || { success: false });
}));

// 路由：GET /search。
router.get('/search', authenticate, asyncRoute(async (req, res) => {
  const { users } = req.auth;
  const payload = { ...toPlainObject(req.query), ...toPlainObject(req.body) };
  const uid = Number(payload.uid);
  if (!isValidUid(uid)) {
    res.status(400).json({ success: false, message: '用户编号无效。' });
    return;
  }

  const target = users.find((item) => item.uid === uid);
  if (!target) {
    res.status(404).json({ success: false, message: '用户不存在。' });
    return;
  }

  res.json({
    success: true,
    user: {
      uid: target.uid,
      username: target.username,
      avatar: target.avatar || '',
      online: isUserOnline(target),
    },
  });
}));

// 路由：GET /profile。
router.get('/profile', authenticate, asyncRoute(async (req, res) => {
  const { users, user } = req.auth;
  const uid = Number(req.query?.uid);
  if (!isValidUid(uid)) {
    res.status(400).json({ success: false, message: '用户编号无效。' });
    return;
  }

  const target = users.find((item) => item.uid === uid);
  if (!target) {
    res.status(404).json({ success: false, message: '用户不存在。' });
    return;
  }

  const isMutual =
    Array.isArray(user.friends) &&
    user.friends.includes(uid) &&
    Array.isArray(target.friends) &&
    target.friends.includes(user.uid);
  if (!isMutual) {
    res.status(403).json({ success: false, message: '对方不是互为好友。' });
    return;
  }

  res.json({
    success: true,
    user: {
      uid: target.uid,
      username: target.username,
      nickname: target.nickname || target.username,
      signature: target.signature || '',
      gender: target.gender || '',
      birthday: target.birthday || '',
      country: target.country || '',
      province: target.province || '',
      region: target.region || '',
      avatar: target.avatar || '',
      online: isUserOnline(target),
    },
  });
}));

export { setFriendsNotifier };
export default router;
