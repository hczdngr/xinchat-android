import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAuthenticateMiddleware } from './session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const GROUPS_PATH = path.join(DATA_DIR, 'groups.json');
const GROUPS_TMP_PATH = path.join(DATA_DIR, 'groups.json.tmp');

const GROUP_ID_START = 2000000000;
const MAX_GROUP_MEMBERS = 50;
const GROUP_NAME_MAX_LEN = 80;
const GROUP_DESCRIPTION_MAX_LEN = 240;
const GROUP_ANNOUNCEMENT_MAX_LEN = 300;
const GROUP_MEMBER_NICK_MAX_LEN = 40;

const CACHE_TTL_MS = 800;

const router = express.Router();
const authenticate = createAuthenticateMiddleware({ scope: 'Groups' });

let cachedGroups = null;
let cachedGroupsAt = 0;
let writeQueue = Promise.resolve();
let leaveQueue = Promise.resolve();

const clone = (value) => JSON.parse(JSON.stringify(value || []));

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureGroupStorage = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!(await fileExists(GROUPS_PATH))) {
    await fs.writeFile(GROUPS_PATH, '[]', 'utf-8');
  }
};

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
    await fs.writeFile(GROUPS_PATH, JSON.stringify(groups, null, 2), 'utf-8');
  }

  cachedGroups = clone(groups);
  cachedGroupsAt = now;
  return clone(cachedGroups);
};

const writeGroups = async (groups) => {
  await ensureGroupStorage();
  const snapshot = sanitizeGroups(groups);
  const run = writeQueue.then(async () => {
    await fs.writeFile(GROUPS_TMP_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    await fs.rename(GROUPS_TMP_PATH, GROUPS_PATH);
    cachedGroups = clone(snapshot);
    cachedGroupsAt = Date.now();
  });
  writeQueue = run.catch(() => {});
  await run;
};

const getNextGroupId = (groups) => {
  let maxId = GROUP_ID_START - 1;
  groups.forEach((group) => {
    if (Number.isInteger(group?.id)) {
      maxId = Math.max(maxId, Number(group.id));
    }
  });
  return Math.max(maxId + 1, GROUP_ID_START);
};

const getDisplayName = (user) => {
  const nickname = typeof user?.nickname === 'string' ? user.nickname.trim() : '';
  const username = typeof user?.username === 'string' ? user.username.trim() : '';
  return nickname || username || `用户${Number(user?.uid) || ''}`;
};

const toMemberPreview = (user, uid, group) => ({
  uid,
  username: user?.username || '',
  nickname: user?.nickname || '',
  groupNickname: String(group?.memberNicknames?.[uid] || ''),
  avatar: user?.avatar || '',
  signature: user?.signature || '',
  online: Boolean(user?.online),
});

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
  const joined = names.join('、') || '群聊';
  return `${joined}(${Math.max(2, nameOrder.length)})`.slice(0, GROUP_NAME_MAX_LEN);
};

const isMutualFriend = (a, b) =>
  Array.isArray(a?.friends) &&
  Array.isArray(b?.friends) &&
  a.friends.includes(b.uid) &&
  b.friends.includes(a.uid);

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

const getGroupById = async (groupId) => {
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0) return null;
  const groups = await readGroups();
  return groups.find((group) => group.id === gid) || null;
};

const getGroupMemberUids = async (groupId) => {
  const group = await getGroupById(groupId);
  if (!group) return [];
  return normalizeMemberUids(group.memberUids);
};

const isUserInGroup = async (groupId, uid) => {
  const memberUids = await getGroupMemberUids(groupId);
  return memberUids.includes(Number(uid));
};

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

router.post('/create', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const rawMemberUids = normalizeMemberUids(req.body?.memberUids);
    const inviteUids = rawMemberUids.filter((uid) => uid !== user.uid);
    if (inviteUids.length === 0) {
      res.status(400).json({ success: false, message: '请至少选择一位好友。' });
      return;
    }
    if (inviteUids.length + 1 > MAX_GROUP_MEMBERS) {
      res.status(400).json({ success: false, message: '群成员数量超过上限。' });
      return;
    }

    for (const uid of inviteUids) {
      const target = users.find((item) => item.uid === uid);
      if (!target) {
        res.status(404).json({ success: false, message: `用户 ${uid} 不存在。` });
        return;
      }
      if (!isMutualFriend(user, target)) {
        res.status(403).json({ success: false, message: `用户 ${uid} 不是你的好友。` });
        return;
      }
    }

    const groups = await readGroups();
    const groupId = getNextGroupId(groups);
    const memberUids = [user.uid, ...inviteUids];
    const rawName =
      typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, GROUP_NAME_MAX_LEN) : '';
    const name = rawName || buildDefaultGroupName(inviteUids, users, user.uid);
    const now = new Date().toISOString();
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
    res.json({ success: true, group: serializeGroup(group, users, user.uid) });
  } catch (error) {
    console.error('Group create error:', error);
    res.status(500).json({ success: false, message: '创建群聊失败。' });
  }
});

router.post('/update', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groupId = Number(req.body?.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ success: false, message: '群ID无效。' });
      return;
    }

    const groups = await readGroups();
    const groupIndex = groups.findIndex((item) => item.id === groupId);
    if (groupIndex === -1) {
      res.status(404).json({ success: false, message: '群聊不存在。' });
      return;
    }

    const group = { ...groups[groupIndex] };
    const memberSet = new Set(normalizeMemberUids(group.memberUids));
    if (!memberSet.has(user.uid)) {
      res.status(403).json({ success: false, message: '你不在该群聊中。' });
      return;
    }

    let touched = false;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const nextName =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, GROUP_NAME_MAX_LEN) : '';
      group.name = nextName;
      touched = true;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'description')) {
      const nextDescription =
        typeof req.body?.description === 'string'
          ? req.body.description.trim().slice(0, GROUP_DESCRIPTION_MAX_LEN)
          : '';
      group.description = nextDescription;
      touched = true;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'announcement')) {
      const nextAnnouncement =
        typeof req.body?.announcement === 'string'
          ? req.body.announcement.trim().slice(0, GROUP_ANNOUNCEMENT_MAX_LEN)
          : '';
      group.announcement = nextAnnouncement;
      touched = true;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'myNickname')) {
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
      group.memberNicknames = nextMemberNicknames;
      touched = true;
    }

    if (!touched) {
      res.status(400).json({ success: false, message: '没有可更新的字段。' });
      return;
    }

    group.updatedAt = new Date().toISOString();
    groups[groupIndex] = sanitizeGroup(group);
    await writeGroups(groups);
    res.json({ success: true, group: serializeGroup(groups[groupIndex], users, user.uid) });
  } catch (error) {
    console.error('Group update error:', error);
    res.status(500).json({ success: false, message: '更新群信息失败。' });
  }
});

router.post('/leave', authenticate, async (req, res) => {
  try {
    await ensureGroupStorage();
    const { user, users } = req.auth;
    const groupId = Number(req.body?.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      res.status(400).json({ success: false, message: '群ID无效。' });
      return;
    }

    const leaveTask = leaveQueue
      .catch(() => undefined)
      .then(async () => {
        const groups = await readGroups();
        const groupIndex = groups.findIndex((item) => item.id === groupId);
        if (groupIndex === -1) {
          return {
            status: 404,
            body: { success: false, message: '群聊不存在。' },
          };
        }

        const group = { ...groups[groupIndex] };
        const originMemberUids = normalizeMemberUids(group.memberUids);
        const memberUids = originMemberUids.filter((uid) => uid !== user.uid);
        if (memberUids.length === originMemberUids.length) {
          return {
            status: 403,
            body: { success: false, message: '你不在该群聊中。' },
          };
        }

        if (memberUids.length === 0) {
          groups.splice(groupIndex, 1);
          await writeGroups(groups);
          return {
            status: 200,
            body: { success: true, removed: true },
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
        group.updatedAt = new Date().toISOString();

        groups[groupIndex] = sanitizeGroup(group);
        await writeGroups(groups);
        return {
          status: 200,
          body: {
            success: true,
            removed: false,
            group: serializeGroup(groups[groupIndex], users, user.uid),
          },
        };
      });

    leaveQueue = leaveTask.then(() => undefined).catch(() => undefined);
    const result = await leaveTask;
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Group leave error:', error);
    res.status(500).json({ success: false, message: '退出群聊失败。' });
  }
});
export { ensureGroupStorage, readGroups, writeGroups, getGroupById, getGroupMemberUids, isUserInGroup };
export default router;
