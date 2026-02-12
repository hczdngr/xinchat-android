/**
 * Feature construction for recommendation scoring.
 * Keeps feature values bounded so online updates stay stable.
 */

const MAX_AGE_HOURS = 24 * 30;

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const sanitizeToken = (value, fallback = 'unknown') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .slice(0, 120) || fallback;

const buildCandidateId = (candidate = {}) => {
  const targetType = sanitizeToken(candidate?.targetType || 'private', 'private');
  const targetUid = Math.max(0, Math.floor(Number(candidate?.uid || candidate?.targetUid || 0)));
  return `${targetType}:${targetUid}`;
};

const buildCandidateFeatures = ({ candidate = {}, nowMs = Date.now(), position = 0 } = {}) => {
  const latestCreatedAtMs =
    Number(candidate?.latest?.createdAtMs) ||
    Number(candidate?.latest?.createdAt) ||
    Number(candidate?.latestCreatedAtMs) ||
    0;
  const ageHours = latestCreatedAtMs > 0 ? clampNumber((nowMs - latestCreatedAtMs) / 3_600_000, 0, MAX_AGE_HOURS, MAX_AGE_HOURS) : MAX_AGE_HOURS;
  const unread = clampNumber(candidate?.unread, 0, 999, 0);
  const isGroup = String(candidate?.targetType || '').trim().toLowerCase() === 'group' ? 1 : 0;
  const memberCount = clampNumber(candidate?.group?.memberUids?.length || candidate?.group?.memberCount, 0, 3000, 0);

  return {
    unreadNorm: clampNumber(unread / 20, 0, 4, 0),
    recencyNorm: clampNumber((MAX_AGE_HOURS - ageHours) / MAX_AGE_HOURS, 0, 1, 0),
    ageHoursNorm: clampNumber(ageHours / MAX_AGE_HOURS, 0, 1, 1),
    isGroup,
    isPrivate: isGroup ? 0 : 1,
    memberNorm: clampNumber(memberCount / 120, 0, 8, 0),
    positionNorm: clampNumber(position / 100, 0, 1, 0),
  };
};

const buildBaseScore = (features = {}) => {
  const unread = clampNumber(features.unreadNorm, 0, 4, 0);
  const recency = clampNumber(features.recencyNorm, 0, 1, 0);
  const age = clampNumber(features.ageHoursNorm, 0, 1, 1);
  const isGroup = clampNumber(features.isGroup, 0, 1, 0);
  const member = clampNumber(features.memberNorm, 0, 8, 0);
  const position = clampNumber(features.positionNorm, 0, 1, 0);

  return (
    unread * 0.44 +
    recency * 0.27 +
    (1 - age) * 0.12 +
    isGroup * 0.03 +
    member * 0.02 -
    position * 0.08
  );
};

const buildVwLine = ({ shared = {}, action = {}, label }) => {
  const sharedTokens = Object.entries(shared)
    .map(([key, value]) => `${sanitizeToken(key)}:${clampNumber(value, -1000, 1000, 0).toFixed(6)}`)
    .join(' ');
  const actionTokens = Object.entries(action)
    .map(([key, value]) => `${sanitizeToken(key)}:${clampNumber(value, -1000, 1000, 0).toFixed(6)}`)
    .join(' ');
  const prefix = typeof label === 'number' && Number.isFinite(label) ? `${label} ` : '';
  return `${prefix}|u ${sharedTokens} |a ${actionTokens}`.trim();
};

const buildSharedContextFeatures = ({ uid = 0, hourOfDay = null } = {}) => ({
  uid_hash: clampNumber((Number(uid) % 997) / 997, 0, 1, 0),
  hour: clampNumber((hourOfDay == null ? new Date().getHours() : Number(hourOfDay)) / 23, 0, 1, 0),
});

export {
  buildBaseScore,
  buildCandidateFeatures,
  buildCandidateId,
  buildSharedContextFeatures,
  buildVwLine,
  sanitizeToken,
};

