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
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { API_BASE } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { GroupChatSearchRoute, RootNavigation } from '../navigation/types';
import { storage } from '../storage';

type MessageTypeFilter = 'all' | 'text' | 'image' | 'file' | 'voice';
type GroupMessageResult = {
  id: string;
  senderUid: number;
  type: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
};

const PAGE_LIMIT = 60;
const MAX_FETCH_PAGES = 24;
const MAX_RESULTS = 400;

const TYPE_LABELS: ReadonlyArray<{ key: MessageTypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文本' },
  { key: 'image', label: '图片' },
  { key: 'file', label: '文件' },
  { key: 'voice', label: '语音' },
];

const stripAutoGroupCountSuffix = (rawName: any, memberCount: number) => {
  const text = String(rawName || '').trim();
  if (!text) return '';
  if (!Number.isInteger(memberCount) || memberCount <= 0) return text;
  const match = text.match(/\((\d+)\)$/);
  if (!match) return text;
  const suffixCount = Number(match[1]);
  if (!Number.isInteger(suffixCount) || suffixCount !== memberCount) return text;
  return text.slice(0, text.length - match[0].length).trim();
};

const extractMessageContent = (entry: any): string => {
  const type = String(entry?.type || '');
  if (type === 'text') {
    const raw = String(entry?.data?.content || entry?.data?.text || '').trim();
    return raw || '[文本]';
  }
  if (type === 'image') return '[图片]';
  if (type === 'file') return `[文件]${entry?.data?.fileName ? ` ${String(entry.data.fileName)}` : ''}`.trim();
  if (type === 'voice') return '[语音]';
  return '[消息]';
};

const normalizeMessage = (entry: any): GroupMessageResult | null => {
  const idRaw = entry?.id;
  if (typeof idRaw !== 'number' && typeof idRaw !== 'string') return null;
  const createdAt = String(entry?.createdAt || '');
  const parsed = Date.parse(createdAt);
  return {
    id: String(idRaw),
    senderUid: Number(entry?.senderUid) || 0,
    type: String(entry?.type || ''),
    content: extractMessageContent(entry),
    createdAt,
    createdAtMs: Number.isFinite(parsed) ? parsed : Date.now(),
  };
};

export default function GroupChatSearch() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<GroupChatSearchRoute>();
  const uid = Number(route.params?.uid || 0);
  const targetType = route.params?.targetType === 'private' ? 'private' : 'group';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MessageTypeFilter>('all');
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<GroupMessageResult[]>([]);

  const title = useMemo(() => {
    if (targetType === 'private') {
      const raw = String(route.params?.title || '').trim();
      return raw || (uid > 0 ? `聊天${uid}` : '聊天');
    }
    const group = route.params?.group;
    const memberCount = Array.isArray(group?.memberUids)
      ? group.memberUids.length
      : Array.isArray(group?.members)
        ? group.members.length
        : 0;
    const raw = String(route.params?.title || group?.name || '').trim();
    const cleaned = stripAutoGroupCountSuffix(raw, memberCount);
    return cleaned || (uid > 0 ? `群聊${uid}` : '群聊');
  }, [route.params?.group, route.params?.title, targetType, uid]);

  const performSearch = useCallback(async () => {
    if (!Number.isInteger(uid) || uid <= 0) return;
    setLoading(true);
    setSearched(true);
    try {
      const token = (await storage.getString(STORAGE_KEYS.token)) || '';
      if (!token) {
        setResults([]);
        return;
      }
      const authHeaders = { Authorization: `Bearer ${token}` };
      const normalizedQuery = query.trim().toLowerCase();
      let beforeId: string | null = null;
      let page = 0;
      const collected: GroupMessageResult[] = [];

      while (page < MAX_FETCH_PAGES && collected.length < MAX_RESULTS) {
        page += 1;
        const params = new URLSearchParams({
          targetType,
          targetUid: String(uid),
          limit: String(PAGE_LIMIT),
        });
        if (filter !== 'all') {
          params.set('type', filter);
        }
        if (beforeId) {
          params.set('beforeId', beforeId);
        }

        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: authHeaders,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !Array.isArray(data?.data)) {
          break;
        }
        const list = data.data;
        if (list.length === 0) {
          break;
        }

        const pageItems = list
          .map(normalizeMessage)
          .filter((item: GroupMessageResult | null): item is GroupMessageResult => Boolean(item))
          .filter((item: GroupMessageResult) => {
            if (!normalizedQuery) return true;
            const hay = `${item.content} ${item.senderUid} ${item.id}`.toLowerCase();
            return hay.includes(normalizedQuery);
          });
        collected.push(...pageItems);

        if (list.length < PAGE_LIMIT) {
          break;
        }
        const oldest = list[0];
        beforeId =
          typeof oldest?.id === 'number' || typeof oldest?.id === 'string'
            ? String(oldest.id)
            : null;
        if (!beforeId) {
          break;
        }
      }

      collected.sort((a, b) => b.createdAtMs - a.createdAtMs);
      setResults(collected.slice(0, MAX_RESULTS));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [filter, query, targetType, uid]);

  const openMessage = useCallback(
    async (item: GroupMessageResult) => {
      const focusMessageId = String(item.id || '').trim();
      if (!focusMessageId || !uid) return;
      await storage
        .setJson(STORAGE_KEYS.pendingOpenChat, {
          uid,
          targetType,
          friend: route.params?.friend,
          group: route.params?.group,
          focusMessageId,
          returnToPrevious: true,
        })
        .catch(() => undefined);
      navigation.navigate('Home', {
        openChatUid: uid,
        openChatTargetType: targetType,
        openChatFriend: route.params?.friend,
        openChatGroup: route.params?.group,
        openChatFocusMessageId: focusMessageId,
        openChatReturnToPrevious: true,
      });
    },
    [navigation, route.params?.friend, route.params?.group, targetType, uid]
  );

  useEffect(() => {
    if (!searched || loading) return;
    performSearch().catch(() => undefined);
  }, [filter, performSearch, searched]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <BackIcon />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          查找聊天记录 - {title}
        </Text>
        <View style={styles.rightSpace} />
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchInputWrap}>
          <SearchIcon />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="输入关键词（消息内容/发送者/消息ID）"
            placeholderTextColor="#9ba6b5"
            style={styles.searchInput}
            returnKeyType="search"
            onSubmitEditing={performSearch}
          />
        </View>
        <Pressable style={styles.searchBtn} onPress={performSearch} disabled={loading}>
          <Text style={styles.searchBtnText}>{loading ? '搜索中' : '搜索'}</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        style={styles.filterScroll}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {TYPE_LABELS.map((item) => {
          const active = filter === item.key;
          return (
            <Pressable
              key={item.key}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setFilter(item.key)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listInner}
        keyboardShouldPersistTaps="handled"
      >
        {!searched ? <Text style={styles.empty}>请选择类型并输入关键词后搜索</Text> : null}
        {loading ? <ActivityIndicator size="small" color="#2f8cff" /> : null}
        {searched && !loading && results.length === 0 ? (
          <Text style={styles.empty}>没有匹配记录</Text>
        ) : null}
        {!loading &&
          results.map((item) => (
            <Pressable key={item.id} style={styles.item} onPress={() => openMessage(item)}>
              <View style={styles.itemTop}>
                <Text style={styles.itemType}>{item.type || 'msg'}</Text>
                <Text style={styles.itemTime}>{formatTime(item.createdAt, item.createdAtMs)}</Text>
              </View>
              <Text style={styles.itemContent} numberOfLines={2}>
                {item.content}
              </Text>
              <Text style={styles.itemMeta}>发送者UID: {item.senderUid || 0}</Text>
            </Pressable>
          ))}
      </ScrollView>
    </View>
  );
}

function formatTime(value?: string, fallbackMs?: number) {
  if (!value && !Number.isFinite(fallbackMs)) return '';
  const date = value ? new Date(value) : new Date(fallbackMs || 0);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#314458"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SearchIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15.5 15.5L20 20"
        stroke="#94a1b3"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path
        d="M10.5 18C14.6421 18 18 14.6421 18 10.5C18 6.35786 14.6421 3 10.5 3C6.35786 3 3 6.35786 3 10.5C3 14.6421 6.35786 18 10.5 18Z"
        stroke="#94a1b3"
        strokeWidth={2}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f3f4f7',
  },
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    gap: 8,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    color: '#273444',
    fontWeight: '600',
  },
  rightSpace: {
    width: 34,
    height: 34,
  },
  searchRow: {
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInputWrap: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e1e6ee',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 6,
  },
  searchInput: {
    flex: 1,
    color: '#1f2a3a',
    fontSize: 14,
    paddingVertical: 0,
  },
  searchBtn: {
    height: 40,
    borderRadius: 12,
    backgroundColor: '#2f8cff',
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  filterRow: {
    flexGrow: 0,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 8,
  },
  filterScroll: {
    flexGrow: 0,
    flexShrink: 0,
    height: 48,
    maxHeight: 48,
    minHeight: 48,
  },
  filterChip: {
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#dbe2ed',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: {
    borderColor: '#2f8cff',
    backgroundColor: '#edf5ff',
  },
  filterText: {
    color: '#5c6b80',
    fontSize: 13,
    fontWeight: '500',
  },
  filterTextActive: {
    color: '#2f8cff',
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  listInner: {
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
  },
  empty: {
    textAlign: 'center',
    color: '#9aa5b6',
    fontSize: 13,
    paddingTop: 16,
  },
  item: {
    borderWidth: 1,
    borderColor: '#e6eaf1',
    borderRadius: 12,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  itemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  itemType: {
    fontSize: 12,
    color: '#3288f0',
    fontWeight: '600',
  },
  itemTime: {
    fontSize: 12,
    color: '#97a2b2',
  },
  itemContent: {
    color: '#223043',
    fontSize: 14,
    lineHeight: 20,
  },
  itemMeta: {
    color: '#98a3b3',
    fontSize: 12,
  },
});
