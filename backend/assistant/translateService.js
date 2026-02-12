/**
 * Translation orchestration with profile personalization and graceful fallback.
 */

import { createLibreTranslateClient } from './libreTranslateClient.js';
import { createGoogleTranslateFallbackClient } from './googleTranslateFallbackClient.js';
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
  provider,
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
  const providerText =
    String(provider || '').toLowerCase() === 'google_translate_web'
      ? 'Google Translate Web'
      : 'LibreTranslate';

  if (degraded) {
    return `翻译服务暂不可用，已返回降级结果（${reason || 'service_unavailable'}）。`;
  }
  if (safeLevel === 'short') {
    return `已按${styleText}翻译。`;
  }
  if (safeLevel === 'medium') {
    return `本次使用 ${providerText} 完成翻译，并按${styleText}做了轻量语气调整。`;
  }
  return `本次翻译通过 ${providerText} 完成，。输出阶段根据用户偏好应用了${styleText}规则。`;
};

const translateWithPersonalization = async ({
  text,
  sourceLang = 'auto',
  targetLang = 'zh',
  style = DEFAULT_ASSISTANT_PROFILE.translateStyle,
  explanationLevel = DEFAULT_ASSISTANT_PROFILE.explanationLevel,
  client,
  fallbackClient,
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
  const webFallbackEnabled = String(process.env.TRANSLATE_WEB_FALLBACK_ENABLED || 'true')
    .trim()
    .toLowerCase() !== 'false';
  const localFallbackClient = fallbackClient || createGoogleTranslateFallbackClient();

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
        provider: 'libretranslate',
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
    if (webFallbackEnabled) {
      try {
        const webResult = await localFallbackClient.translate({
          text: safeText,
          source: safeSource,
          target: safeTarget,
        });
        const translated = applyStyleAdjustments(webResult.translatedText, safeStyle);
        return {
          translated,
          explanation: buildExplanation({
            style: safeStyle,
            explanationLevel: safeLevel,
            sourceLang: safeSource,
            targetLang: safeTarget,
            provider: 'google_translate_web',
            degraded: false,
          }),
          degraded: false,
          reason: '',
          provider: 'google_translate_web',
          attempts: Number(webResult?.attempts) || 1,
          detectedLanguage: String(webResult?.detectedLanguage || '').trim(),
          style: safeStyle,
          explanationLevel: safeLevel,
          sourceLang: safeSource,
          targetLang: safeTarget,
        };
      } catch (webError) {
        const reason = webError?.message
          ? String(webError.message)
          : error?.message
            ? String(error.message)
            : 'service_unavailable';
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
    }
    const reason = error?.message ? String(error.message) : 'service_unavailable';
    return {
      translated: safeText,
      explanation: buildExplanation({
        style: safeStyle,
        explanationLevel: safeLevel,
        sourceLang: safeSource,
        targetLang: safeTarget,
        provider: 'fallback',
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
