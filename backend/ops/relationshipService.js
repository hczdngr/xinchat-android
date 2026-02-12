/**
 * Relationship operations service:
 * - calculate 7/30-day interaction trend for friend and group conversations
 * - detect declined interactions and produce gentle action suggestions
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 20;
const SCOPE_SET = new Set(['all', 'private', 'group']);

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  if (parsed > max) return max;
  return parsed;
};

const normalizeScope = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'friends' || raw === 'friend' || raw === 'private') return 'private';
  if (raw === 'groups' || raw === 'group') return 'group';
  if (raw === 'all') return 'all';
  return 'all';
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
};

const normalizeWindowDays = (value) => {
  const parsed = toPositiveInt(value, 7, 1, 365);
  return parsed >= 30 ? 30 : 7;
};

const normalizeOptions = (options = {}) => {
  const scope = normalizeScope(options.scope);
  const includeStable = toBoolean(options.includeStable, false);
  const limit = toPositiveInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const windowDays = normalizeWindowDays(options.windowDays);
  return {
    scope: SCOPE_SET.has(scope) ? scope : 'all',
    includeStable,
    limit,
    windowDays,
  };
};

const queryRows = (database, sql, params = []) => {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
};

const buildStatsMapForPrivate = ({ database, viewerUid, friendUids, windows }) => {
  const map = new Map();
  if (!friendUids.length) return map;
  const placeholders = friendUids.map(() => '?').join(',');
  const sql = `
    SELECT
      CASE WHEN senderUid = ? THEN targetUid ELSE senderUid END AS peerUid,
      SUM(CASE WHEN createdAtMs >= ? THEN 1 ELSE 0 END) AS recent7Count,
      SUM(CASE WHEN createdAtMs >= ? AND createdAtMs < ? THEN 1 ELSE 0 END) AS prev7Count,
      SUM(CASE WHEN createdAtMs >= ? THEN 1 ELSE 0 END) AS recent30Count,
      SUM(CASE WHEN createdAtMs >= ? AND createdAtMs < ? THEN 1 ELSE 0 END) AS prev30Count,
      MAX(createdAtMs) AS lastAt
    FROM messages
    WHERE targetType = 'private'
      AND (
        (senderUid = ? AND targetUid IN (${placeholders}))
        OR
        (targetUid = ? AND senderUid IN (${placeholders}))
      )
    GROUP BY peerUid
  `;
  const params = [
    viewerUid,
    windows.recent7Start,
    windows.prev7Start,
    windows.recent7Start,
    windows.recent30Start,
    windows.prev30Start,
    windows.recent30Start,
    viewerUid,
    ...friendUids,
    viewerUid,
    ...friendUids,
  ];
  const rows = queryRows(database, sql, params);
  rows.forEach((row) => {
    const uid = Number(row?.peerUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    map.set(uid, {
      recent7Count: Number(row?.recent7Count) || 0,
      prev7Count: Number(row?.prev7Count) || 0,
      recent30Count: Number(row?.recent30Count) || 0,
      prev30Count: Number(row?.prev30Count) || 0,
      lastAt: Number(row?.lastAt) || 0,
    });
  });
  return map;
};

const buildStatsMapForGroup = ({ database, groupIds, windows }) => {
  const map = new Map();
  if (!groupIds.length) return map;
  const placeholders = groupIds.map(() => '?').join(',');
  const sql = `
    SELECT
      targetUid AS groupUid,
      SUM(CASE WHEN createdAtMs >= ? THEN 1 ELSE 0 END) AS recent7Count,
      SUM(CASE WHEN createdAtMs >= ? AND createdAtMs < ? THEN 1 ELSE 0 END) AS prev7Count,
      SUM(CASE WHEN createdAtMs >= ? THEN 1 ELSE 0 END) AS recent30Count,
      SUM(CASE WHEN createdAtMs >= ? AND createdAtMs < ? THEN 1 ELSE 0 END) AS prev30Count,
      MAX(createdAtMs) AS lastAt
    FROM messages
    WHERE targetType = 'group'
      AND targetUid IN (${placeholders})
    GROUP BY targetUid
  `;
  const params = [
    windows.recent7Start,
    windows.prev7Start,
    windows.recent7Start,
    windows.recent30Start,
    windows.prev30Start,
    windows.recent30Start,
    ...groupIds,
  ];
  const rows = queryRows(database, sql, params);
  rows.forEach((row) => {
    const uid = Number(row?.groupUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    map.set(uid, {
      recent7Count: Number(row?.recent7Count) || 0,
      prev7Count: Number(row?.prev7Count) || 0,
      recent30Count: Number(row?.recent30Count) || 0,
      prev30Count: Number(row?.prev30Count) || 0,
      lastAt: Number(row?.lastAt) || 0,
    });
  });
  return map;
};

const toDecline = (previousCount, recentCount) => {
  const prev = Number(previousCount) || 0;
  const recent = Number(recentCount) || 0;
  return Math.max(0, prev - recent);
};

const toDeclineRate = (previousCount, recentCount) => {
  const prev = Number(previousCount) || 0;
  if (prev <= 0) return 0;
  const decline = toDecline(prev, recentCount);
  return Math.max(0, Math.min(100, Math.round((decline / prev) * 100)));
};

const resolveTrendDirection = (previousCount, recentCount) => {
  const prev = Number(previousCount) || 0;
  const recent = Number(recentCount) || 0;
  if (recent > prev) return 'up';
  if (recent < prev) return 'down';
  return 'flat';
};

const formatReason = ({ decline7, declineRate7, decline30, declineRate30, inactive7d }) => {
  if (inactive7d) return '最近7天未互动，建议轻触达维持关系。';
  if (decline7 > 0) return `近7天互动下降 ${declineRate7}%（较上个7天周期）`;
  if (decline30 > 0) return `近30天互动下降 ${declineRate30}%（较上个30天周期）`;
  return '关系稳定，建议保持轻量沟通。';
};

const scoreItem = ({ decline7, decline30, inactive7d, windowDays }) => {
  const weighted =
    windowDays === 30 ? decline30 * 6 + decline7 * 2 : decline7 * 6 + decline30 * 2;
  const idleBoost = inactive7d ? 18 : 0;
  return weighted + idleBoost;
};

const normalizeFriendList = (user, users = []) => {
  const list = Array.isArray(user?.friends) ? user.friends : [];
  const ownUid = Number(user?.uid) || 0;
  const userMap = new Map();
  users.forEach((item) => {
    const uid = Number(item?.uid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    userMap.set(uid, item);
  });
  const result = [];
  const seen = new Set();
  list.forEach((rawUid) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0 || uid === ownUid || seen.has(uid)) return;
    const target = userMap.get(uid);
    if (!target) return;
    const mutual =
      Array.isArray(target.friends) &&
      target.friends.includes(ownUid) &&
      Array.isArray(user.friends) &&
      user.friends.includes(uid);
    if (!mutual) return;
    seen.add(uid);
    result.push({
      uid,
      title: String(target.nickname || target.username || `用户${uid}`).slice(0, 64),
      avatar: String(target.avatar || ''),
    });
  });
  return result;
};

const normalizeGroupList = (user, groups = []) => {
  const ownUid = Number(user?.uid) || 0;
  const result = [];
  const seen = new Set();
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    const id = Number(group?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
    const memberUids = Array.isArray(group?.memberUids)
      ? group.memberUids.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
      : [];
    if (!memberUids.includes(ownUid)) return;
    seen.add(id);
    result.push({
      uid: id,
      title: String(group?.name || `群聊${id}`).slice(0, 80),
      memberCount: memberUids.length,
    });
  });
  return result;
};

const buildRelationshipItem = ({
  sourceType,
  uid,
  title,
  avatar,
  memberCount = 0,
  stats,
  windows,
  windowDays,
}) => {
  const recent7 = Number(stats?.recent7Count) || 0;
  const prev7 = Number(stats?.prev7Count) || 0;
  const recent30 = Number(stats?.recent30Count) || 0;
  const prev30 = Number(stats?.prev30Count) || 0;
  const lastAt = Number(stats?.lastAt) || 0;

  const decline7 = toDecline(prev7, recent7);
  const decline30 = toDecline(prev30, recent30);
  const declineRate7 = toDeclineRate(prev7, recent7);
  const declineRate30 = toDeclineRate(prev30, recent30);
  const inactive7d = lastAt > 0 && lastAt < windows.recent7Start;
  const direction7 = resolveTrendDirection(prev7, recent7);
  const direction30 = resolveTrendDirection(prev30, recent30);
  const recommendationAction = inactive7d || recent7 === 0 ? 'greet' : 'message';
  const recommendationLabel =
    sourceType === 'group'
      ? recommendationAction === 'greet'
        ? '群里打招呼'
        : '发群消息'
      : recommendationAction === 'greet'
        ? '打招呼'
        : '发消息';
  const reason = formatReason({
    decline7,
    declineRate7,
    decline30,
    declineRate30,
    inactive7d,
  });

  const tags = [];
  if (inactive7d) tags.push('inactive_7d');
  if (decline7 > 0) tags.push('drop_7d');
  if (decline30 > 0) tags.push('drop_30d');
  if (!tags.length) tags.push('stable');

  return {
    targetUid: uid,
    targetType: sourceType,
    title,
    avatar,
    memberCount,
    score: scoreItem({ decline7, decline30, inactive7d, windowDays }),
    lastInteractionAt: lastAt > 0 ? new Date(lastAt).toISOString() : '',
    lastInteractionMs: lastAt,
    metrics: {
      recent7d: recent7,
      prev7d: prev7,
      recent30d: recent30,
      prev30d: prev30,
      decline7d: decline7,
      decline30d: decline30,
      declineRate7d: declineRate7,
      declineRate30d: declineRate30,
      direction7d: direction7,
      direction30d: direction30,
    },
    recommendation: {
      action: recommendationAction,
      label: recommendationLabel,
      reason,
    },
    tags,
  };
};

const buildRelationshipOpsSnapshot = ({
  database,
  user,
  users,
  groups,
  options = {},
  nowMs = Date.now(),
} = {}) => {
  if (!database || !user || !Number.isInteger(Number(user.uid)) || Number(user.uid) <= 0) {
    return {
      generatedAt: new Date(nowMs).toISOString(),
      scope: 'all',
      windowDays: 7,
      summary: {
        totalCandidates: 0,
        totalDeclined: 0,
        inactive7d: 0,
        privateCount: 0,
        groupCount: 0,
      },
      items: [],
    };
  }

  const normalized = normalizeOptions(options);
  const safeNowMs = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : Date.now();
  const windows = {
    recent7Start: safeNowMs - 7 * DAY_MS,
    prev7Start: safeNowMs - 14 * DAY_MS,
    recent30Start: safeNowMs - 30 * DAY_MS,
    prev30Start: safeNowMs - 60 * DAY_MS,
  };

  const friendEntries = normalized.scope === 'group' ? [] : normalizeFriendList(user, users);
  const groupEntries = normalized.scope === 'private' ? [] : normalizeGroupList(user, groups);
  const friendUids = friendEntries.map((item) => item.uid);
  const groupUids = groupEntries.map((item) => item.uid);

  const friendStatsMap = buildStatsMapForPrivate({
    database,
    viewerUid: Number(user.uid),
    friendUids,
    windows,
  });
  const groupStatsMap = buildStatsMapForGroup({
    database,
    groupIds: groupUids,
    windows,
  });

  const items = [];
  friendEntries.forEach((entry) => {
    const stats = friendStatsMap.get(entry.uid) || {};
    items.push(
      buildRelationshipItem({
        sourceType: 'private',
        uid: entry.uid,
        title: entry.title,
        avatar: entry.avatar,
        stats,
        windows,
        windowDays: normalized.windowDays,
      })
    );
  });
  groupEntries.forEach((entry) => {
    const stats = groupStatsMap.get(entry.uid) || {};
    items.push(
      buildRelationshipItem({
        sourceType: 'group',
        uid: entry.uid,
        title: entry.title,
        memberCount: entry.memberCount,
        stats,
        windows,
        windowDays: normalized.windowDays,
      })
    );
  });

  const filtered = normalized.includeStable
    ? items
    : items.filter((item) => item.tags.includes('inactive_7d') || item.tags.includes('drop_7d') || item.tags.includes('drop_30d'));
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.lastInteractionMs || 0) - (a.lastInteractionMs || 0);
  });

  const selected = filtered.slice(0, normalized.limit);
  const totalDeclined = filtered.length;
  const inactive7d = selected.filter((item) => item.tags.includes('inactive_7d')).length;
  const privateCount = selected.filter((item) => item.targetType === 'private').length;
  const groupCount = selected.filter((item) => item.targetType === 'group').length;

  return {
    generatedAt: new Date(safeNowMs).toISOString(),
    scope: normalized.scope,
    windowDays: normalized.windowDays,
    summary: {
      totalCandidates: items.length,
      totalDeclined,
      inactive7d,
      privateCount,
      groupCount,
    },
    items: selected,
  };
};

export { buildRelationshipOpsSnapshot, normalizeOptions, normalizeScope, normalizeWindowDays };
