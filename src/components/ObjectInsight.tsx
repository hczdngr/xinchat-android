import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { ObjectInsightRoute, RootNavigation } from '../navigation/types';
import { storage } from '../storage';
import { normalizeObjectDetectPayload } from '../utils/objectDetectNormalize';

type EncyclopediaData = {
  query?: string;
  title?: string;
  summary?: string;
  snippet?: string;
  url?: string;
  thumbnail?: string;
  source?: string;
};

const toQueryFromPayload = (value: string) => {
  const payload = normalizeObjectDetectPayload(value);
  const firstObject = String(payload.objects?.[0]?.name || '').trim();
  if (firstObject) return firstObject;
  const summary = String(payload.summary || '')
    .replace(/[.!?].*$/, '')
    .trim();
  if (summary && summary !== value) return summary.slice(0, 48);
  return value;
};

export default function ObjectInsight() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<ObjectInsightRoute>();
  const insets = useSafeAreaInsets();

  const rawQuery = String(route.params?.query || '')
    .replace(/\s+/g, ' ')
    .trim();
  const query = useMemo(() => toQueryFromPayload(rawQuery), [rawQuery]);
  const imageUri = String(route.params?.imageUri || '').trim();
  const normalizedDetect = useMemo(
    () =>
      normalizeObjectDetectPayload({
        summary: route.params?.detectSummary,
        scene: route.params?.detectScene,
        objects: route.params?.detectObjects,
      }),
    [route.params?.detectSummary, route.params?.detectScene, route.params?.detectObjects]
  );
  const detectSummary = String(normalizedDetect.summary || '').trim();
  const detectScene = String(normalizedDetect.scene || '').trim();
  const detectObjects = useMemo(
    () =>
      (Array.isArray(normalizedDetect.objects) ? normalizedDetect.objects : [])
        .map((item) => ({
          name: String(item?.name || '').trim(),
          confidence: Number(item?.confidence || 0),
        }))
        .filter((item) => item.name)
        .slice(0, 8),
    [normalizedDetect.objects]
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [encyclopedia, setEncyclopedia] = useState<EncyclopediaData | null>(null);

  const fallbackUrl = useMemo(
    () => `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
    [query]
  );
  const summaryText = useMemo(() => {
    const remoteRaw = String(encyclopedia?.summary || '').trim();
    const remoteSummary = normalizeObjectDetectPayload(remoteRaw).summary || remoteRaw;
    if (remoteSummary) return remoteSummary;
    if (detectSummary) return detectSummary;
    return `${query} 暂无可展示的百科摘要。`;
  }, [detectSummary, encyclopedia?.summary, query]);

  const sourceTitle = String(
    normalizeObjectDetectPayload(String(encyclopedia?.title || '')).summary ||
      encyclopedia?.title ||
      query ||
      '识别结果'
  ).trim();
  const sourceUrl = String(encyclopedia?.url || fallbackUrl).trim();
  const sourceLabel = String(encyclopedia?.source || '网络百科').trim();
  const thumbnail = String(encyclopedia?.thumbnail || '').trim();

  const loadEncyclopedia = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    setError('');
    try {
      const token = (await storage.getString(STORAGE_KEYS.token)) || '';
      const response = await fetch(
        `${API_BASE}/api/insight/encyclopedia?query=${encodeURIComponent(query)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data?.data) {
        throw new Error(String(data?.message || '百科检索失败'));
      }
      setEncyclopedia(data.data as EncyclopediaData);
    } catch (err) {
      const message = err instanceof Error ? err.message : '百科检索失败';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    loadEncyclopedia().catch(() => undefined);
  }, [loadEncyclopedia]);

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          识别详情
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 78,
            paddingBottom: Math.max(insets.bottom + 24, 26),
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          {imageUri ? (
            <Image source={{ uri: imageUri }} style={styles.heroImage} resizeMode="cover" />
          ) : (
            <View style={styles.heroEmpty}>
              <Text style={styles.heroEmptyText}>暂无识别图片</Text>
            </View>
          )}
          <View style={styles.heroOverlay}>
            <Text style={styles.heroBadge}>AR识别</Text>
            <Text style={styles.heroQuery} numberOfLines={2}>
              {query || '未命名目标'}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>识别摘要</Text>
          {detectSummary ? <Text style={styles.bodyText}>{detectSummary}</Text> : null}
          {detectScene ? <Text style={styles.metaText}>{`场景：${detectScene}`}</Text> : null}
          {detectObjects.length > 0 ? (
            <View style={styles.tagWrap}>
              {detectObjects.map((item, index) => {
                const percent = Number.isFinite(item.confidence)
                  ? Math.round(item.confidence * 100)
                  : 0;
                const score = percent >= 1 && percent <= 100 ? `${percent}%` : '';
                return (
                  <View key={`obj-${index}-${item.name}`} style={styles.tag}>
                    <Text style={styles.tagText}>{`${item.name}${score ? ` ${score}` : ''}`}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.cardTitle}>网络百科</Text>
            {loading ? <ActivityIndicator size="small" color="#2f7df6" /> : null}
          </View>

          <Text style={styles.sourceTitle}>{sourceTitle}</Text>
          <Text style={styles.bodyText}>{summaryText}</Text>
          {error ? <Text style={styles.errorText}>{`检索提示：${error}`}</Text> : null}

          {thumbnail ? (
            <Image source={{ uri: thumbnail }} style={styles.thumbnail} resizeMode="cover" />
          ) : null}

          <View style={styles.sourceRow}>
            <Text style={styles.sourceLabel}>{`来源：${sourceLabel}`}</Text>
            <Pressable
              style={styles.openBtn}
              onPress={() =>
                navigation.navigate('InAppBrowser', {
                  title: sourceTitle,
                  url: sourceUrl,
                })
              }
            >
              <Text style={styles.openBtnText}>查看来源</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#eff3f9',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    height: 68,
    backgroundColor: 'rgba(239,243,249,0.96)',
    borderBottomWidth: 1,
    borderBottomColor: '#dfe6f2',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#dde7f7',
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    color: '#10213f',
    fontWeight: '700',
  },
  scrollContent: {
    paddingHorizontal: 14,
    gap: 12,
  },
  heroCard: {
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#d7e1ef',
    backgroundColor: '#cfd8e5',
  },
  heroImage: {
    width: '100%',
    height: 220,
  },
  heroEmpty: {
    width: '100%',
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroEmptyText: {
    color: '#6b7a95',
    fontSize: 14,
  },
  heroOverlay: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#183864',
  },
  heroBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#4ca3ff',
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  heroQuery: {
    marginTop: 8,
    color: '#f3f8ff',
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d7e1ef',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  cardTitle: {
    fontSize: 15,
    color: '#1a2d4f',
    fontWeight: '700',
    marginBottom: 8,
  },
  sourceTitle: {
    fontSize: 17,
    color: '#172948',
    fontWeight: '700',
    marginBottom: 6,
  },
  bodyText: {
    color: '#2d3f5f',
    fontSize: 14,
    lineHeight: 21,
  },
  metaText: {
    marginTop: 8,
    color: '#637695',
    fontSize: 12,
  },
  tagWrap: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#e6f0ff',
  },
  tagText: {
    color: '#2d5ea9',
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    marginTop: 10,
    color: '#c24646',
    fontSize: 12,
    lineHeight: 17,
  },
  thumbnail: {
    width: '100%',
    height: 168,
    borderRadius: 12,
    marginTop: 12,
    backgroundColor: '#e7ecf5',
  },
  sourceRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sourceLabel: {
    flex: 1,
    color: '#6a7c9b',
    fontSize: 12,
  },
  openBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#2f7df6',
  },
  openBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#1e3558"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
