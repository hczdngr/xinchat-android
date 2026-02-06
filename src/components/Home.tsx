import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Dimensions,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { RootNavigation } from '../navigation/types';
import Svg, { Line, Path } from 'react-native-svg';
import { API_BASE, normalizeImageUrl } from '../config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { storage } from '../storage';
import FoundFriends from './FoundFriends';

type Profile = {
  uid?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  gender?: string;
  birthday?: string;
  country?: string;
  province?: string;
  region?: string;
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

type LatestMap = Record<number, { text: string; time: string; ts: number }>;
type ReadAtMap = Record<number, number>;
type BucketMap = Record<number, Message[]>;
type PinnedMap = Record<number, boolean>;
type HiddenMap = Record<number, boolean>;
type HomeTourStep = {
  id: string;
  title: string;
  description: string;
  spotlightStyle: ViewStyle;
  cardStyle: ViewStyle;
};

const PAGE_LIMIT = 30;
const HEARTBEAT_MS = 20000;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 10000;
const surfaceShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.08)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.02,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        elevation: 1,
      };
const menuShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.2)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 24,
        elevation: 6,
      };
const quickMenuShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 14px 30px rgba(0, 0, 0, 0.35)' }
    : {
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowOffset: { width: 0, height: 10 },
        shadowRadius: 30,
        elevation: 10,
      };
const tourCardShadowStyle =
  Platform.OS === 'web'
    ? { boxShadow: '0px 14px 30px rgba(45, 82, 133, 0.2)' }
    : {
        shadowColor: '#1f3f66',
        shadowOpacity: 0.16,
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 18,
        elevation: 7,
      };

export default function Home({ profile }: { profile: Profile }) {
  const insets = useSafeAreaInsets();
  const navPad = Math.min(insets.bottom, 6);
  const tokenRef = useRef<string>('');
  const [tokenReady, setTokenReady] = useState(false);
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
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({});
  const [hiddenMap, setHiddenMap] = useState<HiddenMap>({});
  const [chatMenuVisible, setChatMenuVisible] = useState(false);
  const [chatMenuTargetUid, setChatMenuTargetUid] = useState<number | null>(null);
  const [chatMenuPosition, setChatMenuPosition] = useState({ x: 0, y: 0 });
  const [quickMenuVisible, setQuickMenuVisible] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const [activeChatUid, setActiveChatUid] = useState<number | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [activeView, setActiveView] = useState<'list' | 'found'>('list');
  const [friendsRefreshKey, setFriendsRefreshKey] = useState(0);
  const [homeTab, setHomeTab] = useState<'messages' | 'contacts'>('messages');
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourVisible, setTourVisible] = useState(false);
  const [tourSeenLoaded, setTourSeenLoaded] = useState(false);
  const [tourSeen, setTourSeen] = useState(false);

  const tourSteps = useMemo<HomeTourStep[]>(() => {
    const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
    const navHeight = 55 + navPad * 2;
    const narrowCardWidth = Math.min(334, Math.max(250, Math.floor(screenWidth * 0.74)));
    const mediumCardWidth = Math.min(360, Math.max(280, Math.floor(screenWidth * 0.8)));
    const contentTop = insets.top + 88;
    const contentBottom = navHeight + 8;
    const listHeight = Math.max(120, screenHeight - contentTop - contentBottom);
    return [
      {
        id: 'profile',
        title: '\u4e2a\u4eba\u4e2d\u5fc3',
        description:
          '\u70b9\u51fb\u5934\u50cf\u53ef\u8fdb\u5165\u4e2a\u4eba\u4e3b\u9875\uff0c\u4fee\u6539\u5934\u50cf\u3001\u6635\u79f0\u548c\u4e2a\u4eba\u8d44\u6599\u3002',
        spotlightStyle: {
          top: insets.top + 2,
          left: 10,
          width: 220,
          height: 44,
          borderRadius: 22,
        },
        cardStyle: {
          top: insets.top + 64,
          left: 14,
          width: narrowCardWidth,
          minHeight: 126,
        },
      },
      {
        id: 'quick-menu',
        title: '\u5feb\u6377\u5165\u53e3',
        description:
          '\u53f3\u4e0a\u89d2 + \u53ef\u5feb\u901f\u6253\u5f00\u83dc\u5355\uff0c\u652f\u6301\u52a0\u597d\u53cb/\u7fa4\u3001\u626b\u4e00\u626b\u7b49\u529f\u80fd\u3002',
        spotlightStyle: {
          top: insets.top + 3,
          right: 8,
          width: 40,
          height: 40,
          borderRadius: 20,
        },
        cardStyle: {
          top: insets.top + 64,
          right: 14,
          width: narrowCardWidth,
          minHeight: 126,
        },
      },
      {
        id: 'list',
        title: '\u4f1a\u8bdd\u5217\u8868',
        description:
          '\u8fd9\u91cc\u662f\u6700\u65b0\u6d88\u606f\uff0c\u70b9\u51fb\u8fdb\u5165\u804a\u5929\uff0c\u957f\u6309\u4f1a\u8bdd\u53ef\u7f6e\u9876\u6216\u5220\u9664\u3002',
        spotlightStyle: {
          top: insets.top + 88,
          left: 8,
          right: 8,
          bottom: navHeight + 6,
          borderRadius: 14,
        },
        cardStyle: {
          top: contentTop + Math.max(8, Math.floor(listHeight * 0.46)),
          right: 14,
          width: mediumCardWidth,
          minHeight: 134,
        },
      },
      {
        id: 'tabs',
        title: '\u5e95\u90e8\u5bfc\u822a',
        description:
          '\u5e95\u90e8\u53ef\u5207\u6362\u6d88\u606f\u4e0e\u8054\u7cfb\u4eba\uff0c\u7528\u6765\u5feb\u901f\u5728\u4f1a\u8bdd\u89c6\u56fe\u548c\u597d\u53cb\u89c6\u56fe\u4e4b\u95f4\u5207\u6362\u3002',
        spotlightStyle: {
          left: 0,
          right: 0,
          bottom: 0,
          height: navHeight + 2,
          borderRadius: 0,
        },
        cardStyle: {
          bottom: navHeight + 14,
          left: 14,
          right: 14,
          minHeight: 130,
        },
      },
    ];
  }, [insets.top, navPad]);

  const navigation = useNavigation<RootNavigation>();
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
  const connectWsRef = useRef<() => void>(() => {});

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
      tokenRef.current = (await storage.getString(STORAGE_KEYS.token)) || '';
      setTokenReady(true);
    };
    loadToken().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      if (!tokenReady || !tokenRef.current) return;
      try {
        const response = await fetch(API_BASE + '/api/profile', {
          headers: { Authorization: `Bearer ${tokenRef.current}` },
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success && data?.user) {
          setProfileData((prev) => ({ ...prev, ...data.user }));
          await storage.setJson(STORAGE_KEYS.profile, {
            uid: data.user.uid,
            username: data.user.username,
            nickname: data.user.nickname,
            avatar: data.user.avatar,
            signature: data.user.signature,
            gender: data.user.gender,
            birthday: data.user.birthday,
            country: data.user.country,
            province: data.user.province,
            region: data.user.region,
          });
        }
      } catch (error) {
        console.warn('Profile request failed', error);
      }
    };
    loadProfile().catch(() => undefined);
  }, [tokenReady]);

  useEffect(() => {
    const loadReadAt = async () => {
      const stored = await storage.getJson<ReadAtMap>(STORAGE_KEYS.readAt);
      if (stored) {
        setReadAtMap(stored);
      }
    };
    loadReadAt().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadPinned = async () => {
      const stored = await storage.getJson<PinnedMap>(STORAGE_KEYS.pinned);
      if (stored) {
        setPinnedMap(stored);
      }
    };
    const loadHidden = async () => {
      const stored = await storage.getJson<HiddenMap>(STORAGE_KEYS.hiddenChats);
      if (stored) {
        setHiddenMap(stored);
      }
    };
    loadPinned().catch(() => undefined);
    loadHidden().catch(() => undefined);
  }, []);

  useEffect(() => {
    const loadHomeTourState = async () => {
      const seen = await storage.getString(STORAGE_KEYS.homeTourSeen);
      setTourSeen(seen === '1');
      setTourSeenLoaded(true);
    };
    loadHomeTourState();
  }, []);

  const displayName = useMemo(
    () => profileData.nickname || profileData.username || '鍔犺浇涓?..',
    [profileData.nickname, profileData.username]
  );
  const avatarUrl = useMemo(
    () => normalizeImageUrl(profileData.avatar),
    [profileData.avatar]
  );
  const avatarVersion = useMemo(() => {
    const clean = avatarUrl.split('?')[0].replace(/\/+$/, '');
    const name = clean.split('/').pop();
    return name || String(profileData.avatar || '1');
  }, [avatarUrl, profileData.avatar]);
  const avatarSrc = useMemo(() => {
    if (!avatarUrl) return '';
    if (avatarUrl.startsWith('data:')) return avatarUrl;
    const joiner = avatarUrl.includes('?') ? '&' : '?';
    return encodeURI(`${avatarUrl}${joiner}v=${encodeURIComponent(avatarVersion)}`);
  }, [avatarUrl, avatarVersion]);
  const avatarText = useMemo(() => displayName.slice(0, 2), [displayName]);
  const canShowMainHome = !activeChatUid && activeView !== 'found';
  const currentTourStep = tourSteps[tourStepIndex] || null;

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (!avatarSrc || avatarSrc.startsWith('data:')) return;
    Image.getSize(
      avatarSrc,
      () => setAvatarFailed(false),
      () => setAvatarFailed(true)
    );
  }, [avatarSrc]);

  useEffect(() => {
    if (!tourSeenLoaded || tourSeen || tourVisible) return;
    if (!canShowMainHome) return;
    setTourStepIndex(0);
    setTourVisible(true);
  }, [canShowMainHome, tourSeen, tourSeenLoaded, tourVisible]);

  useEffect(() => {
    if (!tourVisible) return;
    setQuickMenuVisible(false);
    setChatMenuVisible(false);
  }, [tourVisible]);

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
    if (msg.type === 'image') return '[鍥剧墖]';
    if (msg.type === 'file') return '[鏂囦欢]';
    if (msg.type === 'voice') return '[璇煶]';
    return '[娑堟伅]';
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
    await storage.setJson(STORAGE_KEYS.readAt, nextMap);
  }, []);

  const persistPinnedMap = useCallback(async (nextMap: PinnedMap) => {
    await storage.setJson(STORAGE_KEYS.pinned, nextMap);
  }, []);

  const persistHiddenMap = useCallback(async (nextMap: HiddenMap) => {
    await storage.setJson(STORAGE_KEYS.hiddenChats, nextMap);
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
        persistReadAtMap(next).catch(() => undefined);
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
          text: messageText || '鏆傛棤娑堟伅',
          time: formatTime(entry?.createdAt || entry?.raw?.createdAt, entry?.createdAtMs),
          ts: Number.isFinite(entry?.createdAtMs)
            ? entry.createdAtMs
            : Number.isFinite(Date.parse(entry?.createdAt))
              ? Date.parse(entry?.createdAt)
              : Date.now(),
        },
      }));
    },
    [formatMessage, formatTime]
  );

  const unhideChat = useCallback(
    (uid: number) => {
      if (!hiddenMap[uid]) return;
      setHiddenMap((prev) => {
        const next = { ...prev };
        delete next[uid];
        persistHiddenMap(next).catch(() => undefined);
        return next;
      });
    },
    [hiddenMap, persistHiddenMap]
  );

  const insertMessages = useCallback(
    (uid: number, list: any[], { prepend }: { prepend?: boolean } = {}) => {
      if (!uid) return;
      ensureMessageBucket(uid);
      unhideChat(uid);
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
    [ensureMessageBucket, normalizeMessage, recalcUnread, selfUid, unhideChat, updateLatest]
  );

  const loadOverview = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const response = await fetch(`${API_BASE}/api/chat/overview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ readAt: readAtMapRef.current }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !Array.isArray(data?.data)) {
        return;
      }
      const latestPatch: LatestMap = {};
      const unreadPatch: Record<number, number> = {};
      data.data.forEach((entry: any) => {
        const uid = Number(entry?.uid);
        if (!Number.isInteger(uid)) return;
        unreadPatch[uid] = Number.isFinite(Number(entry?.unread))
          ? Math.min(Math.max(Number(entry.unread), 0), 99)
          : 0;
        if (entry?.latest) {
          const normalized = normalizeMessage(entry.latest);
          latestPatch[uid] = {
            text: normalized.content || formatMessage(normalized.raw || normalized) || '鏆傛棤娑堟伅',
            time: formatTime(normalized.createdAt, normalized.createdAtMs),
            ts: normalized.createdAtMs,
          };
        }
      });
      setUnreadMap((prev) => ({ ...prev, ...unreadPatch }));
      if (Object.keys(latestPatch).length > 0) {
        setLatestMap((prev) => ({ ...prev, ...latestPatch }));
      }
    } catch {}
  }, [authHeaders, formatMessage, formatTime, normalizeMessage]);

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
        data.friends.forEach((friend: Friend) => {
          ensureMessageBucket(friend.uid);
        });
        await loadOverview();
      }
    } catch {}
    setLoadingFriends(false);
  }, [authHeaders, ensureMessageBucket, loadOverview]);

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
      setQuickMenuVisible(false);
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
    setQuickMenuVisible(false);
    setActiveView('found');
  }, []);

  const closeFoundFriends = useCallback(() => {
    setActiveView('list');
  }, []);

  const closeQuickMenu = useCallback(() => {
    setQuickMenuVisible(false);
  }, []);

  const markTourSeen = useCallback(() => {
    storage.setString(STORAGE_KEYS.homeTourSeen, '1');
    setTourSeen(true);
  }, []);

  const closeTour = useCallback(
    (markSeen = true) => {
      setTourVisible(false);
      setTourStepIndex(0);
      setQuickMenuVisible(false);
      if (markSeen) {
        markTourSeen();
      }
    },
    [markTourSeen]
  );

  const nextTourStep = useCallback(() => {
    if (tourStepIndex >= tourSteps.length - 1) {
      closeTour(true);
      return;
    }
    setTourStepIndex((prev) => prev + 1);
  }, [closeTour, tourStepIndex, tourSteps.length]);

  const toggleQuickMenu = useCallback(() => {
    if (tourVisible || activeChatUid || activeView === 'found') return;
    setQuickMenuVisible((prev) => !prev);
  }, [activeChatUid, activeView, tourVisible]);

  const onQuickCreateGroup = useCallback(() => {
    closeQuickMenu();
  }, [closeQuickMenu]);

  const onQuickAdd = useCallback(() => {
    closeQuickMenu();
    openFoundFriends();
  }, [closeQuickMenu, openFoundFriends]);

  const onQuickScan = useCallback(() => {
    closeQuickMenu();
    navigation.navigate('QRScan');
  }, [closeQuickMenu, navigation]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tourVisible) {
        closeTour(true);
        return true;
      }
      if (!quickMenuVisible) return false;
      setQuickMenuVisible(false);
      return true;
    });
    return () => sub.remove();
  }, [closeTour, quickMenuVisible, tourVisible]);

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
    loadFriends().catch(() => undefined);
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
      connectWsRef.current();
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

  useEffect(() => {
    connectWsRef.current = connectWs;
  }, [connectWs]);

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
    loadProfile().catch(() => undefined);
    loadFriends().catch(() => undefined);
    connectWs();
    return () => {
      teardownWs();
    };
  }, [connectWs, loadFriends, loadProfile, teardownWs]);

  const messageItems = useMemo(() => {
    const filtered = friends.filter((friend) => !hiddenMap[friend.uid]);
    return filtered
      .map((friend) => {
        const latest = latestMap[friend.uid];
        return {
          friend,
          latest,
          pinned: Boolean(pinnedMap[friend.uid]),
          unread: unreadMap[friend.uid] || 0,
        };
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ta = a.latest?.ts || 0;
        const tb = b.latest?.ts || 0;
        return tb - ta;
      });
  }, [friends, hiddenMap, latestMap, pinnedMap, unreadMap]);

  const closeChatMenu = useCallback(() => {
    setChatMenuVisible(false);
    setChatMenuTargetUid(null);
  }, []);

  const openChatMenu = useCallback((event: any, uid: number) => {
    const { width, height } = Dimensions.get('window');
    const menuWidth = 160;
    const menuHeight = 96;
    const x = Math.min(event.nativeEvent.pageX, width - menuWidth - 10);
    const y = Math.min(event.nativeEvent.pageY, height - menuHeight - 10);
    setChatMenuPosition({ x, y });
    setChatMenuTargetUid(uid);
    setChatMenuVisible(true);
  }, []);

  const toggleChatPin = useCallback(() => {
    if (!chatMenuTargetUid) return;
    setPinnedMap((prev) => {
      const next = { ...prev, [chatMenuTargetUid]: !prev[chatMenuTargetUid] };
      if (!next[chatMenuTargetUid]) {
        delete next[chatMenuTargetUid];
      }
      persistPinnedMap(next).catch(() => undefined);
      return next;
    });
    closeChatMenu();
  }, [chatMenuTargetUid, closeChatMenu, persistPinnedMap]);

  const deleteChat = useCallback(async () => {
    if (!chatMenuTargetUid) return;
    const uid = chatMenuTargetUid;
    closeChatMenu();

    const deleteBatch = async (beforeId?: number | string) => {
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
      if (!response.ok || !data?.success || !Array.isArray(data?.data)) {
        return { done: true, lastId: null as null | number | string };
      }
      const list = data.data;
      for (const item of list) {
        if (!item?.id) continue;
        await fetch(`${API_BASE}/api/chat/del`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ id: item.id }),
        }).catch(() => undefined);
      }
      if (list.length < PAGE_LIMIT) {
        return { done: true, lastId: null as null | number | string };
      }
      return { done: false, lastId: list[0]?.id || null };
    };

    let beforeId: number | string | null = null;
    for (;;) {
      const result = await deleteBatch(beforeId || undefined);
      if (result.done || !result.lastId) break;
      beforeId = result.lastId;
    }

    setHiddenMap((prev) => {
      const next = { ...prev, [uid]: true };
      persistHiddenMap(next).catch(() => undefined);
      return next;
    });
    setMessagesByUid((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setLatestMap((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setUnreadMap((prev) => ({ ...prev, [uid]: 0 }));
  }, [authHeaders, chatMenuTargetUid, closeChatMenu, persistHiddenMap]);

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
              <BackIcon />
            </Pressable>
            <View>
              <Text style={styles.chatName}>
                {activeChatFriend?.nickname || activeChatFriend?.username || '鑱婂ぉ'}
              </Text>
              <Text style={[styles.chatStatus, activeChatFriend?.online && styles.chatOnline]}>
                {activeChatFriend?.online ? '鍦ㄧ嚎' : '绂荤嚎'}
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
              <Text style={styles.empty}>姝ｅ湪鍔犺浇娑堟伅...</Text>
            ) : null}
            {!historyLoading[activeChatUid] && activeChatMessages.length === 0 ? (
              <Text style={styles.empty}>还没有消息，先聊几句吧。</Text>
            ) : null}
            {historyHasMore[activeChatUid] ? (
              <Text style={styles.loadMore}>
                {historyLoading[activeChatUid] ? '鍔犺浇鏇村...' : '涓婃媺鍔犺浇鏇村'}
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
                          {item.createdAtMs <= getReadAt(activeChatUid) ? '宸茶' : '鏈'}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <Pressable onPress={() => deleteMessage(activeChatUid, item)}>
                    <Text style={[styles.deleteBtn, isSelf && styles.selfDelete]}>鍒犻櫎</Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>

          <View style={[styles.chatInput, { paddingBottom: 12 + insets.bottom }]}>
            <TextInput
              value={draftMessage}
              placeholder="杈撳叆娑堟伅..."
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
              <Pressable
                style={styles.avatarContainer}
                onPress={() => navigation.navigate('Profile')}
              >
                {avatarSrc && !avatarFailed ? (
                  <Image
                    key={avatarSrc}
                    source={{
                      uri: avatarSrc,
                      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
                    }}
                    style={styles.avatarImg}
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  <Text style={styles.avatarFallback}>{avatarText}</Text>
                )}
              </Pressable>
              <Text style={styles.username}>{displayName}</Text>
            </View>
            <Pressable style={styles.headerRight} onPress={toggleQuickMenu}>
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
              <Text style={styles.searchText}>鎼滅储</Text>
            </View>
          </View>

          {homeTab === 'messages' ? (
            <ScrollView style={styles.msgList} contentContainerStyle={styles.msgListInner}>
              {loadingFriends ? <Text style={styles.empty}>姝ｅ湪鍔犺浇娑堟伅...</Text> : null}
              {!loadingFriends && messageItems.length === 0 ? (
                <Text style={styles.empty}>鏆傛棤娑堟伅</Text>
              ) : null}
              {!loadingFriends &&
                messageItems.map(({ friend, latest, pinned, unread }) => (
                  <Pressable
                    key={friend.uid}
                    style={[styles.msgItem, pinned && styles.msgItemPinned]}
                    onPress={() => openChat(friend)}
                    onLongPress={(event) => openChatMenu(event, friend.uid)}
                  >
                    <View style={styles.avatarBox}>
                      {normalizeImageUrl(friend.avatar) ? (
                        <Image source={{ uri: normalizeImageUrl(friend.avatar) }} style={styles.msgAvatar} />
                      ) : (
                        <View style={styles.msgAvatarFallback}>
                          <Text style={styles.msgAvatarText}>
                            {getAvatarText(friend.nickname || friend.username)}
                          </Text>
                        </View>
                      )}
                      {unread > 0 ? (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>
                            {unread > 99 ? '99+' : unread}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.msgContentWrapper}>
                      <View style={styles.msgTopRow}>
                        <Text style={styles.msgNickname} numberOfLines={1}>
                          {friend.nickname || friend.username || '联系人'}
                        </Text>
                        <Text style={styles.msgTime}>{latest?.time || ''}</Text>
                      </View>
                      <Text style={styles.msgPreview} numberOfLines={1}>
                        {latest?.text || '鏆傛棤娑堟伅'}
                      </Text>
                    </View>
                  </Pressable>
                ))}
            </ScrollView>
          ) : (
            <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
              {loadingFriends ? <Text style={styles.empty}>姝ｅ湪鍔犺浇鑱旂郴浜?..</Text> : null}
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
                          {latestMap[friend.uid]?.text || '鏆傛棤娑堟伅'}
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
          )}

          <View
            style={[
              styles.bottomNav,
              { paddingTop: navPad, paddingBottom: navPad },
            ]}
          >
            <Pressable
              style={[
                styles.navItem,
                homeTab === 'messages' && styles.navItemActive,
              ]}
              onPress={() => setHomeTab('messages')}
            >
              <Svg viewBox="0 0 24 24" width={28} height={28} fill={homeTab === 'messages' ? '#0099ff' : '#7d7d7d'}>
                <Path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </Svg>
              <Text style={[styles.navText, homeTab === 'messages' && styles.navTextActive]}>娑堟伅</Text>
            </Pressable>
            <Pressable
              style={[
                styles.navItem,
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

      {tourVisible && canShowMainHome && currentTourStep ? (
        <View style={styles.tourOverlay}>
          <View style={styles.tourMask} />
          <View style={[styles.tourSpotlight, currentTourStep.spotlightStyle]} />
          <View style={[styles.tourCard, currentTourStep.cardStyle]}>
            <Text style={styles.tourTitle}>{currentTourStep.title}</Text>
            <Text style={styles.tourDescription}>{currentTourStep.description}</Text>
            <View style={styles.tourProgress}>
              {tourSteps.map((step, idx) => (
                <View
                  key={step.id}
                  style={[styles.tourDot, idx === tourStepIndex && styles.tourDotActive]}
                />
              ))}
            </View>
            <View style={styles.tourActions}>
              <Pressable
                style={[styles.tourBtn, styles.tourSkipBtn]}
                onPress={() => closeTour(true)}
              >
                <Text style={styles.tourSkipText}>{'\u8df3\u8fc7'}</Text>
              </Pressable>
              <Pressable style={[styles.tourBtn, styles.tourNextBtn]} onPress={nextTourStep}>
                <Text style={styles.tourNextText}>
                  {tourStepIndex >= tourSteps.length - 1 ? '\u5b8c\u6210' : '\u4e0b\u4e00\u6b65'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {quickMenuVisible && !activeChatUid && activeView !== 'found' ? (
        <View style={styles.quickMenuOverlay}>
          <Pressable style={styles.quickMenuBackdrop} onPress={closeQuickMenu} />
          <View style={[styles.quickMenuPanel, styles.quickMenuPanelPosition]}>
            <Pressable style={styles.quickMenuItem} onPress={onQuickCreateGroup}>
              <View style={styles.quickMenuIcon}>
                <QuickGroupIcon />
              </View>
              <Text style={styles.quickMenuText}>鍒涘缓缇よ亰</Text>
            </Pressable>
            <View style={styles.quickMenuDivider} />
            <Pressable style={styles.quickMenuItem} onPress={onQuickAdd}>
              <View style={styles.quickMenuIcon}>
                <QuickAddIcon />
              </View>
              <Text style={styles.quickMenuText}>加好友/群</Text>
            </Pressable>
            <View style={styles.quickMenuDivider} />
            <Pressable style={styles.quickMenuItem} onPress={onQuickScan}>
              <View style={styles.quickMenuIcon}>
                <QuickScanIcon />
              </View>
              <Text style={styles.quickMenuText}>扫一扫</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {chatMenuVisible && chatMenuTargetUid ? (
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={closeChatMenu} />
          <View style={[styles.menuPanel, { left: chatMenuPosition.x, top: chatMenuPosition.y }]}>
            <Pressable style={styles.menuItem} onPress={toggleChatPin}>
              <Text style={styles.menuText}>
                {pinnedMap[chatMenuTargetUid] ? '取消置顶' : '置顶该聊天'}
              </Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuItem} onPress={deleteChat}>
              <Text style={[styles.menuText, styles.menuDanger]}>鍒犻櫎鑱婂ぉ</Text>
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
    flexGrow: 1,
    minHeight: '100%',
    backgroundColor: '#f5f6fa',
  },
  home: {
    flex: 1,
    minHeight: 0,
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
    ...surfaceShadowStyle,
  },
  searchText: {
    fontSize: 15,
    color: '#8a8a8a',
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  contentInner: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  msgList: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#f5f6fa',
  },
  msgListInner: {
    paddingBottom: 20,
  },
  msgItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 15,
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.03)',
  },
  msgItemPinned: {
    backgroundColor: '#e6e6e6',
  },
  avatarBox: {
    position: 'relative',
    marginRight: 12,
  },
  msgAvatar: {
    width: 48,
    height: 48,
    borderRadius: 8,
    resizeMode: 'cover',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
  },
  msgAvatarFallback: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
  },
  msgAvatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4a9df8',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#ff4d4f',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  msgContentWrapper: {
    flex: 1,
    overflow: 'hidden',
    gap: 4,
  },
  msgTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  msgNickname: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '500',
    flexShrink: 1,
    paddingRight: 8,
  },
  msgTime: {
    fontSize: 12,
    color: '#b2b2b2',
  },
  msgPreview: {
    fontSize: 14,
    color: '#999',
  },
  bottomNav: {
    minHeight: 55,
    marginTop: 'auto',
    flexShrink: 0,
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
  tourOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 160,
  },
  tourMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 10, 18, 0.68)',
  },
  tourSpotlight: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#35a4ff',
    backgroundColor: 'rgba(53, 164, 255, 0.12)',
  },
  tourCard: {
    position: 'absolute',
    backgroundColor: '#f8fbff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(82, 137, 204, 0.24)',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    ...tourCardShadowStyle,
  },
  tourTitle: {
    color: '#1f2f46',
    fontSize: 16,
    fontWeight: '600',
  },
  tourDescription: {
    marginTop: 6,
    color: '#4c5f78',
    fontSize: 13,
    lineHeight: 18,
  },
  tourProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  tourDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(103, 156, 219, 0.35)',
  },
  tourDotActive: {
    width: 18,
    borderRadius: 6,
    backgroundColor: '#5fb3ff',
  },
  tourActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  tourBtn: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tourSkipBtn: {
    backgroundColor: '#eaf2fb',
    borderWidth: 1,
    borderColor: '#d4e4f7',
  },
  tourNextBtn: {
    backgroundColor: '#dff0ff',
    borderWidth: 1,
    borderColor: '#b8dbff',
  },
  tourSkipText: {
    color: '#516177',
    fontSize: 13,
    fontWeight: '600',
  },
  tourNextText: {
    color: '#1f66aa',
    fontSize: 13,
    fontWeight: '600',
  },
  quickMenuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 130,
  },
  quickMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  quickMenuPanel: {
    position: 'absolute',
    width: 188,
    backgroundColor: '#2f333a',
    borderRadius: 14,
    overflow: 'hidden',
    ...quickMenuShadowStyle,
  },
  quickMenuPanelPosition: {
    top: 44,
    right: 12,
  },
  quickMenuItem: {
    height: 52,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  quickMenuIcon: {
    width: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickMenuText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '500',
  },
  quickMenuDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 14,
  },
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menuPanel: {
    position: 'absolute',
    width: 160,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 12,
    overflow: 'hidden',
    ...menuShadowStyle,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  menuText: {
    fontSize: 14,
    color: '#333',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#e5e5e5',
  },
  menuDanger: {
    color: '#ff4d4f',
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

function BackIcon() {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18L9 12L15 6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function QuickGroupIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h8A2.5 2.5 0 0 1 17 7.5V12a2.5 2.5 0 0 1-2.5 2.5h-4l-3 3v-3A2.5 2.5 0 0 1 5 12V7.5Z"
        stroke="#fff"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Path d="M19 7v4M17 9h4" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function QuickAddIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8.5 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2.5 19a6 6 0 0 1 12 0"
        stroke="#fff"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path d="M18 11v6M15 14h6" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function QuickScanIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M7 4H4v3M17 4h3v3M4 17v3h3M20 17v3h-3" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
      <Path d="M7 12h10" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}







