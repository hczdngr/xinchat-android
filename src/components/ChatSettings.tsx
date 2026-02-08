import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { normalizeImageUrl } from '../config';
import {
  CHAT_BACKGROUND_PRESETS,
  type ChatBackgroundKey,
} from '../constants/chatSettings';
import { STORAGE_KEYS } from '../constants/storageKeys';
import type { ChatSettingsRoute, RootNavigation } from '../navigation/types';
import { storage } from '../storage';

type BoolMap = Record<number, boolean>;
type BackgroundMap = Record<number, ChatBackgroundKey>;
type NumberMap = Record<number, number>;

const sanitizeBoolMap = (input: any): BoolMap => {
  if (!input || typeof input !== 'object') return {};
  const next: BoolMap = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    if (!rawValue) return;
    next[uid] = true;
  });
  return next;
};

const sanitizeNumberMap = (input: any): NumberMap => {
  if (!input || typeof input !== 'object') return {};
  const next: NumberMap = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return;
    next[uid] = value;
  });
  return next;
};

const backgroundKeySet = new Set<ChatBackgroundKey>(CHAT_BACKGROUND_PRESETS.map((item) => item.key));

const sanitizeBackgroundMap = (input: any): BackgroundMap => {
  if (!input || typeof input !== 'object') return {};
  const next: BackgroundMap = {};
  Object.entries(input).forEach(([rawUid, rawValue]) => {
    const uid = Number(rawUid);
    if (!Number.isInteger(uid) || uid <= 0) return;
    const key = String(rawValue || '').trim() as ChatBackgroundKey;
    if (!backgroundKeySet.has(key)) return;
    next[uid] = key;
  });
  return next;
};

export default function ChatSettings() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<ChatSettingsRoute>();
  const uid = Number(route.params?.uid || 0);
  const friend = route.params?.friend;
  const [ready, setReady] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [muted, setMuted] = useState(false);
  const [background, setBackground] = useState<ChatBackgroundKey>('default');
  const [deleting, setDeleting] = useState(false);
  const backActionHandledRef = useRef(false);

    const queueOpenChatOnReturn = useCallback(async () => {
    if (!Number.isInteger(uid) || uid <= 0) return;
    await storage.setJson(STORAGE_KEYS.pendingOpenChat, {
      uid,
      targetType: 'private',
      friend: friend
        ? {
            uid: Number(friend.uid),
            username: friend.username,
            nickname: friend.nickname,
            avatar: friend.avatar,
            signature: friend.signature,
            online: friend.online,
          }
        : undefined,
      returnToPrevious: false,
    });
  }, [friend, uid]);

  const backToChat = useCallback(async () => {
    backActionHandledRef.current = true;
    await queueOpenChatOnReturn().catch(() => undefined);
    navigation.goBack();
  }, [navigation, queueOpenChatOnReturn]);

  const displayName = useMemo(
    () => friend?.nickname || friend?.username || (uid > 0 ? `用户${uid}` : '聊天'),
    [friend?.nickname, friend?.username, uid]
  );
  const avatarUrl = useMemo(() => normalizeImageUrl(friend?.avatar), [friend?.avatar]);
  const avatarText = useMemo(() => displayName.slice(0, 2), [displayName]);
  const backgroundLabel = useMemo(
    () => CHAT_BACKGROUND_PRESETS.find((item) => item.key === background)?.label || '默认',
    [background]
  );

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      if (!Number.isInteger(uid) || uid <= 0) {
        setReady(true);
        return;
      }
      const [storedPinned, storedMuted, storedBackground] = await Promise.all([
        storage.getJson<BoolMap>(STORAGE_KEYS.pinned),
        storage.getJson<BoolMap>(STORAGE_KEYS.chatMuted),
        storage.getJson<BackgroundMap>(STORAGE_KEYS.chatBackground),
      ]);
      if (cancelled) return;
      const pinnedMap = sanitizeBoolMap(storedPinned);
      const mutedMap = sanitizeBoolMap(storedMuted);
      const backgroundMap = sanitizeBackgroundMap(storedBackground);
      setPinned(Boolean(pinnedMap[uid]));
      setMuted(Boolean(mutedMap[uid]));
      setBackground(backgroundMap[uid] || 'default');
      setReady(true);
    };
    loadSettings().catch(() => setReady(true));
    return () => {
      cancelled = true;
    };
    }, [uid]);

  useEffect(() => {
    backActionHandledRef.current = false;
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (backActionHandledRef.current) return;
      if (!Number.isInteger(uid) || uid <= 0) return;
      const actionType = String(event?.data?.action?.type || '');
      if (actionType !== 'GO_BACK' && actionType !== 'POP' && actionType !== 'POP_TO_TOP') return;
      event.preventDefault();
      queueOpenChatOnReturn()
        .catch(() => undefined)
        .finally(() => {
          backActionHandledRef.current = true;
          navigation.dispatch(event.data.action);
        });
    });
    return unsubscribe;
  }, [navigation, queueOpenChatOnReturn, uid]);

  const savePinned = useCallback(
    async (next: boolean) => {
      const current = sanitizeBoolMap(await storage.getJson<BoolMap>(STORAGE_KEYS.pinned));
      if (next) {
        current[uid] = true;
      } else {
        delete current[uid];
      }
      await storage.setJson(STORAGE_KEYS.pinned, current);
    },
    [uid]
  );

  const saveMuted = useCallback(
    async (next: boolean) => {
      const current = sanitizeBoolMap(await storage.getJson<BoolMap>(STORAGE_KEYS.chatMuted));
      if (next) {
        current[uid] = true;
      } else {
        delete current[uid];
      }
      await storage.setJson(STORAGE_KEYS.chatMuted, current);
    },
    [uid]
  );

  const saveBackground = useCallback(
    async (next: ChatBackgroundKey) => {
      const current = sanitizeBackgroundMap(
        await storage.getJson<BackgroundMap>(STORAGE_KEYS.chatBackground)
      );
      if (next === 'default') {
        delete current[uid];
      } else {
        current[uid] = next;
      }
      await storage.setJson(STORAGE_KEYS.chatBackground, current);
    },
    [uid]
  );

  const onTogglePinned = useCallback(async () => {
    if (!ready || uid <= 0) return;
    const next = !pinned;
    setPinned(next);
    try {
      await savePinned(next);
    } catch {
      setPinned(!next);
    }
  }, [pinned, ready, savePinned, uid]);

  const onToggleMuted = useCallback(async () => {
    if (!ready || uid <= 0) return;
    const next = !muted;
    setMuted(next);
    try {
      await saveMuted(next);
    } catch {
      setMuted(!next);
    }
  }, [muted, ready, saveMuted, uid]);

  const onSelectBackground = useCallback(() => {
    if (!ready || uid <= 0) return;
    Alert.alert(
      '设置当前聊天背景',
      '请选择背景',
      [
        ...CHAT_BACKGROUND_PRESETS.map((item) => ({
          text: item.label,
          onPress: async () => {
            setBackground(item.key);
            await saveBackground(item.key).catch(() => undefined);
          },
        })),
        { text: '取消', style: 'cancel' as const },
      ],
      { cancelable: true }
    );
  }, [ready, saveBackground, uid]);

  const showNotice = useCallback((title: string, message: string) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(`${title}\n\n${message}`);
      return;
    }
    Alert.alert(title, message);
  }, []);

  const clearLocalCaches = useCallback(async (deletedAt: number) => {
    const [cachedMessages, cachedLatest, cachedUnread, hiddenChats, readAtMap, deleteCutoffMap] =
      await Promise.all([
        storage.getJson<Record<number, any>>(STORAGE_KEYS.homeMessagesCache),
        storage.getJson<Record<number, any>>(STORAGE_KEYS.homeLatestCache),
        storage.getJson<Record<number, any>>(STORAGE_KEYS.homeUnreadCache),
        storage.getJson<Record<number, any>>(STORAGE_KEYS.hiddenChats),
        storage.getJson<NumberMap>(STORAGE_KEYS.readAt),
        storage.getJson<NumberMap>(STORAGE_KEYS.chatDeleteCutoff),
      ]);

    const nextMessages = { ...(cachedMessages || {}) };
    const nextLatest = { ...(cachedLatest || {}) };
    const nextUnread = { ...(cachedUnread || {}) };
    const nextHidden = sanitizeBoolMap(hiddenChats);
    const nextReadAt = sanitizeNumberMap(readAtMap);
    const nextDeleteCutoff = sanitizeNumberMap(deleteCutoffMap);

    delete nextMessages[uid];
    delete nextLatest[uid];
    nextUnread[uid] = 0;
    delete nextHidden[uid];
    nextReadAt[uid] = deletedAt;
    nextDeleteCutoff[uid] = deletedAt;

    await Promise.all([
      storage.setJson(STORAGE_KEYS.homeMessagesCache, nextMessages),
      storage.setJson(STORAGE_KEYS.homeLatestCache, nextLatest),
      storage.setJson(STORAGE_KEYS.homeUnreadCache, nextUnread),
      storage.setJson(STORAGE_KEYS.hiddenChats, nextHidden),
      storage.setJson(STORAGE_KEYS.readAt, nextReadAt),
      storage.setJson(STORAGE_KEYS.chatDeleteCutoff, nextDeleteCutoff),
    ]);
  }, [uid]);

  const applyLocalDeleteAction = useCallback(async () => {
    const deletedAt = Date.now();
    await clearLocalCaches(deletedAt);
    await storage.setJson(STORAGE_KEYS.pendingChatSettingsAction, {
      type: 'delete_chat',
      uid,
      at: deletedAt,
    });
  }, [clearLocalCaches, uid]);

  const deleteChatHistory = useCallback(async () => {
    if (deleting || !Number.isInteger(uid) || uid <= 0) return;
    setDeleting(true);
    try {
      await applyLocalDeleteAction();
      showNotice('已完成', '聊天记录已删除');
    } catch {
      showNotice('删除失败', '请稍后重试');
    } finally {
      setDeleting(false);
    }
  }, [applyLocalDeleteAction, deleting, showNotice, uid]);

  const onDeleteChatHistory = useCallback(() => {
    if (uid <= 0) {
      showNotice('删除失败', '聊天目标无效');
      return;
    }
    const title = '删除聊天记录';
    const message = '确认删除该聊天的所有消息记录？';
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (window.confirm(`${title}\n\n${message}`)) {
        deleteChatHistory().catch(() => undefined);
      }
      return;
    }
    Alert.alert(
      title,
      message,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => deleteChatHistory() },
      ],
      { cancelable: true }
    );
  }, [deleteChatHistory, showNotice, uid]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => { backToChat().catch(() => navigation.goBack()); }}>
          <BackIcon />
        </Pressable>
        <Text style={styles.headerTitle}>聊天设置</Text>
        <View style={styles.headerRightSpace} />
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
        <View style={styles.card}>
          <Pressable
            style={styles.row}
            onPress={() => {
              if (uid > 0) {
                navigation.navigate('FriendProfile', { uid, friend });
              }
            }}
          >
            <View style={styles.userRowLeft}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarText}>{avatarText || '??'}</Text>
                </View>
              )}
              <Text style={styles.userName}>{displayName}</Text>
            </View>
            <View style={styles.arrowIcon}>
              <ForwardIndicatorIcon />
            </View>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            style={styles.row}
            onPress={() => {
              if (!Number.isInteger(uid) || uid <= 0) return;
              navigation.navigate('CreateGroup', { preselectedMemberUids: [uid] });
            }}
          >
            <View style={styles.userRowLeft}>
              <View style={styles.groupFallback}>
                <Text style={styles.groupPlus}>+</Text>
              </View>
              <Text style={styles.normalText}>发起群聊</Text>
            </View>
          </Pressable>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.normalText}>设置置顶</Text>
            <Switch value={pinned} onToggle={onTogglePinned} />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.normalText}>消息免打扰</Text>
            <Switch value={muted} onToggle={onToggleMuted} />
          </View>
        </View>

        <View style={styles.card}>
          <Pressable
            style={styles.row}
            onPress={() => {
              if (!Number.isInteger(uid) || uid <= 0) return;
              navigation.navigate('GroupChatSearch', {
                uid,
                title: displayName,
                targetType: 'private',
                friend,
              });
            }}
          >
            <Text style={styles.normalText}>查找聊天记录</Text>
            <View style={styles.rowRight}>
              <Text style={styles.subText}>按类型查找</Text>
              <View style={styles.arrowIcon}>
                <ForwardIndicatorIcon />
              </View>
            </View>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Pressable style={styles.row} onPress={onSelectBackground}>
            <Text style={styles.normalText}>设置当前聊天背景</Text>
            <Text style={styles.subText}>{backgroundLabel}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Pressable style={styles.row} onPress={onDeleteChatHistory} disabled={deleting}>
            <Text style={styles.normalText}>{deleting ? '正在删除...' : '删除聊天记录'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function Switch({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={onToggle}
      style={[styles.switchBase, value && styles.switchBaseOn]}
      hitSlop={6}
    >
      <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
    </Pressable>
  );
}

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#3a4250"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ForwardIndicatorIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="#b5bcc7"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="rotate(180 12 12)"
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
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 14,
    color: '#2f3440',
    fontWeight: '600',
  },
  headerRightSpace: {
    width: 34,
    height: 34,
  },
  body: {
    flex: 1,
  },
  bodyInner: {
    paddingHorizontal: 10,
    paddingBottom: 20,
    gap: 10,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    minHeight: 56,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  userRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  divider: {
    height: 1,
    backgroundColor: '#f0f1f5',
    marginHorizontal: 16,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  avatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#dfe9f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#2f6bd9',
    fontSize: 12,
    fontWeight: '700',
  },
  groupFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f2f3f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupPlus: {
    color: '#8e98a6',
    fontSize: 18,
    lineHeight: 18,
    fontWeight: '400',
  },
  userName: {
    color: '#2b2f38',
    fontSize: 15,
    fontWeight: '500',
  },
  normalText: {
    color: '#2b2f38',
    fontSize: 16,
  },
  subText: {
    color: '#8f97a4',
    fontSize: 13,
  },
  arrowIcon: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchBase: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#e5e7ea',
    padding: 2,
  },
  switchBaseOn: {
    backgroundColor: '#49a3ff',
  },
  switchKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fff',
  },
  switchKnobOn: {
    marginLeft: 18,
  },
});

