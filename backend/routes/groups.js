/**
 * 模块说明：群组路由模块：处理群组创建、查询、更新与退出流程。
 */


import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAuthenticateMiddleware } from './session.js';
import { atomicWriteFile, createSerialQueue } from '../utils/filePersistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const GROUPS_PATH = path.join(DATA_DIR, 'groups.json');
const GROUPS_LOCK_PATH = path.join(DATA_DIR, 'groups.json.lock');

const GROUP_ID_START = 2000000000;
const MAX_GROUP_MEMBERS = 50;
const GROUP_NAME_MAX_LEN = 80;
const GROUP_DESCRIPTION_MAX_LEN = 240;
const GROUP_ANNOUNCEMENT_MAX_LEN = 300;
const GROUP_MEMBER_NICK_MAX_LEN = 40;

const CACHE_TTL_MS = 800;
const GROUPS_WRITE_QUEUE_MAX = 2000;
const GROUPS_MUTATION_QUEUE_MAX = 2000;

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Groups' });

let cachedGroups = null;
let cachedGroupsAt = 0;
const writeQueue = createSerialQueue({
  maxPending: GROUPS_WRITE_QUEUE_MAX,
  overflowError: 'groups_write_queue_overflow',
});
const mutationQueue = createSerialQueue({
  maxPending: GROUPS_MUTATION_QUEUE_MAX,
  overflowError: 'groups_mutation_queue_overflow',
});
let groupsNotifier = null;

// clone?处理 clone 相关逻辑。
const clone = (value) => JSON.parse(JSON.stringify(value || []));
// nowIso?处理 nowIso 相关逻辑。
const nowIso = () => new Date().toISOString();

// setGroupsNotifier：设置运行时状态。
const setGroupsNotifier = (notifier) => {
  groupsNotifier = typeof notifier === 'function' ? notifier : null;
};

// notifyGroupUsers?处理 notifyGroupUsers 相关逻辑。
const notifyGroupUsers = (uids, payload) => {
  if (!groupsNotifier) return;
  const list = Array.from(
    new Set(
      (Array.isArray(uids) ? uids : [])
        .map((uid) => Number(uid))
        .filter((uid) => Number.isInteger(uid) && uid > 0)
    )
  );
  if (!list.length) return;
  try {
    groupsNotifier(list, payload);
  } catch (error) {
    console.error('Group notifier error:', error);
  }
};

// emitGroupEvent?处理 emitGroupEvent 相关逻辑。
const emitGroupEvent = (uids, payload) => {
  setImmediate(() => notifyGroupUsers(uids, payload));
};

// enqueueMutation?处理 enqueueMutation 相关逻辑。
const enqueueMutation = (task) => {
  return mutationQueue.enqueue(task);
};

// fileExists?处理 fileExists 相关逻辑。
const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

// ensureGroupStorage：确保前置条件与资源可用。
const ensureGroupStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!(await fileExists(GROUPS_PATH))) {
    await atomicWriteFile(GROUPS_PATH, '[]', {
      lockPath: GROUPS_LOCK_PATH,
    });
  }
};

// normalizeMemberUids：归一化外部输入。
const normalizeMemberUids = (input) => {
  const set = new Set();
  const list = Array.isArray(input) ? input : [];
  list.forEach((rawUid) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (set.has(uid)) return;
    set.add(uid);
  });
  return Array.from(set);
};

// sanitizeMemberNicknames：清洗不可信输入。
const sanitizeMemberNicknames = (input, memberUids) => {
  const memberSet = new Set(Array.isArray(memberUids) ? memberUids : []);
  const source = input && typeof input === 'object' ? input : {};
  const next = {};
  Object.entries(source).forEach(([rawUid, rawNick]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || !memberSet.has(uid)) return;
    if (typeof rawNick !== 'string') return;
    const nickname = rawNick.trim().slice(0, GROUP_MEMBER_NICK_MAX_LEN);
    if (!nickname) return;
    next[uid] = nickname;
  });
  return next;
};

// sanitizeGroup：清洗不可信输入。
const sanitizeGroup = (input) => {
  const id = Number(input?.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const ownerUidRaw = Number(input?.ownerUid);
  const memberUids = normalizeMemberUids(input?.memberUids);
  if (memberUids.length === 0) return null;

  let ownerUid = ownerUidRaw;
  if (!Number.isInteger(ownerUid) || ownerUid <= 0 || !memberUids.includes(ownerUid)) {
    ownerUid = memberUids[0];
  }
  if (!memberUids.includes(ownerUid)) {
    memberUids.unshift(ownerUid);
  }

  const createdAt =
    typeof input?.createdAt === 'string' && input.createdAt
      ? input.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof input?.updatedAt === 'string' && input.updatedAt
      ? input.updatedAt
      : createdAt;

  const name =
    typeof input?.name === 'string' ? input.name.trim().slice(0, GROUP_NAME_MAX_LEN) : '';
  const description =
    typeof input?.description === 'string'
      ? input.description.trim().slice(0, GROUP_DESCRIPTION_MAX_LEN)
      : '';
  const announcement =
    typeof input?.announcement === 'string'
      ? input.announcement.trim().slice(0, GROUP_ANNOUNCEMENT_MAX_LEN)
      : '';
  const memberNicknames = sanitizeMemberNicknames(input?.memberNicknames, memberUids);

  return {
    id,
    ownerUid,
    memberUids,
    name,
    description,
    announcement,
    memberNicknames,
    createdAt,
    updatedAt,
  };
};

// sanitizeGroups：清洗不可信输入。
const sanitizeGroups = (input) => {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const next = [];
  source.forEach((entry) => {
    const group = sanitizeGroup(entry);
    if (!group || seen.has(group.id)) return;
    seen.add(group.id);
    next.push(group);
  });
  return next;
};

// readGroups：读取持久化或缓存数据。
const readGroups = async () => {
  await ensureGroupStorage();
  const now = Date.now();
  if (cachedGroups && now - cachedGroupsAt < CACHE_TTL_MS) {
    return clone(cachedGroups);
  }

  const raw = await fs.readFile(GROUPS_PATH, 'utf-8').catch(() => '[]');
  let parsed = [];
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    parsed = [];
  }

  const groups = sanitizeGroups(parsed);
  if (!Array.isArray(parsed) || parsed.length !== groups.length) {
    await atomicWriteFile(GROUPS_PATH, JSON.stringify(groups, null, 2), {
      lockPath: GROUPS_LOCK_PATH,
    });
  }

  cachedGroups = clone(groups);
  cachedGroupsAt = now;
  return clone(cachedGroups);
};

// writeGroups：写入持久化数据。
const writeGroups = async (groups) => {
  await ensureGroupStorage();
  const snapshot = sanitizeGroups(groups);
  const run = writeQueue.enqueue(async () => {
    await atomicWriteFile(GROUPS_PATH, JSON.stringify(snapshot, null, 2), {
      lockPath: GROUPS_LOCK_PATH,
    });
    cachedGroups = clone(snapshot);
    cachedGroupsAt = Date.now();
  });
  await run;
};

// getNextGroupId：获取并返回目标数据。
const getNextGroupId = (groups) => {
  let maxId = GROUP_ID_START - 1;
  groups.forEach((group) => {
    if (Number.isInteger(group?.id)) {
      maxId = Math.max(maxId, Number(group.id));
    }
  });
  return Math.max(maxId + 1, GROUP_ID_START);
};

// getDisplayName：获取并返回目标数据。
const getDisplayName = (user) => {
  const nickname = typeof user?.nickname === 'string' ? user.nickname.trim() : '';
  const username = typeof user?.username === 'string' ? user.username.trim() : '';
  return nickname || username || `\u7528\u6237${Number(user?.uid) || ''}`;
};

// toMemberPreview?处理 toMemberPreview 相关逻辑。
const toMemberPreview = (user, uid, group) => ({
  uid,
  username: user?.username || '',
  nickname: user?.nickname || '',
  groupNickname: String(group?.memberNicknames?.[uid] || ''),
  avatar: user?.avatar || '',
  signature: user?.signature || '',
  online: Boolean(user?.online),
});

// buildDefaultGroupName：构建对外输出数据。
const buildDefaultGroupName = (inviteOrderUids, users, selfUid) => {
  const nameOrder = [...inviteOrderUids];
  if (!nameOrder.includes(selfUid)) {
    nameOrder.push(selfUid);
  }
  const names = nameOrder
    .map((uid) => users.find((item) => item.uid === uid))
    .filter(Boolean)
    .map((user) => getDisplayName(user))
    .filter(Boolean);
  const joined = names.join('\u3001') || '\u7fa4\u804a';
  return `${joined}(${Math.max(2, nameOrder.length)})`.slice(0, GROUP_NAME_MAX_LEN);
};

// isMutualFriend：判断条件是否成立。
const isMutualFriend = (a, b) =>
  Array.isArray(a?.friends) &&
  Array.isArray(b?.friends) &&
  a.friends.includes(b.uid) &&
  b.friends.includes(a.uid);

// serializeGroup?处理 serializeGroup 相关逻辑。
const serializeGroup = (group, users, currentUid) => {
  const safeUsers = Array.isArray(users) ? users : [];
  const memberUids = normalizeMemberUids(group?.memberUids);
  return {
    id: Number(group?.id),
    ownerUid: Number(group?.ownerUid),
    name: typeof group?.name === 'string' ? group.name : '',
    description: typeof group?.description === 'string' ? group.description : '',
    announcement: typeof group?.announcement === 'string' ? group.announcement : '',
    memberUids,
    myNickname:
      Number.isInteger(Number(currentUid)) && Number(currentUid) > 0
        ? String(group?.memberNicknames?.[Number(currentUid)] || '')
        : '',
    members: memberUids.map((uid) => {
      const user = safeUsers.find((item) => item.uid === uid);
      return toMemberPreview(user, uid, group);
    }),
    createdAt: group?.createdAt,
    updatedAt: group?.updatedAt,
  };
};

// getGroupById：获取并返回目标数据。
const getGroupById = async (groupId) => {
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0) return null;
  const groups = await readGroups();
  return groups.find((group) => group.id === gid) || null;
};

// getGroupMemberUids：获取并返回目标数据。
const getGroupMemberUids = async (groupId) => {
  const group = await getGroupById(groupId);
  if (!group) return [];
  return normalizeMemberUids(group.memberUids);
};

// isUserInGroup：判断条件是否成立。
const isUserInGroup = async (groupId, uid) => {
  const memberUids = await getGroupMemberUids(groupId);
  return memberUids.includes(Number(uid));
};

// 路由：GET /list。
router.get('/list', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groups = await readGroups();
    const list = groups
      .filter((group) => normalizeMemberUids(group.memberUids).includes(user.uid))
      .map((group) => serializeGroup(group, users, user.uid))
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
    res.json({ success: true, groups: list });
  } catch (error) {
    console.error('Group list error:', error);
    res.status(500).json({ success: false, message: '获取群聊列表失败。' });
  }
});

// 路由：GET /detail。
router.get('/detail', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groupId = Number(req.query?.groupId || req.body?.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ success: false, message: '群ID无效。' });
      return;
    }
    const groups = await readGroups();
    const group = groups.find((item) => item.id === groupId);
    if (!group) {
      res.status(404).json({ success: false, message: '群聊不存在。' });
      return;
    }
    if (!normalizeMemberUids(group.memberUids).includes(user.uid)) {
      res.status(403).json({ success: false, message: '你不在该群聊中。' });
      return;
    }
    res.json({ success: true, group: serializeGroup(group, users, user.uid) });
  } catch (error) {
    console.error('Group detail error:', error);
    res.status(500).json({ success: false, message: '获取群聊详情失败。' });
  }
});

// 路由：POST /create。
router.post('/create', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const rawMemberUids = normalizeMemberUids(req.body?.memberUids);
    const inviteUids = rawMemberUids.filter((uid) => uid !== user.uid);
    if (inviteUids.length === 0) {
      res.status(400).json({ success: false, message: '\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4f4d\u597d\u53cb\u3002' });
      return;
    }
    if (inviteUids.length + 1 > MAX_GROUP_MEMBERS) {
      res.status(400).json({ success: false, message: '\u7fa4\u6210\u5458\u6570\u91cf\u8d85\u8fc7\u4e0a\u9650\u3002' });
      return;
    }

    for (const uid of inviteUids) {
      const target = users.find((item) => item.uid === uid);
      if (!target) {
        res.status(404).json({ success: false, message: `\u7528\u6237 ${uid} \u4e0d\u5b58\u5728\u3002` });
        return;
      }
      if (!isMutualFriend(user, target)) {
        res.status(403).json({ success: false, message: `\u7528\u6237 ${uid} \u4e0d\u662f\u4f60\u7684\u597d\u53cb\u3002` });
        return;
      }
    }

    const result = await enqueueMutation(async () => {
      const groups = await readGroups();
      const groupId = getNextGroupId(groups);
      const memberUids = [user.uid, ...inviteUids];
      const rawName =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, GROUP_NAME_MAX_LEN) : '';
      const name = rawName || buildDefaultGroupName(inviteUids, users, user.uid);
      const now = nowIso();
      const group = {
        id: groupId,
        ownerUid: user.uid,
        memberUids,
        name,
        description: '',
        announcement: '',
        memberNicknames: {},
        createdAt: now,
        updatedAt: now,
      };
      groups.push(group);
      await writeGroups(groups);
      return {
        status: 200,
        body: { success: true, group: serializeGroup(group, users, user.uid) },
        notify: {
          uids: memberUids,
          payload: {
            event: 'group_created',
            groupId,
            actorUid: user.uid,
            updatedAt: now,
          },
        },
      };
    });

    if (result?.notify) {
      emitGroupEvent(result.notify.uids, result.notify.payload);
    }
    res.status(result?.status || 200).json(result?.body || { success: false, message: '\u521b\u5efa\u7fa4\u804a\u5931\u8d25\u3002' });
  } catch (error) {
    console.error('Group create error:', error);
    res.status(500).json({ success: false, message: '\u521b\u5efa\u7fa4\u804a\u5931\u8d25\u3002' });
  }
});

// 路由：POST /update。
router.post('/update', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groupId = Number(req.body?.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ success: false, message: '\u7fa4ID\u65e0\u6548\u3002' });
      return;
    }

    const result = await enqueueMutation(async () => {
      const groups = await readGroups();
      const groupIndex = groups.findIndex((item) => item.id === groupId);
      if (groupIndex === -1) {
        return {
          status: 404,
          body: { success: false, message: '\u7fa4\u804a\u4e0d\u5b58\u5728\u3002' },
        };
      }

      const group = { ...groups[groupIndex] };
      const memberUids = normalizeMemberUids(group.memberUids);
      const memberSet = new Set(memberUids);
      if (!memberSet.has(user.uid)) {
        return {
          status: 403,
          body: { success: false, message: '\u4f60\u4e0d\u5728\u8be5\u7fa4\u804a\u4e2d\u3002' },
        };
      }

      const changedFields = [];
      let hasUpdatableField = false;

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
        hasUpdatableField = true;
        const nextName =
          typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, GROUP_NAME_MAX_LEN) : '';
        if (group.name !== nextName) {
          group.name = nextName;
          changedFields.push('name');
        }
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) {
        hasUpdatableField = true;
        const nextDescription =
          typeof req.body?.description === 'string'
            ? req.body.description.trim().slice(0, GROUP_DESCRIPTION_MAX_LEN)
            : '';
        if (group.description !== nextDescription) {
          group.description = nextDescription;
          changedFields.push('description');
        }
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'announcement')) {
        hasUpdatableField = true;
        const nextAnnouncement =
          typeof req.body?.announcement === 'string'
            ? req.body.announcement.trim().slice(0, GROUP_ANNOUNCEMENT_MAX_LEN)
            : '';
        if (group.announcement !== nextAnnouncement) {
          group.announcement = nextAnnouncement;
          changedFields.push('announcement');
        }
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'myNickname')) {
        hasUpdatableField = true;
        const nextMyNickname =
          typeof req.body?.myNickname === 'string'
            ? req.body.myNickname.trim().slice(0, GROUP_MEMBER_NICK_MAX_LEN)
            : '';
        const nextMemberNicknames = {
          ...(group.memberNicknames && typeof group.memberNicknames === 'object'
            ? group.memberNicknames
            : {}),
        };
        if (nextMyNickname) {
          nextMemberNicknames[user.uid] = nextMyNickname;
        } else {
          delete nextMemberNicknames[user.uid];
        }
        const currentMyNickname = String(group.memberNicknames?.[user.uid] || '');
        if (currentMyNickname !== String(nextMemberNicknames[user.uid] || '')) {
          group.memberNicknames = nextMemberNicknames;
          changedFields.push('myNickname');
        }
      }

      if (!hasUpdatableField) {
        return {
          status: 400,
          body: { success: false, message: '\u6ca1\u6709\u53ef\u66f4\u65b0\u7684\u5b57\u6bb5\u3002' },
        };
      }

      if (!changedFields.length) {
        return {
          status: 200,
          body: { success: true, group: serializeGroup(groups[groupIndex], users, user.uid) },
        };
      }

      group.updatedAt = nowIso();
      groups[groupIndex] = sanitizeGroup(group);
      await writeGroups(groups);

      return {
        status: 200,
        body: { success: true, group: serializeGroup(groups[groupIndex], users, user.uid) },
        notify: {
          uids: memberUids,
          payload: {
            event: 'group_updated',
            groupId,
            actorUid: user.uid,
            changedFields,
            updatedAt: groups[groupIndex]?.updatedAt || nowIso(),
          },
        },
      };
    });

    if (result?.notify) {
      emitGroupEvent(result.notify.uids, result.notify.payload);
    }
    res.status(result?.status || 500).json(result?.body || { success: false, message: '\u66f4\u65b0\u7fa4\u4fe1\u606f\u5931\u8d25\u3002' });
  } catch (error) {
    console.error('Group update error:', error);
    res.status(500).json({ success: false, message: '\u66f4\u65b0\u7fa4\u4fe1\u606f\u5931\u8d25\u3002' });
  }
});

// 路由：POST /leave。
router.post('/leave', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groupId = Number(req.body?.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ success: false, message: '\u7fa4ID\u65e0\u6548\u3002' });
      return;
    }

    const result = await enqueueMutation(async () => {
      const groups = await readGroups();
      const groupIndex = groups.findIndex((item) => item.id === groupId);
      if (groupIndex === -1) {
        return {
          status: 404,
          body: { success: false, message: '\u7fa4\u804a\u4e0d\u5b58\u5728\u3002' },
        };
      }

      const group = { ...groups[groupIndex] };
      const originMemberUids = normalizeMemberUids(group.memberUids);
      const memberUids = originMemberUids.filter((uid) => uid !== user.uid);
      if (memberUids.length === originMemberUids.length) {
        return {
          status: 403,
          body: { success: false, message: '\u4f60\u4e0d\u5728\u8be5\u7fa4\u804a\u4e2d\u3002' },
        };
      }

      if (memberUids.length === 0) {
        groups.splice(groupIndex, 1);
        await writeGroups(groups);
        return {
          status: 200,
          body: { success: true, removed: true },
          notify: {
            uids: originMemberUids,
            payload: {
              event: 'group_removed',
              groupId,
              actorUid: user.uid,
              removed: true,
              updatedAt: nowIso(),
            },
          },
        };
      }

      const memberNicknames = {
        ...(group.memberNicknames && typeof group.memberNicknames === 'object'
          ? group.memberNicknames
          : {}),
      };
      delete memberNicknames[user.uid];

      group.memberUids = memberUids;
      group.memberNicknames = memberNicknames;
      if (!memberUids.includes(Number(group.ownerUid))) {
        group.ownerUid = memberUids[0];
      }
      group.updatedAt = nowIso();

      groups[groupIndex] = sanitizeGroup(group);
      await writeGroups(groups);
      return {
        status: 200,
        body: {
          success: true,
          removed: false,
          group: serializeGroup(groups[groupIndex], users, user.uid),
        },
        notify: {
          uids: originMemberUids,
          payload: {
            event: 'group_member_left',
            groupId,
            actorUid: user.uid,
            removed: false,
            updatedAt: groups[groupIndex]?.updatedAt || nowIso(),
          },
        },
      };
    });

    if (result?.notify) {
      emitGroupEvent(result.notify.uids, result.notify.payload);
    }
    res.status(result?.status || 500).json(result?.body || { success: false, message: '\u9000\u51fa\u7fa4\u804a\u5931\u8d25\u3002' });
  } catch (error) {
    console.error('Group leave error:', error);
    res.status(500).json({ success: false, message: '\u9000\u51fa\u7fa4\u804a\u5931\u8d25\u3002' });
  }
});
export { ensureGroupStorage, readGroups, writeGroups, getGroupById, getGroupMemberUids, isUserInGroup, setGroupsNotifier };
export default router;
