import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';
import { API_BASE } from '../config';
import { storage } from '../storage';
import { STORAGE_KEYS } from '../constants/storageKeys';

type TranslationScreenRouteProp = RouteProp<RootStackParamList, 'Translation'>;
type TranslateStyle = 'formal' | 'casual';
type ExplanationLevel = 'short' | 'medium' | 'detailed';
type ReplyStyle = 'polite' | 'concise' | 'formal';
type TargetLang = 'zh' | 'en';

type AssistantProfile = {
  translateStyle: TranslateStyle;
  explanationLevel: ExplanationLevel;
  replyStyle: ReplyStyle;
};

type TranslateResult = {
  translated: string;
  explanation: string;
  provider: string;
  degraded: boolean;
  reason: string;
};

const STYLE_LABEL_MAP: Record<TranslateStyle, string> = {
  formal: '正式',
  casual: '口语',
};

const EXPLANATION_LABEL_MAP: Record<ExplanationLevel, string> = {
  short: '简短',
  medium: '中等',
  detailed: '详细',
};

const TARGET_LANG_LABEL_MAP: Record<TargetLang, string> = {
  zh: '中文',
  en: '英文',
};

const normalizeTranslateStyle = (value: unknown): TranslateStyle => {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'casual' ? 'casual' : 'formal';
};

const normalizeExplanationLevel = (value: unknown): ExplanationLevel => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'detailed') return 'detailed';
  if (raw === 'medium') return 'medium';
  return 'short';
};

const normalizeReplyStyle = (value: unknown): ReplyStyle => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'formal') return 'formal';
  if (raw === 'concise') return 'concise';
  return 'polite';
};

const toAuthHeaders = async (): Promise<Record<string, string>> => {
  const token = String((await storage.getString(STORAGE_KEYS.token)) || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export default function TranslationScreen() {
  const route = useRoute<TranslationScreenRouteProp>();
  const initialText = String(route.params?.textToTranslate || '').trim();

  const [inputText, setInputText] = useState(initialText);
  const [targetLang, setTargetLang] = useState<TargetLang>('zh');
  const [translateStyle, setTranslateStyle] = useState<TranslateStyle>('formal');
  const [explanationLevel, setExplanationLevel] = useState<ExplanationLevel>('short');
  const [useProfile, setUseProfile] = useState(true);
  const [persistProfile, setPersistProfile] = useState(true);

  const [profile, setProfile] = useState<AssistantProfile | null>(null);
  const [profileFeatureEnabled, setProfileFeatureEnabled] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);

  const [translateLoading, setTranslateLoading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [error, setError] = useState('');

  const canTranslate = useMemo(() => inputText.trim().length > 0 && !translateLoading, [inputText, translateLoading]);

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const headers = await toAuthHeaders();
      if (!headers.Authorization) {
        setProfile(null);
        setProfileFeatureEnabled(false);
        return;
      }
      const response = await fetch(`${API_BASE}/api/translate/profile`, {
        headers,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success || !payload?.data?.profile) {
        setProfile(null);
        setProfileFeatureEnabled(false);
        return;
      }
      const nextProfile: AssistantProfile = {
        translateStyle: normalizeTranslateStyle(payload.data.profile.translateStyle),
        explanationLevel: normalizeExplanationLevel(payload.data.profile.explanationLevel),
        replyStyle: normalizeReplyStyle(payload.data.profile.replyStyle),
      };
      setProfile(nextProfile);
      setProfileFeatureEnabled(payload?.data?.featureEnabled === true);
      setTranslateStyle(nextProfile.translateStyle);
      setExplanationLevel(nextProfile.explanationLevel);
    } catch {
      setProfile(null);
      setProfileFeatureEnabled(false);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const saveProfileToServer = useCallback(async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    setError('');
    try {
      const headers = await toAuthHeaders();
      if (!headers.Authorization) {
        setError('未登录，无法保存偏好。');
        return;
      }
      const response = await fetch(`${API_BASE}/api/translate/profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          translateStyle,
          explanationLevel,
          replyStyle: profile?.replyStyle || 'polite',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success || !payload?.data?.profile) {
        setError(String(payload?.message || '偏好保存失败，请稍后重试。'));
        return;
      }
      const nextProfile: AssistantProfile = {
        translateStyle: normalizeTranslateStyle(payload.data.profile.translateStyle),
        explanationLevel: normalizeExplanationLevel(payload.data.profile.explanationLevel),
        replyStyle: normalizeReplyStyle(payload.data.profile.replyStyle),
      };
      setProfile(nextProfile);
      setProfileFeatureEnabled(payload?.data?.featureEnabled === true);
    } catch {
      setError('偏好保存失败，请检查网络后重试。');
    } finally {
      setSavingProfile(false);
    }
  }, [explanationLevel, profile?.replyStyle, savingProfile, translateStyle]);

  const requestTranslate = useCallback(async () => {
    const text = inputText.trim();
    if (!text || translateLoading) return;
    setTranslateLoading(true);
    setError('');
    try {
      const headers = await toAuthHeaders();
      const response = await fetch(`${API_BASE}/api/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          text,
          sourceLang: 'auto',
          targetLang,
          style: translateStyle,
          explanationLevel,
          useProfile,
          persistProfile,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.success) {
        setError(String(payload?.message || '翻译失败，请稍后重试。'));
        return;
      }
      const nextResult: TranslateResult = {
        translated: String(payload?.translated || payload?.data?.translated || ''),
        explanation: String(payload?.explanation || payload?.data?.explanation || ''),
        provider: String(payload?.data?.provider || ''),
        degraded: payload?.data?.degraded === true,
        reason: String(payload?.data?.reason || ''),
      };
      setResult(nextResult);

      if (payload?.data?.profile && typeof payload.data.profile === 'object') {
        const nextProfile: AssistantProfile = {
          translateStyle: normalizeTranslateStyle(payload.data.profile.translateStyle),
          explanationLevel: normalizeExplanationLevel(payload.data.profile.explanationLevel),
          replyStyle: normalizeReplyStyle(payload.data.profile.replyStyle),
        };
        setProfile(nextProfile);
      }

      if (payload?.data?.featureEnabled != null) {
        setProfileFeatureEnabled(payload.data.featureEnabled === true);
      }
    } catch {
      setError('翻译失败，请检查网络后重试。');
    } finally {
      setTranslateLoading(false);
    }
  }, [explanationLevel, inputText, persistProfile, targetLang, translateLoading, translateStyle, useProfile]);

  useEffect(() => {
    loadProfile().catch(() => undefined);
  }, [loadProfile]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.block}>
        <Text style={styles.blockTitle}>源文本</Text>
        <View style={styles.card}>
          <TextInput
            multiline
            value={inputText}
            onChangeText={setInputText}
            placeholder="输入要翻译的文本..."
            placeholderTextColor="#9aa5b1"
            style={styles.textInput}
          />
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>翻译设置</Text>
        <View style={styles.card}>
          <Text style={styles.rowLabel}>目标语言</Text>
          <View style={styles.chipRow}>
            {(Object.keys(TARGET_LANG_LABEL_MAP) as TargetLang[]).map((lang) => {
              const active = targetLang === lang;
              return (
                <Pressable
                  key={`target-${lang}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setTargetLang(lang)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {TARGET_LANG_LABEL_MAP[lang]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.rowLabel}>表达风格</Text>
          <View style={styles.chipRow}>
            {(Object.keys(STYLE_LABEL_MAP) as TranslateStyle[]).map((styleOption) => {
              const active = translateStyle === styleOption;
              return (
                <Pressable
                  key={`style-${styleOption}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setTranslateStyle(styleOption)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {STYLE_LABEL_MAP[styleOption]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.rowLabel}>解释长度</Text>
          <View style={styles.chipRow}>
            {(Object.keys(EXPLANATION_LABEL_MAP) as ExplanationLevel[]).map((level) => {
              const active = explanationLevel === level;
              return (
                <Pressable
                  key={`level-${level}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setExplanationLevel(level)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {EXPLANATION_LABEL_MAP[level]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.toggleRow}>
            <Pressable
              style={[styles.toggleChip, useProfile && styles.toggleChipActive]}
              onPress={() => setUseProfile((prev) => !prev)}
            >
              <Text style={[styles.toggleChipText, useProfile && styles.toggleChipTextActive]}>
                {useProfile ? '已启用: 跟随偏好' : '未启用: 跟随偏好'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.toggleChip, persistProfile && styles.toggleChipActive]}
              onPress={() => setPersistProfile((prev) => !prev)}
            >
              <Text style={[styles.toggleChipText, persistProfile && styles.toggleChipTextActive]}>
                {persistProfile ? '已启用: 写入偏好' : '未启用: 写入偏好'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              style={[styles.primaryBtn, !canTranslate && styles.primaryBtnDisabled]}
              onPress={requestTranslate}
              disabled={!canTranslate}
            >
              <Text style={styles.primaryBtnText}>{translateLoading ? '翻译中...' : '立即翻译'}</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryBtn, savingProfile && styles.secondaryBtnDisabled]}
              onPress={saveProfileToServer}
              disabled={savingProfile}
            >
              <Text style={styles.secondaryBtnText}>{savingProfile ? '保存中...' : '保存当前偏好'}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>当前默认偏好</Text>
        <View style={styles.card}>
          {profileLoading ? (
            <ActivityIndicator size="small" color="#2f7fd7" />
          ) : profile ? (
            <>
              <Text style={styles.profileLine}>翻译风格: {STYLE_LABEL_MAP[profile.translateStyle]}</Text>
              <Text style={styles.profileLine}>解释长度: {EXPLANATION_LABEL_MAP[profile.explanationLevel]}</Text>
              <Text style={styles.profileLine}>回复风格: {profile.replyStyle}</Text>
              <Text style={styles.profileHint}>
                个性化开关: {profileFeatureEnabled ? '已启用' : '未启用'}
              </Text>
            </>
          ) : (
            <Text style={styles.profileHint}>未读取到已登录用户偏好。</Text>
          )}
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>翻译结果</Text>
        <View style={styles.card}>
          {translateLoading ? (
            <ActivityIndicator size="large" color="#2f7fd7" />
          ) : result ? (
            <>
              <Text style={styles.resultText}>{result.translated || '暂无翻译结果'}</Text>
              {result.explanation ? <Text style={styles.explanationText}>{result.explanation}</Text> : null}
              <Text style={styles.metaText}>
                provider: {result.provider || 'unknown'}{result.degraded ? ' · degraded' : ''}
              </Text>
              {result.reason ? <Text style={styles.metaText}>reason: {result.reason}</Text> : null}
            </>
          ) : (
            <Text style={styles.profileHint}>尚未执行翻译。</Text>
          )}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f3f6fb',
  },
  content: {
    padding: 14,
    paddingBottom: 26,
    gap: 14,
  },
  block: {
    gap: 8,
  },
  blockTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#26364b',
  },
  card: {
    borderWidth: 1,
    borderColor: '#e2e9f3',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
  },
  textInput: {
    minHeight: 98,
    maxHeight: 210,
    fontSize: 15,
    lineHeight: 21,
    color: '#223548',
    textAlignVertical: 'top',
    padding: 0,
  },
  rowLabel: {
    marginTop: 6,
    marginBottom: 6,
    fontSize: 12,
    color: '#54667d',
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#d2deee',
    backgroundColor: '#f8fbff',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    borderColor: '#4e94eb',
    backgroundColor: '#eaf3ff',
  },
  chipText: {
    fontSize: 12,
    color: '#4c6078',
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#1f67c1',
    fontWeight: '700',
  },
  toggleRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  toggleChip: {
    borderWidth: 1,
    borderColor: '#d8e2ef',
    borderRadius: 12,
    backgroundColor: '#fff',
    minHeight: 28,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleChipActive: {
    borderColor: '#49a772',
    backgroundColor: '#ecf9f1',
  },
  toggleChipText: {
    fontSize: 11,
    color: '#5c718a',
    fontWeight: '500',
  },
  toggleChipTextActive: {
    color: '#2c8b58',
    fontWeight: '700',
  },
  actionRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  primaryBtn: {
    minHeight: 36,
    borderRadius: 10,
    backgroundColor: '#2f7fd7',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryBtn: {
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd8eb',
    backgroundColor: '#f8fbff',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnDisabled: {
    opacity: 0.6,
  },
  secondaryBtnText: {
    color: '#406184',
    fontSize: 13,
    fontWeight: '700',
  },
  profileLine: {
    fontSize: 13,
    color: '#2e435a',
    marginBottom: 6,
  },
  profileHint: {
    fontSize: 12,
    color: '#74859a',
  },
  resultText: {
    fontSize: 16,
    lineHeight: 23,
    color: '#203347',
    fontWeight: '600',
  },
  explanationText: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: '#4b5f77',
  },
  metaText: {
    marginTop: 8,
    fontSize: 11,
    color: '#79889a',
  },
  errorText: {
    marginTop: 10,
    color: '#c3302f',
    fontSize: 12,
    fontWeight: '600',
  },
});
