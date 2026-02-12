/**
 * Translation orchestration with profile personalization and graceful fallback.
 */

import { createLibreTranslateClient } from './libreTranslateClient.js';
import {
  DEFAULT_ASSISTANT_PROFILE,
  normalizeExplanationLevel,
  normalizeTranslateStyle,
} from './preferences.js';

const keepSentencePunctuation = (text) => {
  const safe = String(text || '').trim();
  if (!safe) return safe;
  if (/[.!?。！？]$/.test(safe)) return safe;
  return `${safe}.`;
};

const applyCasualStyle = (text) => String(text || '').replace(/\bplease\b/gi, '').trim();

const applyFormalStyle = (text) => {
  const safe = String(text || '').trim();
  if (!safe) return safe;
  return keepSentencePunctuation(safe.replace(/\byou\b/gi, 'you'));
};

const applyStyleAdjustments = (text, style) => {
  const safeStyle = normalizeTranslateStyle(style, DEFAULT_ASSISTANT_PROFILE.translateStyle);
  if (safeStyle === 'casual') {
    return applyCasualStyle(text);
  }
  return applyFormalStyle(text);
};

const buildExplanation = ({
  style,
  explanationLevel,
  sourceLang,
  targetLang,
  degraded,
  reason,
}) => {
  const safeStyle = normalizeTranslateStyle(style, DEFAULT_ASSISTANT_PROFILE.translateStyle);
  const safeLevel = normalizeExplanationLevel(
    explanationLevel,
    DEFAULT_ASSISTANT_PROFILE.explanationLevel
  );
  const styleText = safeStyle === 'formal' ? '正式风格' : '口语风格';
  const pairText = `${sourceLang || 'auto'} -> ${targetLang || 'zh'}`;

  if (degraded) {
    return `翻译服务暂不可用，已返回降级结果（${reason || 'service_unavailable'}）。`;
  }
  if (safeLevel === 'short') {
    return `已按${styleText}翻译（${pairText}）。`;
  }
  if (safeLevel === 'medium') {
    return `本次使用 LibreTranslate 完成 ${pairText} 翻译，并按${styleText}做了轻量语气调整。`;
  }
  return `本次翻译通过本地 LibreTranslate 完成，语言方向为 ${pairText}。输出阶段根据用户偏好应用了${styleText}规则（例如语气词精简与句尾规范化），以保证表达一致。`;
};

const translateWithPersonalization = async ({
  text,
  sourceLang = 'auto',
  targetLang = 'zh',
  style = DEFAULT_ASSISTANT_PROFILE.translateStyle,
  explanationLevel = DEFAULT_ASSISTANT_PROFILE.explanationLevel,
  client,
}) => {
  const safeText = String(text || '').trim();
  if (!safeText) {
    throw new Error('text is required');
  }
  const safeStyle = normalizeTranslateStyle(style, DEFAULT_ASSISTANT_PROFILE.translateStyle);
  const safeLevel = normalizeExplanationLevel(
    explanationLevel,
    DEFAULT_ASSISTANT_PROFILE.explanationLevel
  );
  const safeSource = String(sourceLang || 'auto').trim() || 'auto';
  const safeTarget = String(targetLang || 'zh').trim() || 'zh';
  const localClient = client || createLibreTranslateClient();

  try {
    const result = await localClient.translate({
      text: safeText,
      source: safeSource,
      target: safeTarget,
      format: 'text',
    });
    const translated = applyStyleAdjustments(result.translatedText, safeStyle);
    return {
      translated,
      explanation: buildExplanation({
        style: safeStyle,
        explanationLevel: safeLevel,
        sourceLang: safeSource,
        targetLang: safeTarget,
        degraded: false,
      }),
      degraded: false,
      reason: '',
      provider: 'libretranslate',
      attempts: Number(result?.attempts) || 1,
      detectedLanguage: String(result?.detectedLanguage || '').trim(),
      style: safeStyle,
      explanationLevel: safeLevel,
      sourceLang: safeSource,
      targetLang: safeTarget,
    };
  } catch (error) {
    const reason = error?.message ? String(error.message) : 'service_unavailable';
    return {
      translated: safeText,
      explanation: buildExplanation({
        style: safeStyle,
        explanationLevel: safeLevel,
        sourceLang: safeSource,
        targetLang: safeTarget,
        degraded: true,
        reason,
      }),
      degraded: true,
      reason,
      provider: 'fallback',
      attempts: 0,
      detectedLanguage: '',
      style: safeStyle,
      explanationLevel: safeLevel,
      sourceLang: safeSource,
      targetLang: safeTarget,
    };
  }
};

export { translateWithPersonalization };
