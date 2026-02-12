/**
 * Assistant profile preference normalization helpers.
 */

const TRANSLATE_STYLE_SET = new Set(['formal', 'casual']);
const EXPLANATION_LEVEL_SET = new Set(['short', 'medium', 'detailed']);
const REPLY_STYLE_SET = new Set(['polite', 'concise', 'formal']);

const DEFAULT_ASSISTANT_PROFILE = Object.freeze({
  translateStyle: 'formal',
  explanationLevel: 'short',
  replyStyle: 'polite',
});

const toLowerText = (value) => String(value || '').trim().toLowerCase();

const normalizeTranslateStyle = (value, fallback = DEFAULT_ASSISTANT_PROFILE.translateStyle) => {
  const raw = toLowerText(value);
  if (!raw) return fallback;
  if (raw === '正式') return 'formal';
  if (raw === '口语') return 'casual';
  if (TRANSLATE_STYLE_SET.has(raw)) return raw;
  if (raw === 'colloquial') return 'casual';
  return fallback;
};

const normalizeExplanationLevel = (
  value,
  fallback = DEFAULT_ASSISTANT_PROFILE.explanationLevel
) => {
  const raw = toLowerText(value);
  if (!raw) return fallback;
  if (raw === '短' || raw === '简短' || raw === 'brief') return 'short';
  if (raw === '中' || raw === 'normal') return 'medium';
  if (raw === '长' || raw === '详细' || raw === 'long') return 'detailed';
  if (EXPLANATION_LEVEL_SET.has(raw)) return raw;
  return fallback;
};

const normalizeReplyStyle = (value, fallback = DEFAULT_ASSISTANT_PROFILE.replyStyle) => {
  const raw = toLowerText(value);
  if (!raw) return fallback;
  if (raw === '礼貌') return 'polite';
  if (raw === '简洁') return 'concise';
  if (raw === '正式') return 'formal';
  if (REPLY_STYLE_SET.has(raw)) return raw;
  return fallback;
};

const normalizeAssistantProfile = (input = {}, fallback = DEFAULT_ASSISTANT_PROFILE) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    translateStyle: normalizeTranslateStyle(source.translateStyle, fallback.translateStyle),
    explanationLevel: normalizeExplanationLevel(source.explanationLevel, fallback.explanationLevel),
    replyStyle: normalizeReplyStyle(source.replyStyle, fallback.replyStyle),
  };
};

const resolveAssistantProfileFromUser = (user) =>
  normalizeAssistantProfile(user?.assistantProfile || {}, DEFAULT_ASSISTANT_PROFILE);

const mergeAssistantProfile = (base, patch = {}) => {
  const current = normalizeAssistantProfile(base || {}, DEFAULT_ASSISTANT_PROFILE);
  return normalizeAssistantProfile(
    {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
    },
    current
  );
};

const isValidTranslateStyle = (value) => TRANSLATE_STYLE_SET.has(String(value || '').trim().toLowerCase());
const isValidExplanationLevel = (value) =>
  EXPLANATION_LEVEL_SET.has(String(value || '').trim().toLowerCase());
const isValidReplyStyle = (value) => REPLY_STYLE_SET.has(String(value || '').trim().toLowerCase());

export {
  DEFAULT_ASSISTANT_PROFILE,
  isValidExplanationLevel,
  isValidReplyStyle,
  isValidTranslateStyle,
  mergeAssistantProfile,
  normalizeAssistantProfile,
  normalizeExplanationLevel,
  normalizeReplyStyle,
  normalizeTranslateStyle,
  resolveAssistantProfileFromUser,
};
