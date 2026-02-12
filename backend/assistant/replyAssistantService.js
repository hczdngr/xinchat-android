/**
 * Reply assistant service.
 * - Gemini 3 Flash first, with local fallback.
 * - Prompt includes insight profile context from user.aiProfile.analysis.
 * - Keeps output contract stable: 3 suggestions with style/confidence/reason.
 */

import { parseBooleanEnv } from '../featureFlags.js';
import { getRecoUserPersona } from '../reco/index.js';
import { normalizeReplyStyle, resolveAssistantProfileFromUser } from './preferences.js';

const STYLE_LIST = ['polite', 'concise', 'formal'];
const INTENT_LIST = ['question', 'gratitude', 'urgent', 'general'];

const GEMINI_DEFAULT_REPLY_MODEL = 'gemini-3-flash-preview';
const GEMINI_REPLY_FALLBACK_MODELS = [
  GEMINI_DEFAULT_REPLY_MODEL,
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3-pro-preview',
];
const HARDCODED_GEMINI_API_KEY_B64 =
  'QUl6YVN5QV81RndRNWFwZlpseG9kdHhRakRNNk92dlNYRFAwZURv';

const toPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
};

const REPLY_GEMINI_TIMEOUT_MS = toPositiveInt(process.env.REPLY_ASSISTANT_GEMINI_TIMEOUT_MS, 12000, 1000);
const REPLY_GEMINI_MAX_CHARS = toPositiveInt(process.env.REPLY_ASSISTANT_MAX_INPUT_CHARS, 300, 60);
const REPLY_GEMINI_ENABLED = parseBooleanEnv(process.env.REPLY_ASSISTANT_USE_GEMINI, true);

const decodeHardcodedGeminiKey = () => {
  try {
    return Buffer.from(HARDCODED_GEMINI_API_KEY_B64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
};

const TEMPLATE_MAP = {
  polite: {
    question: [
      '我明白了，我先确认一下，稍后回复你。',
      '收到你的问题，我核实后第一时间回你。',
      '好的，我先看下具体情况，马上给你答复。',
    ],
    gratitude: [
      '不客气，有需要你随时说。',
      '收到，谢谢你的反馈，我会继续跟进。',
      '没问题，感谢你及时更新信息。',
    ],
    urgent: [
      '收到，这件事我现在优先处理。',
      '明白，我马上跟进并及时同步进展。',
      '已收到提醒，我这边立即处理。',
    ],
    general: [
      '收到，我先看一下，稍后回复你。',
      '明白了，我这边正在跟进。',
      '好的，有进展我会马上告诉你。',
    ],
  },
  concise: {
    question: ['收到，稍后确认。', '看到了，马上回你。', '明白，我先处理。'],
    gratitude: ['不客气。', '收到。', '随时联系。'],
    urgent: ['马上处理。', '已提优先级。', '已看到，正在跟进。'],
    general: ['收到。', '明白。', '稍后回复。'],
  },
  formal: {
    question: [
      '已收到你的问题，我会核实后尽快回复。',
      '感谢你的说明，我确认后会及时反馈。',
      '你的请求我已收到，处理后会第一时间同步。',
    ],
    gratitude: [
      '感谢你的反馈，后续如有需要可随时联系。',
      '感谢支持，我会持续跟进该事项。',
      '已知悉，后续进展会及时同步给你。',
    ],
    urgent: [
      '已知悉，该事项将立即优先处理。',
      '明白，我会加快处理并及时反馈结果。',
      '感谢提醒，我已将此任务提升为优先级。',
    ],
    general: [
      '消息已收到，我会尽快处理并回复。',
      '已记录，我会按计划推进并同步进展。',
      '已知悉，处理后将及时向你反馈。',
    ],
  },
};

const clampCount = (value, fallback = 3) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(parsed, 3));
};

const clampConfidence = (value, fallback = 0.7) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return Number(parsed.toFixed(2));
};

const toShortText = (value, max = 120) => {
  const safe = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safe) return '';
  return safe.length > max ? `${safe.slice(0, max)}...` : safe;
};

const toNameWithConfidence = (item) => {
  if (typeof item === 'string') {
    return toShortText(item, 60);
  }
  const name = toShortText(item?.name || item?.trait || item?.topic || '', 60);
  if (!name) return '';
  const confidence = Number(item?.confidence);
  if (!Number.isFinite(confidence)) return name;
  return `${name}(${Math.max(0, Math.min(confidence, 1)).toFixed(2)})`;
};

const detectIntent = (text) => {
  const safe = String(text || '').trim();
  if (!safe) return 'general';

  const lower = safe.toLowerCase();
  const hasQuestion =
    /[?？]/.test(safe) ||
    /\b(what|why|how|when|where|who|can|could|would|do you|is it)\b/.test(lower) ||
    /(吗|么|如何|怎么|啥|什么|能不能|可不可以)/.test(safe);
  if (hasQuestion) return 'question';

  const hasGratitude = /\b(thanks|thank you|appreciate)\b/.test(lower) || /(谢谢|感谢|多谢)/.test(safe);
  if (hasGratitude) return 'gratitude';

  const hasUrgency =
    /\b(urgent|asap|immediately|right away|priority)\b/.test(lower) ||
    /(紧急|马上|立刻|尽快|火急)/.test(safe);
  if (hasUrgency) return 'urgent';

  return 'general';
};

const buildReason = (intent, style) => {
  const intentReasonMap = {
    question: '检测到对方在提问，建议先确认再反馈。',
    gratitude: '检测到感谢语气，建议保持积极友好回应。',
    urgent: '检测到紧急语义，建议直接给出处理动作。',
    general: '普通聊天语境，建议给出清晰可执行回复。',
  };
  const styleReasonMap = {
    polite: '语气采用礼貌风格。',
    concise: '语气采用简洁风格。',
    formal: '语气采用正式风格。',
  };
  return `${intentReasonMap[intent] || intentReasonMap.general} ${styleReasonMap[style] || ''}`.trim();
};

const buildStyleSequence = ({ requestedStyle = '', fallbackStyle = '', count = 3 }) => {
  const normalized = normalizeReplyStyle(requestedStyle, '');
  if (normalized) {
    return Array.from({ length: count }, () => normalized);
  }
  const fallback = normalizeReplyStyle(fallbackStyle, '');
  if (fallback) {
    return Array.from({ length: count }, () => fallback);
  }
  return Array.from({ length: count }, (_, index) => STYLE_LIST[index % STYLE_LIST.length]);
};

const extractGeminiText = (payload) => {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const merged = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (merged) return merged;
  }
  return '';
};

const parseModelJson = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const noFence = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(noFence);
  if (direct && typeof direct === 'object') return direct;
  if (typeof direct === 'string') {
    const nested = tryParse(direct);
    if (nested && typeof nested === 'object') return nested;
  }

  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = noFence.slice(start, end + 1);
    const parsed = tryParse(sliced);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
};

const normalizeReason = (value, fallback = '') => {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  return safe ? safe.slice(0, 220) : fallback;
};

const normalizeSuggestionText = (value) => {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  return safe.slice(0, 120);
};

const normalizeIntent = (value, fallback = 'general') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (INTENT_LIST.includes(normalized)) return normalized;
  return fallback;
};

const buildPersonaContext = ({ user, recoPersona = null } = {}) => {
  const analysis = user?.aiProfile?.analysis && typeof user.aiProfile.analysis === 'object'
    ? user.aiProfile.analysis
    : {};
  const depression = analysis?.depressionTendency && typeof analysis.depressionTendency === 'object'
    ? analysis.depressionTendency
    : {};
  const preferences = (Array.isArray(analysis.preferences) ? analysis.preferences : [])
    .map(toNameWithConfidence)
    .filter(Boolean)
    .slice(0, 6);
  const traits = (Array.isArray(analysis.personalityTraits) ? analysis.personalityTraits : [])
    .map(toNameWithConfidence)
    .filter(Boolean)
    .slice(0, 6);
  const riskSignals = (Array.isArray(analysis.riskSignals) ? analysis.riskSignals : [])
    .map((item) => toShortText(item, 80))
    .filter(Boolean)
    .slice(0, 5);
  const recoTags = (Array.isArray(recoPersona?.personalizedTags) ? recoPersona.personalizedTags : [])
    .map((item) => toShortText(item, 60))
    .filter(Boolean)
    .slice(0, 8);

  const lines = [
    `profile_summary: ${toShortText(analysis.profileSummary || '', 420) || 'none'}`,
    `preferred_communication: ${toShortText(analysis.suggestedCommunicationStyle || '', 220) || 'none'}`,
    `preferences: ${preferences.join('; ') || 'none'}`,
    `traits: ${traits.join('; ') || 'none'}`,
    `risk_level: ${toShortText(depression.level || 'unknown', 20) || 'unknown'}`,
    `risk_reason: ${toShortText(depression.reason || '', 200) || 'none'}`,
    `risk_signals: ${riskSignals.join('; ') || 'none'}`,
    `vw_persona_tags: ${recoTags.join('; ') || 'none'}`,
  ];
  return lines.join('\n');
};

const buildGeminiPrompt = ({ text, styleSequence, profile, personaContext }) => {
  const stylesLine = styleSequence.join(', ');
  const preferredStyle = normalizeReplyStyle(profile?.replyStyle, 'polite');
  const preferredTranslateStyle = toShortText(profile?.translateStyle || '', 20) || 'none';
  const explanationLevel = toShortText(profile?.explanationLevel || '', 20) || 'none';

  return `
你是社交聊天产品的“回复助手”。
请严格输出 JSON，不要输出 markdown。

任务要求：
1) 生成 ${styleSequence.length} 条可直接发送的回复建议。
2) 建议风格顺序必须是：[${stylesLine}]。
3) 每条建议必须使用中文，简洁、自然、贴合上下文。
4) 结合用户画像与 VW 偏好标签，自动匹配语气。
5) 不要输出 JSON 以外的任何内容。

输出 JSON 结构：
{
  "intent": "question|gratitude|urgent|general",
  "suggestions": [
    {
      "text": "string",
      "style": "polite|concise|formal",
      "confidence": 0.0,
      "reason": "string"
    }
  ]
}

用户偏好上下文：
- preferred_reply_style: ${preferredStyle}
- preferred_translate_style: ${preferredTranslateStyle}
- explanation_level: ${explanationLevel}

画像与行为上下文：
${personaContext}

对方最后一条消息：
${text}
`.trim();
};

const buildModelCandidates = (requestedModel = '') => {
  const envModels = String(process.env.GEMINI_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(
    new Set([requestedModel, ...envModels, ...GEMINI_REPLY_FALLBACK_MODELS].filter(Boolean))
  );
};

const callGeminiForReply = async ({ apiKey, prompt, requestedModel }) => {
  const models = buildModelCandidates(requestedModel);
  let lastError = null;
  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(REPLY_GEMINI_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `Gemini 请求失败（${response.status}）`);
        error.status = response.status;
        lastError = error;
        continue;
      }
      const text = extractGeminiText(payload);
      const parsed = parseModelJson(text);
      if (!parsed || typeof parsed !== 'object') {
        lastError = new Error('Gemini 返回了无效 JSON');
        continue;
      }
      return { model, payload: parsed };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Gemini 回复助手暂不可用');
};

const buildLocalSuggestionBundle = ({ text, intent, sequence, profile }) => {
  const usageCounter = {
    polite: 0,
    concise: 0,
    formal: 0,
  };

  const suggestions = sequence.map((style, index) => {
    const pool =
      TEMPLATE_MAP[style]?.[intent] ||
      TEMPLATE_MAP[style]?.general ||
      TEMPLATE_MAP.polite.general;
    const useIndex = usageCounter[style] || 0;
    usageCounter[style] = useIndex + 1;
    const template = pool[useIndex % pool.length] || pool[0];
    return {
      id: `${style}-${index + 1}`,
      text: template,
      style,
      confidence: Number((0.78 + (style === 'formal' ? 0.03 : 0) - index * 0.03).toFixed(2)),
      reason: buildReason(intent, style),
    };
  });

  return {
    model: 'local-template-v1',
    intent,
    suggestions,
    count: suggestions.length,
    generatedAt: new Date().toISOString(),
    styleMode: sequence.every((item) => item === sequence[0]) ? 'single' : 'mixed',
    profile,
    degraded: false,
    reason: '',
    source: 'local',
    inputPreview: String(text || '').slice(0, 80),
  };
};

const normalizeGeminiSuggestions = ({ payload, sequence, localFallback }) => {
  const safeIntent = normalizeIntent(payload?.intent, localFallback.intent);
  const list = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
  const next = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const expectedStyle = sequence[index];
    const item = list[index] && typeof list[index] === 'object' ? list[index] : {};
    const text = normalizeSuggestionText(item.text);

    if (!text) {
      next.push(localFallback.suggestions[index]);
      continue;
    }

    const style = normalizeReplyStyle(item.style, expectedStyle);
    next.push({
      id: `${style}-${index + 1}`,
      text,
      style,
      confidence: clampConfidence(item.confidence, localFallback.suggestions[index].confidence),
      reason: normalizeReason(item.reason, buildReason(safeIntent, style)),
    });
  }

  return {
    intent: safeIntent,
    suggestions: next,
  };
};

const generateReplySuggestions = async ({
  text,
  user,
  requestedStyle = '',
  count = 3,
} = {}) => {
  const safeText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, REPLY_GEMINI_MAX_CHARS);
  const profile = resolveAssistantProfileFromUser(user);
  const fallbackStyle = profile.replyStyle;
  const styleForSingle = normalizeReplyStyle(requestedStyle, fallbackStyle);
  const safeCount = clampCount(count, 3);
  const sequence = buildStyleSequence({
    requestedStyle,
    fallbackStyle: styleForSingle,
    count: safeCount,
  });
  const intent = detectIntent(safeText);

  const localBundle = buildLocalSuggestionBundle({
    text: safeText,
    intent,
    sequence,
    profile,
  });
  const safeUid = Number(user?.uid) || 0;
  let recoPersona = null;
  if (safeUid > 0) {
    try {
      recoPersona = await getRecoUserPersona(safeUid);
    } catch {
      recoPersona = null;
    }
  }

  const apiKey = String(process.env.GEMINI_API_KEY || decodeHardcodedGeminiKey()).trim();
  if (!REPLY_GEMINI_ENABLED || !apiKey || !safeText) {
    return {
      ...localBundle,
      degraded: REPLY_GEMINI_ENABLED && !apiKey,
      reason: REPLY_GEMINI_ENABLED && !apiKey ? '未配置 Gemini 密钥，已使用本地建议。' : '',
    };
  }

  const requestedModel = String(
    process.env.GEMINI_REPLY_ASSISTANT_MODEL ||
      process.env.GEMINI_DEFAULT_MODEL ||
      GEMINI_DEFAULT_REPLY_MODEL
  ).trim();
  const prompt = buildGeminiPrompt({
    text: safeText,
    styleSequence: sequence,
    profile,
    personaContext: buildPersonaContext({ user, recoPersona }),
  });

  try {
    const modelResult = await callGeminiForReply({
      apiKey,
      prompt,
      requestedModel,
    });
    const normalized = normalizeGeminiSuggestions({
      payload: modelResult.payload,
      sequence,
      localFallback: localBundle,
    });
    return {
      ...localBundle,
      model: `gemini:${modelResult.model}`,
      intent: normalized.intent,
      suggestions: normalized.suggestions,
      source: 'gemini',
      degraded: false,
      reason: '',
    };
  } catch (error) {
    return {
      ...localBundle,
      degraded: true,
      reason: String(error?.message || 'Gemini 服务暂不可用，已切换本地建议。'),
    };
  }
};

export { generateReplySuggestions };
