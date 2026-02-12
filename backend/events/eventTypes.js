/**
 * Shared event type and payload normalization helpers.
 */

const EVENT_TYPES = Object.freeze([
  'impression',
  'click',
  'reply',
  'mute',
  'report',
  'risk_hit',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

const sanitizeText = (value, maxLength = 240) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

const sanitizeArray = (value, { maxItems = 8, maxItemLength = 120 } = {}) => {
  const source = Array.isArray(value) ? value : [];
  const list = [];
  const seen = new Set();
  for (const entry of source) {
    const safe = sanitizeText(String(entry || ''), maxItemLength);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    list.push(safe);
    if (list.length >= maxItems) break;
  }
  return list;
};

const normalizeEventType = (value) => {
  const eventType = sanitizeText(String(value || ''), 32).toLowerCase();
  return EVENT_TYPE_SET.has(eventType) ? eventType : '';
};

const isAllowedEventType = (value) => normalizeEventType(value) !== '';

export { EVENT_TYPES, isAllowedEventType, normalizeEventType, sanitizeArray, sanitizeText };

