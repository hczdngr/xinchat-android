import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Line, Path } from 'react-native-svg';
import { API_BASE } from '../config';
import { storage } from '../storage';
import FoundFriends from './FoundFriends';

type Profile = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
};

type Friend = {
  uid: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  online?: boolean;
};

type Message = {
  id: number | string;
  senderUid: number;
  targetUid: number;
  targetType: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
  raw?: any;
};

type LatestMap = Record<number, { text: string; time: string }>;
type ReadAtMap = Record<number, number>;
type BucketMap = Record<number, Message[]>;

const READ_AT_KEY = 'xinchat.readAt';
const PAGE_LIMIT = 30;
const UNREAD_LIMIT = 200;
const HEARTBEAT_MS = 20000;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 10000;

export default function Home({ profile }: { profile: Profile }) {
  const insets = useSafeAreaInsets();
  const navPad = Math.max(insets.bottom, 10);
  const tokenRef = useRef<string>('');
  const [profileData, setProfileData] = useState<Profile>({
    username: '',
    nickname: '',
    avatar: '',
    uid: undefined,
    ...profile,
  });
  const [friends, setFriends] = useState<Friend[]>([]);
  const [latestMap, setLatestMap] = useState<LatestMap>({});
  const [loadingFriends, setLoadingFriends] = useState(false);

  const [messagesByUid, setMessagesByUid] = useState<BucketMap>({});
  const [unreadMap, setUnreadMap] = useState<Record<number, number>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<number, boolean>>({});
  const [historyHasMore, setHistoryHasMore] = useState<Record<number, boolean>>({});
  const [readAtMap, setReadAtMap] = useState<ReadAtMap>({});

  const [activeChatUid, setActiveChatUid] = useState<number | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [activeView, setActiveView] = useState<'list' | 'found'>('list');
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const [homeTab, setHomeTab] = useState<'messages' | 'contacts'>('messages');

  const messageIdSetsRef = useRef<Map<number, Set<number | string>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const messagesByUidRef = useRef<BucketMap>({});
  const readAtMapRef = useRef<ReadAtMap>({});
  const activeChatUidRef = useRef<number | null>(null);
  const contentHeightRef = useRef(0);
  const messageListRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    activeChatUidRef.current = activeChatUid;
  }, [activeChatUid]);

  useEffect(() => {
    messagesByUidRef.current = messagesByUid;
  }, [messagesByUid]);

  useEffect(() => {
    readAtMapRef.current = readAtMap;
  }, [readAtMap]);

  useEffect(() => {
    if (profile) {
      setProfileData((prev) => ({ ...prev, ...profile }));
    }
  }, [profile]);

  useEffect(() => {
    const loadToken = async () => {
      tokenRef.current = (await storage.getString('xinchat.token')) || '';
    };
    void loadToken();
  }, []);

  useEffect(() => {
    const loadReadAt = async () => {
      const stored = await storage.getJson<ReadAtMap>(READ_AT_KEY);
      if (stored) {
        setReadAtMap(stored);
      }
    };
    void loadReadAt();
  }, []);

  const displayName = useMemo(
    () => profileData.nickname || profileData.username || '加载中...',
    [profileData.nickname, profileData.username]
  );
  const avatarUrl = useMemo(() => profileData.avatar || '', [profileData.avatar]);
  const avatarText = useMemo(() => displayName.slice(0, 2), [displayName]);
  const activeChatFriend = useMemo(() => {
    if (!activeChatUid) return null;
    return friends.find((item) => item.uid === activeChatUid) || null;
  }, [activeChatUid, friends]);
  const activeChatMessages = useMemo(() => {
    if (!activeChatUid) return [];
    return messagesByUid[activeChatUid] || [];
  }, [activeChatUid, messagesByUid]);
  const selfUid = useMemo(() => profileData.uid, [profileData.uid]);
  const canSend = useMemo(() => draftMessage.trim().length > 0, [draftMessage]);

  const getAvatarText = useCallback((value?: string) => {
    const text = String(value || '').trim();
    if (!text) return '??';
    return text.slice(0, 2);
  }, []);

  const authHeaders = useCallback(() => {
    const token = tokenRef.current;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const loadProfile = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const response = await fetch(`${API_BASE}/api/profile`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.user) {
        setProfileData((prev) => ({ ...prev, ...data.user }));
      }
    } catch {}
  }, [authHeaders]);

  const normalizeMessage = useCallback((entry: any): Message => {
    const createdAt = entry?.createdAt || '';
    const createdAtMs = Number(entry?.createdAtMs);
    const parsedMs = Number.isFinite(createdAtMs)
      ? createdAtMs
      : Number.isFinite(Date.parse(createdAt))
        ? Date.parse(createdAt)
        : Date.now();
    return {
      id: entry.id,
      senderUid: entry.senderUid,
      targetUid: entry.targetUid,
      targetType: entry.targetType,
      content: entry?.data?.content || entry?.data?.text || '',
      createdAt,
      createdAtMs: parsedMs,
      raw: entry,
    };
  }, []);

  const formatMessage = useCallback((msg: any) => {
    if (!msg) return '';
    if (msg.type === 'text') return msg.data?.content || msg.data?.text || '';
    if (msg.type === 'image') return '[图片]';
    if (msg.type === 'file') return '[文件]';
    if (msg.type === 'voice') return '[语音]';
    return '[消息]';
  }, []);

  const formatTime = useCallback((value?: string, fallbackMs?: number) => {
    if (!value && !Number.isFinite(fallbackMs)) return '';
    const date = value ? new Date(value) : new Date(fallbackMs || 0);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }, []);

  const ensureMessageBucket = useCallback((uid: number) => {
    if (!uid) return;
    setMessagesByUid((prev) => (prev[uid] ? prev : { ...prev, [uid]: [] }));
    if (!messageIdSetsRef.current.has(uid)) {
      messageIdSetsRef.current.set(uid, new Set());
    }
    setUnreadMap((prev) => (typeof prev[uid] === 'number' ? prev : { ...prev, [uid]: 0 }));
    setHistoryLoading((prev) =>
      typeof prev[uid] === 'boolean' ? prev : { ...prev, [uid]: false }
    );
    setHistoryHasMore((prev) =>
      typeof prev[uid] === 'boolean' ? prev : { ...prev, [uid]: true }
    );
  }, []);

  const persistReadAtMap = useCallback(async (nextMap: ReadAtMap) => {
    await storage.setJson(READ_AT_KEY, nextMap);
  }, []);

  const getReadAt = useCallback((uid: number) => {
    const value = Number(readAtMapRef.current[uid]);
    return Number.isFinite(value) ? value : 0;
  }, []);

  const setReadAt = useCallback(
    (uid: number, ts: number) => {
      if (!uid) return;
      setReadAtMap((prev) => {
        const next = { ...prev, [uid]: ts };
        void persistReadAtMap(next);
        return next;
      });
    },
    [persistReadAtMap]
  );

  const recalcUnread = useCallback(
    (uid: number, list?: Message[]) => {
      const bucket = list || messagesByUidRef.current[uid] || [];
      const readAt = getReadAt(uid);
      const count = bucket.filter(
        (item) => item.senderUid !== selfUid && item.createdAtMs > readAt
      ).length;
      setUnreadMap((prev) => ({ ...prev, [uid]: count }));
    },
    [getReadAt, selfUid]
  );

  const updateLatest = useCallback(
    (uid: number, entry: any) => {
      if (!uid || !entry) return;
      const messageText = entry?.content || formatMessage(entry?.raw || entry);
      setLatestMap((prev) => ({
        ...prev,
        [uid]: {
          text: messageText || '暂无消息',
          time: formatTime(entry?.createdAt || entry?.raw?.createdAt, entry?.createdAtMs),
        },
      }));
    },
    [formatMessage, formatTime]
  );

  const insertMessages = useCallback(
    (uid: number, list: any[], { prepend }: { prepend?: boolean } = {}) => {
      if (!uid) return;
      ensureMessageBucket(uid);
      const bucket = messagesByUidRef.current[uid] || [];
      let idSet = messageIdSetsRef.current.get(uid);
      if (!idSet) {
        idSet = new Set();
        messageIdSetsRef.current.set(uid, idSet);
      }
      const incoming = list
        .map(normalizeMessage)
        .filter((entry) => entry.id && !idSet?.has(entry.id))
        .sort((a, b) => a.createdAtMs - b.createdAtMs);
      if (!incoming.length) return;
      incoming.forEach((entry) => idSet?.add(entry.id));
      const nextBucket = prepend ? [...incoming, ...bucket] : [...bucket, ...incoming];
      setMessagesByUid((prev) => ({ ...prev, [uid]: nextBucket }));

      const last = nextBucket[nextBucket.length - 1];
      if (last) {
        const friendUid = last.senderUid === selfUid ? last.targetUid : last.senderUid;
        updateLatest(friendUid, last);
      }
      recalcUnread(uid, nextBucket);
    },
    [ensureMessageBucket, normalizeMessage, recalcUnread, selfUid, updateLatest]
  );

  const loadLatestForFriend = useCallback(
    async (uid: number) => {
      try {
        const params = new URLSearchParams({
          targetType: 'private',
          targetUid: String(uid),
          type: 'text',
          limit: '1',
        });
        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: { ...authHeaders() },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && Array.isArray(data?.data)) {
          const last = data.data[data.data.length - 1];
          if (last) {
            updateLatest(uid, normalizeMessage(last));
          }
        }
      } catch {}
    },
    [authHeaders, normalizeMessage, updateLatest]
  );

  const loadUnreadCount = useCallback(
    async (uid: number) => {
      const sinceTs = getReadAt(uid);
      try {
        const params = new URLSearchParams({
          targetType: 'private',
          targetUid: String(uid),
          type: 'text',
          limit: String(UNREAD_LIMIT),
        });
        if (sinceTs > 0) {
          params.set('sinceTs', String(sinceTs));
        }
        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: { ...authHeaders() },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && Array.isArray(data?.data)) {
          const count = data.data.filter((item: any) => item.senderUid !== selfUid).length;
          setUnreadMap((prev) => ({ ...prev, [uid]: Math.min(count, 99) }));
        }
      } catch {}
    },
    [authHeaders, getReadAt, selfUid]
  );

  const loadFriends = useCallback(async () => {
    if (!tokenRef.current) return;
    setLoadingFriends(true);
    try {
      const response = await fetch(`${API_BASE}/api/friends/list`, {
        headers: { ...authHeaders() },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && Array.isArray(data?.friends)) {
        setFriends(data.friends);
        await Promise.all(
          data.friends.map(async (friend: Friend) => {
            ensureMessageBucket(friend.uid);
            await loadLatestForFriend(friend.uid);
            await loadUnreadCount(friend.uid);
          })
        );
      }
    } catch {}
    setLoadingFriends(false);
  }, [authHeaders, ensureMessageBucket, loadLatestForFriend, loadUnreadCount]);

  const loadHistory = useCallback(
    async (uid: number, { beforeId }: { beforeId?: number | string } = {}) => {
      if (!tokenRef.current) return;
      ensureMessageBucket(uid);
      if (historyLoading[uid]) return;
      setHistoryLoading((prev) => ({ ...prev, [uid]: true }));
      try {
        const params = new URLSearchParams({
          targetType: 'private',
          targetUid: String(uid),
          type: 'text',
          limit: String(PAGE_LIMIT),
        });
        if (beforeId) {
          params.set('beforeId', String(beforeId));
        }
        const response = await fetch(`${API_BASE}/api/chat/get?${params.toString()}`, {
          headers: { ...authHeaders() },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && Array.isArray(data?.data)) {
          insertMessages(uid, data.data, { prepend: Boolean(beforeId) });
          if (data.data.length < PAGE_LIMIT) {
            setHistoryHasMore((prev) => ({ ...prev, [uid]: false }));
          }
        }
      } catch {}
      setHistoryLoading((prev) => ({ ...prev, [uid]: false }));
    },
    [authHeaders, ensureMessageBucket, historyLoading, insertMessages]
  );


  const markChatRead = useCallback(
    (uid: number) => {
      if (!uid) return;
      const list = messagesByUidRef.current[uid] || [];
      const last = list[list.length - 1];
      const lastTime = last ? last.createdAtMs : Date.now();
      setReadAt(uid, lastTime);
      setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
    },
    [setReadAt]
  );

  const scrollToBottom = useCallback(() => {
    if (!messageListRef.current) return;
    messageListRef.current.scrollToEnd({ animated: false });
  }, []);

  const openChat = useCallback(
    async (friend: Friend) => {
      if (!friend) return;
      setActiveChatUid(friend.uid);
      ensureMessageBucket(friend.uid);
      if ((messagesByUidRef.current[friend.uid] || []).length === 0) {
        await loadHistory(friend.uid);
      }
      setTimeout(scrollToBottom, 0);
      markChatRead(friend.uid);
    },
    [ensureMessageBucket, loadHistory, markChatRead, scrollToBottom]
  );

  const closeChat = useCallback(() => {
    if (activeChatUidRef.current) {
      markChatRead(activeChatUidRef.current);
    }
    setActiveChatUid(null);
  }, [markChatRead]);

  const openFoundFriends = useCallback(() => {
    setActiveView('found');
  }, []);

  const closeFoundFriends = useCallback(() => {
    setActiveView('list');
  }, []);

  const onChatScroll = useCallback(
    async (event: any) => {
      const uid = activeChatUidRef.current;
      if (!uid) return;
      const offsetY = event?.nativeEvent?.contentOffset?.y ?? 0;
      if (offsetY > 40) return;
      if (!historyHasMore[uid] || historyLoading[uid]) return;
      const first = (messagesByUidRef.current[uid] || [])[0];
      if (!first) return;
      const prevHeight = contentHeightRef.current;
      await loadHistory(uid, { beforeId: first.id });
      setTimeout(() => {
        const nextHeight = contentHeightRef.current;
        if (messageListRef.current) {
          messageListRef.current.scrollTo({ y: nextHeight - prevHeight, animated: false });
        }
      }, 0);
    },
    [historyHasMore, historyLoading, loadHistory]
  );

  const sendText = useCallback(async () => {
    if (!canSend || !activeChatUidRef.current || !selfUid) return;
    const content = draftMessage.trim();
    if (!content) return;
    const payload = {
      senderUid: selfUid,
      targetUid: activeChatUidRef.current,
      targetType: 'private',
      type: 'text',
      content,
    };
    try {
      const response = await fetch(`${API_BASE}/api/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success && data?.data) {
        insertMessages(activeChatUidRef.current, [data.data]);
        setDraftMessage('');
        setTimeout(scrollToBottom, 0);
      }
    } catch {}
  }, [authHeaders, canSend, draftMessage, insertMessages, scrollToBottom, selfUid]);

  const deleteMessage = useCallback(
    async (uid: number, message: Message) => {
      if (!message?.id) return;
      try {
        const response = await fetch(`${API_BASE}/api/chat/del`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ id: message.id }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success) {
          const currentBucket = messagesByUidRef.current[uid] || [];
          const nextBucket = currentBucket.filter((item) => item.id !== message.id);
          setMessagesByUid((prev) => ({ ...prev, [uid]: nextBucket }));
          const idSet = messageIdSetsRef.current.get(uid);
          if (idSet) {
            idSet.delete(message.id);
          }
          const last = nextBucket[nextBucket.length - 1];
          if (last) {
            updateLatest(uid, last);
          }
          recalcUnread(uid, nextBucket);
        }
      } catch {}
    },
    [authHeaders, recalcUnread, updateLatest]
  );

  const buildWsUrl = useCallback(() => {
    try {
      const base = new URL(API_BASE);
      const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${base.host}/ws?token=${encodeURIComponent(tokenRef.current)}`;
    } catch {
      return '';
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) return;
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, HEARTBEAT_MS);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (!heartbeatTimerRef.current) return;
    clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
  }, []);

  const updatePresence = useCallback((uid: number, online: boolean) => {
    setFriends((prev) => {
      const idx = prev.findIndex((item) => item.uid === uid);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], online: Boolean(online) };
      return next;
    });
  }, []);

  const requestFriendsRefresh = useCallback(() => {
    setFriendsRefreshKey((prev) => prev + 1);
    void loadFriends();
  }, [loadFriends]);

  const handleWsMessage = useCallback(
    (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'chat') {
        const entry = payload.data;
        if (!entry?.id) return;
        const message = normalizeMessage(entry);
        const friendUid =
          message.senderUid === selfUid ? message.targetUid : message.senderUid;
        insertMessages(friendUid, [entry]);

        if (activeChatUidRef.current === friendUid) {
          markChatRead(friendUid);
          setTimeout(scrollToBottom, 0);
        }
        return;
      }
      if (payload.type === 'friends') {
        requestFriendsRefresh();
        return;
      }
      if (payload.type === 'requests') {
        setFriendsRefreshKey((prev) => prev + 1);
        return;
      }
      if (payload.type === 'presence') {
        const uid = Number(payload?.data?.uid);
        if (Number.isInteger(uid)) {
          updatePresence(uid, payload?.data?.online);
        }
        return;
      }
      if (payload.type === 'presence_snapshot') {
        const list = Array.isArray(payload?.data) ? payload.data : [];
        list.forEach((entry: any) => {
          const uid = Number(entry?.uid);
          if (Number.isInteger(uid)) {
            updatePresence(uid, entry?.online);
          }
        });
      }
    },
    [
      insertMessages,
      markChatRead,
      normalizeMessage,
      requestFriendsRefresh,
      scrollToBottom,
      selfUid,
      updatePresence,
    ]
  );

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * (1 + reconnectAttemptsRef.current),
      RECONNECT_MAX_MS
    );
    reconnectAttemptsRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWs();
    }, delay);
  }, []);

  const connectWs = useCallback(() => {
    if (!tokenRef.current) return;
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const wsUrl = buildWsUrl();
    if (!wsUrl) return;
    try {
      wsRef.current = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }

    wsRef.current.onopen = () => {
      reconnectAttemptsRef.current = 0;
      startHeartbeat();
    };
    wsRef.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleWsMessage(payload);
      } catch {}
    };
    wsRef.current.onclose = () => {
      stopHeartbeat();
      scheduleReconnect();
    };
    wsRef.current.onerror = () => {
      stopHeartbeat();
      scheduleReconnect();
    };
  }, [buildWsUrl, handleWsMessage, scheduleReconnect, startHeartbeat, stopHeartbeat]);

  const teardownWs = useCallback(() => {
    stopHeartbeat();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
  }, [stopHeartbeat]);

  useEffect(() => {
    void loadProfile();
    void loadFriends();
    connectWs();
    return () => {
      teardownWs();
    };
  }, [connectWs, loadFriends, loadProfile, teardownWs]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {activeView === 'found' && !activeChatUid ? (
        <FoundFriends
          friends={friends}
          selfUid={selfUid || null}
          refreshKey={friendsRefreshKey}
          onBack={closeFoundFriends}
          onRefreshFriends={requestFriendsRefresh}
        />
      ) : null}

      {activeChatUid ? (
        <>
          <View style={styles.chatHeader}>
            <Pressable style={styles.chatBack} onPress={closeChat}>
              <Text style={styles.backChevron}>{"<"}</Text>
            </Pressable>
            <View>
              <Text style={styles.chatName}>
                {activeChatFriend?.nickname || activeChatFriend?.username || '聊天'}
              </Text>
              <Text style={[styles.chatStatus, activeChatFriend?.online && styles.chatOnline]}>
                {activeChatFriend?.online ? '在线' : '离线'}
              </Text>
            </View>
          </View>

          <ScrollView
            ref={messageListRef}
            style={styles.chatBody}
            onScroll={onChatScroll}
            scrollEventThrottle={16}
            onContentSizeChange={(_, height) => {
              contentHeightRef.current = height;
            }}
          >
            {historyLoading[activeChatUid] && activeChatMessages.length === 0 ? (
              <Text style={styles.empty}>正在加载消息...</Text>
            ) : null}
            {!historyLoading[activeChatUid] && activeChatMessages.length === 0 ? (
              <Text style={styles.empty}>还没有消息，先聊几句吧。</Text>
            ) : null}
            {historyHasMore[activeChatUid] ? (
              <Text style={styles.loadMore}>
                {historyLoading[activeChatUid] ? '加载更多...' : '上拉加载更多'}
              </Text>
            ) : null}
            {activeChatMessages.map((item) => {
              const isSelf = item.senderUid === selfUid;
              return (
                <View key={String(item.id)} style={[styles.messageRow, isSelf && styles.selfRow]}>
                  <View style={[styles.bubble, isSelf && styles.selfBubble]}>
                    <Text style={[styles.messageText, isSelf && styles.selfText]}>
                      {item.content}
                    </Text>
                    <View style={styles.meta}>
                      <Text style={[styles.metaText, isSelf && styles.selfMeta]}>
                        {formatTime(item.createdAt, item.createdAtMs)}
                      </Text>
                      {!isSelf ? (
                        <Text style={styles.readState}>
                          {item.createdAtMs <= getReadAt(activeChatUid) ? '已读' : '未读'}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <Pressable onPress={() => deleteMessage(activeChatUid, item)}>
                    <Text style={[styles.deleteBtn, isSelf && styles.selfDelete]}>删除</Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>

          <View style={[styles.chatInput, { paddingBottom: 12 + insets.bottom }]}>
            <TextInput
              value={draftMessage}
              placeholder="输入消息..."
              placeholderTextColor="#b0b0b0"
              onChangeText={setDraftMessage}
              style={styles.chatInputField}
              onSubmitEditing={sendText}
              returnKeyType="send"
            />
            <Pressable
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={sendText}
              disabled={!canSend}
            >
              <Text style={styles.sendText}>发送</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {!activeChatUid && activeView !== 'found' ? (
        <View style={styles.home}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.avatarContainer}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.avatarImg} />
                ) : (
                  <Text style={styles.avatarFallback}>{avatarText}</Text>
                )}
              </View>
              <Text style={styles.username}>{displayName}</Text>
            </View>
            <Pressable style={styles.headerRight} onPress={openFoundFriends}>
              <Svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="#1a1a1a" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Line x1="12" y1="5" x2="12" y2="19" />
                <Line x1="5" y1="12" x2="19" y2="12" />
              </Svg>
            </Pressable>
          </View>

          <View style={styles.searchContainer}>
            <View style={styles.searchBox}>
              <Svg viewBox="0 0 24 24" width={16} height={16}>
                <Path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" fill="#a0a0a0" />
              </Svg>
              <Text style={styles.searchText}>搜索</Text>
            </View>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            {loadingFriends ? <Text style={styles.empty}>正在加载联系人...</Text> : null}
            {!loadingFriends && friends.length === 0 ? (
              <Text style={styles.empty}>暂无联系人</Text>
            ) : null}
            {!loadingFriends && friends.length > 0
              ? friends.map((friend) => (
                  <Pressable
                    key={friend.uid}
                    style={styles.contactItem}
                    onPress={() => openChat(friend)}
                  >
                    <View style={styles.contactAvatar}>
                      <Text style={styles.avatarText}>
                        {getAvatarText(friend.nickname || friend.username)}
                      </Text>
                      <View style={[styles.presence, friend.online && styles.presenceOnline]} />
                    </View>
                    <View style={styles.contactInfo}>
                      <Text style={styles.contactName}>
                        {friend.nickname || friend.username || '联系人'}
                      </Text>
                      <Text style={styles.contactSub}>
                        {latestMap[friend.uid]?.text || '暂无消息'}
                      </Text>
                    </View>
                    <View style={styles.contactMeta}>
                      <Text style={styles.contactTime}>{latestMap[friend.uid]?.time || ''}</Text>
                      {unreadMap[friend.uid] > 0 ? (
                        <View style={styles.unreadBadge}>
                          <Text style={styles.unreadText}>
                            {unreadMap[friend.uid] > 99 ? '99+' : unreadMap[friend.uid]}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                ))
              : null}
          </ScrollView>

          <View
            style={[
              styles.bottomNav,
              { paddingTop: navPad, paddingBottom: navPad, minHeight: 55 + navPad * 2 },
            ]}
          >
            <Pressable
              style={[
                styles.navItem,
                { paddingVertical: navPad },
                homeTab === 'messages' && styles.navItemActive,
              ]}
              onPress={() => setHomeTab('messages')}
            >
              <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'messages' ? '#0099ff' : '#7d7d7d'}>
                <Path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </Svg>
              <Text style={[styles.navText, homeTab === 'messages' && styles.navTextActive]}>消息</Text>
            </Pressable>
            <Pressable
              style={[
                styles.navItem,
                { paddingVertical: navPad },
                homeTab === 'contacts' && styles.navItemActive,
              ]}
              onPress={() => setHomeTab('contacts')}
            >
              <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'contacts' ? '#0099ff' : '#7d7d7d'}>
                <Path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </Svg>
              <Text style={[styles.navText, homeTab === 'contacts' && styles.navTextActive]}>联系人</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: '#f5f6fa',
  },
  home: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 15,
    paddingBottom: 6,
    paddingTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
    zIndex: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarContainer: {
    width: 38,
    height: 38,
    borderRadius: 19,
    overflow: 'hidden',
    backgroundColor: '#e0e0e0',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  avatarFallback: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2f6bd9',
  },
  username: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    letterSpacing: 0.5,
  },
  headerRight: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchContainer: {
    paddingHorizontal: 15,
    paddingTop: 5,
    paddingBottom: 10,
  },
  searchBox: {
    backgroundColor: '#fff',
    height: 36,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.02,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },
  searchText: {
    fontSize: 15,
    color: '#8a8a8a',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  bottomNav: {
    minHeight: 55,
    backgroundColor: '#f9f9f9',
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)',
    flexDirection: 'row',
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  navItemActive: {},
  navText: {
    fontSize: 10,
    color: '#7d7d7d',
    fontWeight: '500',
  },
  navTextActive: {
    color: '#0099ff',
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  contactAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2f6bd9',
  },
  presence: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    right: 0,
    bottom: 0,
    backgroundColor: '#c8c8c8',
    borderWidth: 2,
    borderColor: '#fff',
  },
  presenceOnline: {
    backgroundColor: '#30c67c',
  },
  contactInfo: {
    flex: 1,
    gap: 4,
  },
  contactName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  contactSub: {
    fontSize: 12,
    color: '#8a8a8a',
  },
  contactMeta: {
    alignItems: 'flex-end',
    gap: 6,
  },
  contactTime: {
    fontSize: 11,
    color: '#9a9a9a',
  },
  unreadBadge: {
    backgroundColor: '#ff4d4f',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  unreadText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  empty: {
    textAlign: 'center',
    color: '#9a9a9a',
    fontSize: 12,
    paddingVertical: 12,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#f5f6fa',
  },
  chatBack: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backChevron: {
    fontSize: 26,
    color: '#333',
  },
  chatName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  chatStatus: {
    fontSize: 11,
    color: '#9a9a9a',
  },
  chatOnline: {
    color: '#30c67c',
  },
  chatBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  loadMore: {
    textAlign: 'center',
    fontSize: 11,
    color: '#9a9a9a',
    marginBottom: 10,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 12,
  },
  selfRow: {
    flexDirection: 'row-reverse',
  },
  bubble: {
    maxWidth: '70%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
  },
  selfBubble: {
    backgroundColor: '#4a9df8',
  },
  messageText: {
    fontSize: 14,
    color: '#1a1a1a',
  },
  selfText: {
    color: '#fff',
  },
  meta: {
    marginTop: 6,
    flexDirection: 'row',
    gap: 8,
  },
  metaText: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.45)',
  },
  selfMeta: {
    color: 'rgba(255,255,255,0.7)',
  },
  readState: {
    fontSize: 10,
    color: '#2f6bd9',
    fontWeight: '600',
  },
  deleteBtn: {
    fontSize: 11,
    color: '#888',
  },
  selfDelete: {
    color: 'rgba(255,255,255,0.7)',
  },
  chatInput: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)',
    backgroundColor: '#fff',
  },
  chatInputField: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e1e1e1',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    fontSize: 14,
    color: '#333',
  },
  sendBtn: {
    backgroundColor: '#4a9df8',
    borderRadius: 16,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.6,
  },
  sendText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});



